package main

// The chat engine: one turn is one headless Claude Code run (`claude -p`)
// in the project folder, its requests sent through the Magpie gateway. The
// page holds a WebSocket per turn: it sends the request, gets the run's
// events translated, and closing the socket stops the run. The session id
// Claude Code gives is the chat's memory: the next turn resumes it, with
// whatever model the user picked in between.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

type chatReq struct {
	uuid    string   // a message typed mid-reply: Claude Code says when it takes it in
	Prompt  string   `json:"prompt"`
	Model   string   `json:"model"`   // provider/model, as Magpie lists it
	Effort  string   `json:"effort"`  // low|medium|high|xhigh|max, or ""
	Session string   `json:"session"` // Claude Code session id to resume
	Chat    string   `json:"chat"`    // the page's chat id: its process is kept
	At      string   `json:"at"`      // resume only up to this reply (message id): edit, retry, branch
	Cwd     string   `json:"cwd"`
	Account string   `json:"account"` // a Claude account to prefer (email)
	Auto    *bool    `json:"auto"`    // move on from an account with no room (default on)
	Via     bool     `json:"via"`     // Claude through Magpie's gateway (its interactive bridge: about half the plan cost)
	Mode    string   `json:"mode"`    // edits | full | plan
	Agent   string   `json:"agent"`   // another agent (acp.go) instead of Claude Code: opencode, gemini…
	Warm    bool     `json:"warm"`    // only start the chat's process (its hooks, its servers) for the message being typed
	Allow   []string `json:"allow"`   // "always allow" answers this chat gave
	askURL  string   // Foxpit's approval tool for this run
	Images  []struct {
		Media string `json:"media"` // image/png …
		Data  string `json:"data"`  // base64
	} `json:"images"`
}

// chatEvent is what the page gets, one JSON text frame each.
type chatEvent struct {
	T       string          `json:"t"` // session|delta|text|tool|tool_result|done|error
	ID      string          `json:"id,omitempty"`
	Text    string          `json:"text,omitempty"`
	Name    string          `json:"name,omitempty"`
	Input   json.RawMessage `json:"input,omitempty"`
	OK      *bool           `json:"ok,omitempty"`
	Images  []string        `json:"images,omitempty"` // data: URLs a tool gave back
	Session string          `json:"session,omitempty"`
	Cost    float64         `json:"cost,omitempty"`
	Ms      int64           `json:"ms,omitempty"`
	Denied  []denial        `json:"denied,omitempty"`
	// the slash commands and skills this Claude Code session knows (init)
	Commands []string `json:"commands,omitempty"`
	// how full the context is after the run, and how big it is
	Used   int `json:"used,omitempty"`
	Window int `json:"window,omitempty"`
	// the sub-task (Task tool call) a step belongs to
	Parent string `json:"parent,omitempty"`
	// a finished sub-agent's numbers: how long, how many tokens and steps
	Agent *agentMeta `json:"agent,omitempty"`
	// the run's last reply (message id): where a later edit or retry cuts
	Msg string `json:"msg,omitempty"`
}

// agentMeta is what Claude Code says of a sub-agent when it hands back
// (tool_use_result on the Task/Agent result).
type agentMeta struct {
	Status string `json:"status,omitempty"`
	Type   string `json:"agentType,omitempty"`
	Model  string `json:"resolvedModel,omitempty"`
	Ms     int64  `json:"totalDurationMs,omitempty"`
	Tokens int    `json:"totalTokens,omitempty"`
	Tools  int    `json:"totalToolUseCount,omitempty"`
}

// denial is a tool call the permission mode refused.
type denial struct {
	Tool  string          `json:"tool"`
	Input json.RawMessage `json:"input,omitempty"`
}

var efforts = map[string]bool{"low": true, "medium": true, "high": true, "xhigh": true, "max": true}

// claudeCommand finds Claude Code's own executable: the npm shim is a .cmd,
// and a .cmd would hand the arguments to cmd.exe to reparse.
func claudeCommand() (string, []string, error) {
	// a stand-in agent for checks that must not call a real model
	if fake := strings.Fields(os.Getenv("FOXPIT_AGENT_CMD")); len(fake) > 0 {
		return fake[0], fake[1:], nil
	}
	if p := os.Getenv("FOXPIT_CLAUDE"); p != "" {
		return p, nil, nil
	}
	p, err := exec.LookPath("claude")
	if err != nil {
		return "", nil, err
	}
	if runtime.GOOS == "windows" && strings.EqualFold(filepath.Ext(p), ".cmd") {
		exe := filepath.Join(filepath.Dir(p), "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe")
		if _, err := os.Stat(exe); err == nil {
			return exe, nil, nil
		}
	}
	return p, nil, nil
}

// route is how one turn runs: a Claude model on a Magpie Claude account's
// own config directory (one Claude Code, signed in), or anything else
// through the Magpie gateway.
type route struct {
	gateway   bool
	configDir string // CLAUDE_CONFIG_DIR, "" for Claude Code's own
	account   string
}

func isClaude(model string) bool { return model == "" || strings.HasPrefix(model, "claude/") }

// chatEnv is the parent's environment for this one process; the user's own
// settings stay as they are.
func chatEnv(model string, rt route) []string {
	drop := map[string]bool{"ANTHROPIC_API_KEY": true}
	// an approval waits for the person: don't let the tool call time out
	set := map[string]string{"FOXPIT": "1", "MCP_TOOL_TIMEOUT": "1800000"}
	if rt.gateway {
		set["ANTHROPIC_BASE_URL"] = magpieAddr
		set["ANTHROPIC_AUTH_TOKEN"] = "magpie"
		// after each reply Claude Code makes one more model call (a turn
		// summary) before it says the turn is over; through the gateway that
		// held the reply open 3-5 s. Without it the claude.ai-only tools go
		// too, and PowerShell, which is asked back.
		set["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
		if runtime.GOOS == "windows" {
			set["CLAUDE_CODE_USE_POWERSHELL_TOOL"] = "1"
		}
		if model != "" {
			for _, k := range []string{"ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL",
				"ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL"} {
				set[k] = model
			}
		}
	} else {
		for _, k := range []string{"ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL"} {
			drop[k] = true
		}
	}
	if rt.configDir != "" {
		set["CLAUDE_CONFIG_DIR"] = rt.configDir
	}
	// Claude Code otherwise starts sub-agents (and long commands) in the
	// background: the turn ends at once and their results come later as a
	// notification Foxpit's run never sees. With this they still run side by
	// side, and the turn waits for them, so the cards fill and the reply uses them.
	set["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS"] = "1"
	// the next-message guess (--prompt-suggestions) stays on near a plan's
	// limit too, where Claude Code would otherwise leave it out
	set["CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION"] = "true"
	var env []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if _, over := set[strings.ToUpper(k)]; over || drop[strings.ToUpper(k)] {
			continue
		}
		env = append(env, kv)
	}
	for k, v := range set {
		env = append(env, k+"="+v)
	}
	return env
}

func chatArgs(q chatReq, rt route) []string {
	mode := map[string]string{"edits": "acceptEdits", "full": "bypassPermissions", "plan": "plan"}[q.Mode]
	if mode == "" {
		mode = "acceptEdits"
	}
	a := []string{"-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
		"--permission-mode", mode}
	if !rt.gateway {
		// newer Claude models leave thinking out unless asked for a summary
		a = append(a, "--thinking-display", "summarized")
	}
	if q.Model != "" && !rt.gateway {
		a = append(a, "--model", strings.TrimPrefix(q.Model, "claude/"))
	} else if q.Model != "" {
		a = append(a, "--model", q.Model)
		// settings files beat the process env: say it once more there
		s, _ := json.Marshal(map[string]any{"env": map[string]string{
			"ANTHROPIC_BASE_URL": magpieAddr, "ANTHROPIC_AUTH_TOKEN": "magpie", "ANTHROPIC_MODEL": q.Model,
		}})
		a = append(a, "--settings", string(s))
	}
	// messages come as stream-json, one turn after another on one process
	a = append(a, "--input-format", "stream-json")
	// after each turn, a guess at the next message (shown greyed in the box)
	a = append(a, "--prompt-suggestions")
	if efforts[q.Effort] {
		a = append(a, "--effort", q.Effort)
	}
	// full access still asks what only the person can answer (questions)
	if q.askURL != "" {
		// what the mode doesn't allow by itself is asked in the chat
		cfg, _ := json.Marshal(map[string]any{"mcpServers": map[string]any{"foxpit": map[string]string{"type": "http", "url": q.askURL}}})
		a = append(a, "--mcp-config", string(cfg), "--permission-prompt-tool", "mcp__foxpit__approve",
			// starting chats and waiting for them is Foxpit's own doing: no card for it
			"--allowedTools", "mcp__foxpit__new_chat,mcp__foxpit__wait_chats")
	}
	if q.Session != "" {
		a = append(a, "--resume", q.Session)
		if q.At != "" {
			// the old line stays as it was; this run continues a copy cut there
			a = append(a, "--resume-session-at", q.At, "--fork-session")
		}
	}
	return a
}

// streamLine is the part of Claude Code's stream-json lines Foxpit reads.
type streamLine struct {
	Type      string          `json:"type"`
	Subtype   string          `json:"subtype"`
	Status    string          `json:"status"`
	SessionID string          `json:"session_id"`
	Parent    string          `json:"parent_tool_use_id"`
	TUR       json.RawMessage `json:"tool_use_result"`
	TURCamel  json.RawMessage `json:"toolUseResult"`
	Slash     []string        `json:"slash_commands"`
	Skills    []string        `json:"skills"`
	Result    string          `json:"result"`
	RateLimit json.RawMessage `json:"rate_limit_info"`
	IsError   bool            `json:"is_error"`
	Cost      float64         `json:"total_cost_usd"`
	Duration  int64           `json:"duration_ms"`
	Denials   []struct {
		Tool  string          `json:"tool_name"`
		Input json.RawMessage `json:"tool_input"`
	} `json:"permission_denials"`
	Event *struct {
		Type    string `json:"type"`
		Message *struct {
			ID string `json:"id"`
		} `json:"message"`
		Delta *struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			Thinking string `json:"thinking"`
			JSON     string `json:"partial_json"`
		} `json:"delta"`
		Block *struct {
			Type string `json:"type"`
			Name string `json:"name"`
		} `json:"content_block"`
	} `json:"event"`
	ModelUsage map[string]struct {
		Window int `json:"contextWindow"`
	} `json:"modelUsage"`
	Message *struct {
		ID    string `json:"id"`
		Usage *struct {
			In      int `json:"input_tokens"`
			Created int `json:"cache_creation_input_tokens"`
			Read    int `json:"cache_read_input_tokens"`
			Out     int `json:"output_tokens"`
		} `json:"usage"`
		Content []struct {
			Type      string          `json:"type"`
			Text      string          `json:"text"`
			Thinking  string          `json:"thinking"`
			ID        string          `json:"id"`
			Name      string          `json:"name"`
			Input     json.RawMessage `json:"input"`
			ToolUseID string          `json:"tool_use_id"`
			Content   json.RawMessage `json:"content"`
			IsError   bool            `json:"is_error"`
		} `json:"content"`
	} `json:"message"`
}

// resultText flattens a tool result's content (a string or text blocks).
func resultText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &blocks) == nil {
		var b strings.Builder
		for _, x := range blocks {
			if x.Type == "text" {
				b.WriteString(x.Text)
			}
		}
		return b.String()
	}
	return ""
}

// resultImages are the images in a tool result (Read of a picture), as
// data: URLs, the big ones left out.
func resultImages(raw json.RawMessage) []string {
	var blocks []struct {
		Type   string `json:"type"`
		Source struct {
			Type      string `json:"type"`
			MediaType string `json:"media_type"`
			Data      string `json:"data"`
		} `json:"source"`
	}
	if json.Unmarshal(raw, &blocks) != nil {
		return nil
	}
	var out []string
	for _, b := range blocks {
		if b.Type == "image" && b.Source.Type == "base64" && strings.HasPrefix(b.Source.MediaType, "image/") && len(b.Source.Data) < 6<<20 {
			out = append(out, "data:"+b.Source.MediaType+";base64,"+b.Source.Data)
		}
	}
	return out
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "\n…"
}

// translate turns one stream-json line into the page's events.
type translator struct {
	account  string          // the Claude account the run is on (its limits are noted)
	streamed map[string]bool // message ids whose text came as deltas
	thought  map[string]bool // message ids whose thinking came as deltas
	current  string
	session  string
	saidText bool   // a reply text was sent this run
	ctxUsed  int    // tokens the last request sent: how full the context is
	lastMsg  string // the last assistant message id
	tool     string // the tool whose input the model is writing now
	toolLen  int    // how much of that input has come
	toolSaid int    // toolLen when the status last said it
}

// writing says what the model is writing while a tool's input streams in:
// a long file can take a minute, and "Waiting for the model" all that time
// reads as stuck.
func writing(tool string, n int) string {
	what := map[string]string{"Write": "Writing a file", "Edit": "Writing an edit", "MultiEdit": "Writing edits",
		"NotebookEdit": "Writing a notebook edit", "Bash": "Writing a command", "PowerShell": "Writing a command",
		"TodoWrite": "Updating the task list", "Task": "Briefing a sub-task", "Agent": "Briefing a sub-task"}[tool]
	if what == "" {
		what = "Preparing " + tool
	}
	if n < 200 {
		return what + "…"
	}
	if n < 1000 {
		return fmt.Sprintf("%s… %d characters", what, n)
	}
	return fmt.Sprintf("%s… %.1fk characters", what, float64(n)/1000)
}

func (tr *translator) line(b []byte) []chatEvent {
	var l streamLine
	if json.Unmarshal(b, &l) != nil {
		return nil
	}
	var out []chatEvent
	switch l.Type {
	case "rate_limit_event":
		noteLimit(tr.account, l.RateLimit)
	case "system":
		switch l.Subtype {
		case "init":
			if l.SessionID != "" {
				tr.session = l.SessionID
			}
			cmds := append(append([]string{}, l.Slash...), l.Skills...)
			out = append(out, chatEvent{T: "session", Session: tr.session, Commands: cmds})
		case "hook_started":
			out = append(out, chatEvent{T: "status", Text: "Running your hooks…"})
		case "status":
			if l.Status == "requesting" {
				out = append(out, chatEvent{T: "status", Text: "Waiting for the model…"})
			}
		}
	case "stream_event":
		e := l.Event
		if e == nil || l.Parent != "" {
			// a sub-task's own words stay inside it
			break
		}
		if e.Type == "message_start" && e.Message != nil {
			tr.current = e.Message.ID
		}
		if e.Type == "content_block_delta" && e.Delta != nil && e.Delta.Type == "text_delta" && e.Delta.Text != "" {
			tr.streamed[tr.current] = true
			tr.saidText = true
			out = append(out, chatEvent{T: "delta", Text: e.Delta.Text})
		}
		if e.Type == "content_block_start" && e.Block != nil && e.Block.Type == "tool_use" && e.Block.Name != "" {
			tr.tool, tr.toolLen, tr.toolSaid = e.Block.Name, 0, 0
			out = append(out, chatEvent{T: "status", Text: writing(tr.tool, 0)})
		}
		if e.Type == "content_block_delta" && e.Delta != nil && e.Delta.Type == "input_json_delta" && tr.tool != "" {
			tr.toolLen += len(e.Delta.JSON)
			if tr.toolLen-tr.toolSaid >= 300 {
				tr.toolSaid = tr.toolLen
				out = append(out, chatEvent{T: "status", Text: writing(tr.tool, tr.toolLen)})
			}
		}
		if e.Type == "content_block_stop" {
			tr.tool = ""
		}
		if e.Type == "content_block_delta" && e.Delta != nil && e.Delta.Type == "thinking_delta" && e.Delta.Thinking != "" {
			tr.thought[tr.current] = true
			out = append(out, chatEvent{T: "think", Text: e.Delta.Thinking})
		}
	case "assistant":
		if l.Message == nil {
			break
		}
		if l.Parent != "" {
			// a sub-task's steps, and what it says between them: shown in its card
			for _, c := range l.Message.Content {
				if c.Type == "tool_use" {
					out = append(out, chatEvent{T: "tool", ID: c.ID, Name: c.Name, Input: c.Input, Parent: l.Parent})
				}
				if c.Type == "text" && strings.TrimSpace(c.Text) != "" {
					out = append(out, chatEvent{T: "sub_text", Text: clip(strings.TrimSpace(c.Text), 600), Parent: l.Parent})
				}
			}
			break
		}
		if l.Message.ID != "" {
			tr.lastMsg = l.Message.ID
		}
		if u := l.Message.Usage; u != nil && u.In+u.Created+u.Read > 0 {
			tr.ctxUsed = u.In + u.Created + u.Read + u.Out
		}
		for _, c := range l.Message.Content {
			switch c.Type {
			case "text":
				if !tr.streamed[l.Message.ID] && c.Text != "" {
					tr.saidText = true
					out = append(out, chatEvent{T: "text", Text: c.Text})
				}
			case "thinking":
				if !tr.thought[l.Message.ID] && strings.TrimSpace(c.Thinking) != "" {
					out = append(out, chatEvent{T: "think", Text: c.Thinking})
				}
			case "tool_use":
				out = append(out, chatEvent{T: "tool", ID: c.ID, Name: c.Name, Input: c.Input})
			}
		}
	case "user":
		if l.Message == nil {
			break
		}
		for _, c := range l.Message.Content {
			if c.Type == "tool_result" {
				ok := !c.IsError
				if l.Parent != "" {
					out = append(out, chatEvent{T: "tool_result", ID: c.ToolUseID, OK: &ok, Text: clip(resultText(c.Content), 600), Parent: l.Parent})
					continue
				}
				ev := chatEvent{T: "tool_result", ID: c.ToolUseID, OK: &ok, Text: clip(resultText(c.Content), 4000), Images: resultImages(c.Content)}
				if m := l.agentMeta(); m != nil {
					ev.Agent = m
					ev.Text = clip(agentReport(resultText(c.Content)), 40000) // a sub-agent's report, read in full
				}
				out = append(out, ev)
			}
		}
	case "result":
		if l.SessionID != "" {
			tr.session = l.SessionID
		}
		ev := chatEvent{T: "done", Session: tr.session, Cost: l.Cost, Ms: l.Duration, Msg: tr.lastMsg, Used: tr.ctxUsed}
		for _, mu := range l.ModelUsage {
			if mu.Window > ev.Window {
				ev.Window = mu.Window
			}
		}
		for _, d := range l.Denials {
			ev.Denied = append(ev.Denied, denial{Tool: d.Tool, Input: d.Input})
		}
		if l.IsError || (l.Subtype != "" && l.Subtype != "success") {
			ev.T = "error"
			ev.Text = cmpOr(l.Result, l.Subtype)
		} else if !tr.saidText && strings.TrimSpace(l.Result) != "" {
			// a slash command's answer (/context, /usage…) comes only here
			ev.Text = l.Result
		}
		out = append(out, ev)
	}
	return out
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func chatHandler(m *Magpie) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		ws.SetReadLimit(48 << 20)
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()

		var mu sync.Mutex
		send := func(e chatEvent) error {
			b, _ := json.Marshal(e)
			mu.Lock()
			defer mu.Unlock()
			wctx, c := context.WithTimeout(ctx, 10*time.Second)
			defer c()
			return ws.Write(wctx, websocket.MessageText, b)
		}
		fail := func(msg string) {
			_ = send(chatEvent{T: "error", Text: msg})
			ws.Close(websocket.StatusNormalClosure, "")
		}

		_, data, err := ws.Read(ctx)
		if err != nil {
			return
		}
		var q chatReq
		if json.Unmarshal(data, &q) != nil || (strings.TrimSpace(q.Prompt) == "" && !q.Warm) {
			fail("Empty message.")
			return
		}
		if q.Agent != "" && q.Agent != "claude" {
			a, ok := acpByID(q.Agent)
			if !ok {
				fail("Foxpit does not know the agent " + q.Agent + ".")
				return
			}
			// Stop (the socket closing), approval answers and messages typed
			// meanwhile come back on the socket
			reader := func(runID string, onSay func(id string)) {
				for {
					_, b, err := ws.Read(ctx)
					if err != nil {
						cancel()
						return
					}
					var msg struct {
						T  string `json:"t"`
						ID string `json:"id"`
						answer
					}
					if json.Unmarshal(b, &msg) != nil {
						continue
					}
					switch msg.T {
					case "say":
						onSay(msg.ID)
					case "answer":
						askers.Lock()
						ak := askers.m[runID]
						askers.Unlock()
						if ak != nil {
							ak.answer(msg.ID, msg.answer)
						}
					}
				}
			}
			acpChat(ctx, cancel, q, a, termDir(q.Cwd), send, reader)
			ws.Close(websocket.StatusNormalClosure, "")
			return
		}
		// another agent's session means nothing to Claude Code: a fresh one
		if strings.HasPrefix(q.Session, "acp:") {
			q.Session, q.At = "", ""
		}
		name, pre, err := claudeCommand()
		if err != nil {
			fail("Claude Code was not found. Install it (npm i -g @anthropic-ai/claude-code) and try again.")
			return
		}
		dir := termDir(q.Cwd)
		auto := q.Auto == nil || *q.Auto
		var accts []string
		rt := route{gateway: !isClaude(q.Model) || q.Via}
		if q.Via && q.Model == "" {
			q.Model = "claude/claude-opus-5-5"
		}
		if !rt.gateway {
			if accts = m.claudeAccounts(q.Account, auto); len(accts) == 0 {
				// no Magpie Claude account signed in here: the gateway's way
				rt.gateway = true
			}
		}

		// the chat's own Claude Code process, and its approval tool
		chatKey := q.Chat
		if chatKey == "" {
			chatKey = "once-" + newRunID()
		}
		if q.Warm && (q.Chat == "" || q.At != "" || workerBusy(chatKey)) {
			// a reply is running (or there is nothing to keep): leave it be
			ws.Close(websocket.StatusNormalClosure, "")
			return
		}
		runID := chatRunID(chatKey)
		if askBase != "" {
			q.askURL = askBase + "/mcp?key=" + askKey + "&run=" + runID
		}

		// what was written to the running process while it answered (the
		// person typed on, as in Claude's own app): Claude Code takes it in at
		// its next step, or runs it as one more turn right after this one
		var liveMu sync.Mutex
		var live *worker
		var said int32
		sayIDs := map[string]string{} // Claude Code's uuid for a typed message → the page's id (liveMu)
		var saidTexts []string        // what went in this way, kept for an account switch
		// the page closing the socket (Stop) ends the run; answers to
		// approval cards and messages typed meanwhile come back on it
		go func() {
			for {
				_, b, err := ws.Read(ctx)
				if err != nil {
					cancel()
					return
				}
				var msg struct {
					T  string `json:"t"`
					ID string `json:"id"`
					answer
				}
				if json.Unmarshal(b, &msg) == nil && msg.T == "say" {
					var sq chatReq
					_ = json.Unmarshal(b, &sq)
					sq.uuid = newUUID()
					liveMu.Lock()
					w := live
					sayIDs[sq.uuid] = msg.ID
					liveMu.Unlock()
					ok := w != nil && w.alive() && strings.TrimSpace(sq.Prompt) != "" && w.send(sq) == nil
					if ok {
						atomic.AddInt32(&said, 1)
						liveMu.Lock()
						saidTexts = append(saidTexts, "- "+clip(sq.Prompt, 4000))
						liveMu.Unlock()
						log.Printf("chat: a message went in while the reply ran (pid %d)", w.cmd.Process.Pid)
						_ = send(chatEvent{T: "said", ID: msg.ID})
					} else {
						_ = send(chatEvent{T: "said", ID: msg.ID, Text: "not taken"})
					}
					continue
				}
				if json.Unmarshal(b, &msg) == nil && msg.T == "answer" {
					askers.Lock()
					ak := askers.m[runID]
					askers.Unlock()
					if ak != nil {
						ak.answer(msg.ID, msg.answer)
					}
				}
			}
		}()

		// one turn on the chat's process; a usage limit hit on an account is
		// held back (not sent) when another account can take over
		run := func(q chatReq, rt route, holdLimit bool) (stopped bool, limit string, session string) {
			target := rt.configDir
			if target == "" {
				target = defaultClaudeDir()
			}
			prep := func() {
				carrySession(q.Session, dir, target)
				shareUserConfig(rt.configDir)
			}
			w, fresh, err := takeWorker(chatKey, name, append(append([]string{}, pre...), chatArgs(q, rt)...), dir, chatEnv(q.Model, rt), q.Session, q.At, runID, prep)
			if err != nil {
				_ = send(chatEvent{T: "error", Text: "Claude Code did not start: " + err.Error()})
				return false, "", q.Session
			}
			if q.Warm {
				// up ahead of the message: the next turn finds it running
				w.mu.Lock()
				w.warm = q.Session == ""
				w.mu.Unlock()
				w.release(q.Session)
				if fresh {
					log.Printf("chat: warmed %s for the next message (pid %d) session=%q", filepath.Base(name), w.cmd.Process.Pid, q.Session)
				}
				_ = send(chatEvent{T: "warm"})
				return false, "", q.Session
			}
			if fresh {
				log.Printf("chat: %s model=%q resume=%q at=%q gateway=%v account=%q in %s (pid %d, new process)", filepath.Base(name), q.Model, q.Session, q.At, rt.gateway, rt.account, dir, w.cmd.Process.Pid)
			} else {
				log.Printf("chat: turn on running process (pid %d) session=%q", w.cmd.Process.Pid, q.Session)
				w.drain()
				// the process is up: no start, no hooks to wait for
				_ = send(chatEvent{T: "session", Session: q.Session})
			}
			w.ak.bind(send, ctx.Done(), q.Allow)
			if rt.account != "" {
				_ = send(chatEvent{T: "account", Text: rt.account})
			}
			if err := w.send(q); err != nil {
				dropWorker(w)
				_ = send(chatEvent{T: "error", Text: "Claude Code stopped taking messages. Send again to start it anew."})
				return false, "", q.Session
			}

			liveMu.Lock()
			live = w
			liveMu.Unlock()
			defer func() { liveMu.Lock(); live = nil; liveMu.Unlock() }()
			tr := &translator{streamed: map[string]bool{}, thought: map[string]bool{}, session: q.Session, account: rt.account}
			finished, ended := false, false
			// a turn's end while a typed message is still owed: wait a moment
			// for the turn Claude Code runs for it before calling the reply done
			var held *chatEvent
			var grace <-chan time.Time
			tookSaid := false // Claude Code reports when it takes a typed message in
		read:
			for !finished {
				select {
				case <-grace:
					grace = nil
					if held != nil {
						_ = send(*held)
						held = nil
					}
					finished = true
				case b, ok := <-w.lines:
					if !ok {
						if held != nil {
							_ = send(*held)
							held = nil
							finished = true
						}
						ended = true
						break read
					}
					// Claude Code took in a message typed mid-reply: it shows there
					if bytes.Contains(b, []byte(`"command_lifecycle"`)) {
						var lc struct {
							Type  string `json:"type"`
							UUID  string `json:"command_uuid"`
							State string `json:"state"`
						}
						if json.Unmarshal(b, &lc) == nil && lc.Type == "command_lifecycle" {
							liveMu.Lock()
							id := sayIDs[lc.UUID]
							liveMu.Unlock()
							if id != "" && lc.State == "started" {
								tookSaid = true
								_ = send(chatEvent{T: "turn", ID: id})
							}
							continue
						}
					}
					evs := tr.line(b)
					if held != nil && len(evs) > 0 {
						held, grace = nil, nil // the next turn started: it ends the reply
						if !tookSaid {
							_ = send(chatEvent{T: "turn"})
						}
					}
					for _, e := range evs {
						if e.T == "done" && atomic.LoadInt32(&said) > 0 {
							atomic.AddInt32(&said, -1)
							ev := e
							held, grace = &ev, time.After(6*time.Second)
							continue
						}
						if e.T == "done" || e.T == "error" {
							finished = true
						}
						if e.T == "error" && holdLimit && isLimit(e.Text) {
							limit = e.Text
							continue
						}
						if send(e) != nil {
							cancel()
						}
					}
				case <-ctx.Done():
					break read
				}
			}
			if ctx.Err() != nil {
				dropWorker(w)
				log.Printf("chat: stopped (pid %d)", w.cmd.Process.Pid)
				return true, "", tr.session
			}
			if ended && !finished {
				<-w.dead
				w.release(tr.session)
				msg := strings.TrimSpace(w.stderr.String())
				if msg == "" && w.werr != nil {
					msg = "Claude Code ended: " + w.werr.Error()
				}
				if msg == "" {
					msg = "Claude Code ended without an answer."
				}
				if holdLimit && isLimit(msg) {
					return false, msg, tr.session
				}
				log.Printf("chat: no result: %s", clip(msg, 500))
				_ = send(chatEvent{T: "error", Text: clip(msg, 2000), Session: tr.session})
				return false, "", tr.session
			}
			w.release(tr.session)
			if limit != "" {
				// this account is out: the next one gets a process of its own
				dropWorker(w)
			}
			return false, limit, tr.session
		}

		if rt.gateway {
			run(q, rt, false)
			ws.Close(websocket.StatusNormalClosure, "")
			return
		}
		// Claude accounts in order; with auto-switch, a limit hands the turn
		// to the next one, which resumes the same session where it stopped
		for i, acct := range accts {
			rt.account, rt.configDir = acct, claudeAccountDir(acct)
			// after the last Claude account here, Magpie's gateway can still
			// reach the accounts that are not signed in here
			last := i+1 == len(accts)
			stopped, limit, session := run(q, rt, auto)
			if stopped || limit == "" {
				break
			}
			next := "Magpie"
			if !last {
				next = accts[i+1]
			}
			log.Printf("chat: limit on %s (%s), moving to %s", acct, clip(limit, 120), next)
			m.forgetAccounts()
			_ = send(chatEvent{T: "switch", Text: next, Name: acct, Session: session})
			if session != "" {
				q.Session = session
				q.At = ""
				q.Prompt = "Your last reply was cut off by a usage limit on another account. Continue exactly where you stopped, without repeating what you already said."
				q.Images = nil
			}
			// what the person typed while that reply ran went to the process
			// that just ended: it goes along to the next one
			liveMu.Lock()
			if len(saidTexts) > 0 {
				q.Prompt += "\n\nWhile you were working, the person also wrote:\n" + strings.Join(saidTexts, "\n")
				saidTexts = nil
				atomic.StoreInt32(&said, 0)
			}
			liveMu.Unlock()
			if last {
				run(q, route{gateway: true}, false)
				break
			}
		}
		ws.Close(websocket.StatusNormalClosure, "")
	})
}

// where the approval tool is served (the stream server)
var askBase, askKey string

var limitRe = regexp.MustCompile(`(?i)(usage limit|limit reached|hit your (usage |weekly )?limit|rate[_ ]limit|\b429\b|out of (extra )?usage|weekly limit|session limit|resets (at )?\d)`)

// isLimit says an error is an account running out of room, not a fault
func isLimit(s string) bool { return limitRe.MatchString(s) }

type limitWriter struct {
	w io.Writer
	n int
}

func (l *limitWriter) Write(p []byte) (int, error) {
	if l.n > 0 {
		k := len(p)
		if k > l.n {
			k = l.n
		}
		_, _ = l.w.Write(p[:k])
		l.n -= k
	}
	return len(p), nil
}

// agentReport: a sub-agent's report without the frame Claude Code puts
// around it for the model (a tools-used note, a "[Subagent hand-back] ...
// The report follows:" preface, every report line indented by two spaces)
func agentReport(s string) string {
	for {
		i := strings.Index(s, "<tools-used-before-summary>")
		j := strings.Index(s, "</tools-used-before-summary>")
		if i < 0 || j < i {
			break
		}
		s = s[:i] + s[j+len("</tools-used-before-summary>"):]
	}
	if i := strings.Index(s, "[Subagent hand-back]"); i >= 0 {
		if j := strings.Index(s[i:], "The report follows:"); j >= 0 {
			body := strings.TrimLeft(s[i+j+len("The report follows:"):], "\r\n")
			lines := strings.Split(body, "\n")
			for k, ln := range lines {
				lines[k] = strings.TrimPrefix(ln, "  ")
			}
			s = strings.TrimSpace(s[:i]) + "\n\n" + strings.Join(lines, "\n")
		}
	}
	// the note for the model on how to reach the agent again
	if i := strings.LastIndex(s, "\nagentId: "); i >= 0 && strings.Contains(s[i:], "SendMessage") {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

// agentMeta:a Task/Agent result's numbers, when the line carries them
func (l *streamLine) agentMeta() *agentMeta {
	raw := l.TUR
	if len(raw) == 0 {
		raw = l.TURCamel
	}
	if len(raw) == 0 || raw[0] != '{' {
		return nil
	}
	var m agentMeta
	if json.Unmarshal(raw, &m) != nil || (m.Ms == 0 && m.Tools == 0 && m.Type == "" && m.Tokens == 0) {
		return nil
	}
	return &m
}
