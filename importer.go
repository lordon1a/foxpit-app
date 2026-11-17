package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Chats from other tools, as Magpie's Sessions shows them: Claude Code's
// (its own folder and every Magpie account's) and Codex's. Read only; a
// Claude Code chat brought in goes on in the same session.

type sessionInfo struct {
	Agent   string    `json:"agent"` // claude | codex
	ID      string    `json:"id"`
	File    string    `json:"file"`
	Cwd     string    `json:"cwd"`
	Title   string    `json:"title"`
	Model   string    `json:"model,omitempty"`
	Turns   int       `json:"turns"`
	Updated time.Time `json:"updated"`
	Size    int64     `json:"size"`
}

type importPart struct {
	K     string          `json:"k"` // text | tool
	Text  string          `json:"text,omitempty"`
	ID    string          `json:"id,omitempty"`
	Name  string          `json:"name,omitempty"`
	Input json.RawMessage `json:"input,omitempty"`
	OK    *bool           `json:"ok,omitempty"`
	Out   string          `json:"out,omitempty"`
}

type importMsg struct {
	Role  string       `json:"role"`
	Text  string       `json:"text,omitempty"`
	Parts []importPart `json:"parts,omitempty"`
	Model string       `json:"model,omitempty"`
	When  string       `json:"when,omitempty"`
}

func homeDir() string { h, _ := os.UserHomeDir(); return h }

func claudeRoots() []string {
	roots := []string{defaultClaudeDir()}
	if more, err := filepath.Glob(filepath.Join(magpieConfigDir(), "claude-accounts", "*")); err == nil {
		roots = append(roots, more...)
	}
	return roots
}

func codexRoot() string {
	if d := os.Getenv("CODEX_HOME"); d != "" {
		return filepath.Join(d, "sessions")
	}
	return filepath.Join(homeDir(), ".codex", "sessions")
}

// inside says a file is one of the session files this reads, and nothing else
func importable(file string) (string, bool) {
	abs, err := filepath.Abs(file)
	if err != nil || !strings.EqualFold(filepath.Ext(abs), ".jsonl") {
		return "", false
	}
	low := strings.ToLower(abs)
	for _, r := range claudeRoots() {
		if strings.HasPrefix(low, strings.ToLower(filepath.Join(r, "projects"))+string(filepath.Separator)) {
			return "claude", true
		}
	}
	if strings.HasPrefix(low, strings.ToLower(codexRoot())+string(filepath.Separator)) {
		return "codex", true
	}
	return "", false
}

// text a person typed, not what a tool put in their place
func humanText(s string) bool {
	t := strings.TrimSpace(s)
	if t == "" {
		return false
	}
	for _, p := range []string{"<", "# AGENTS.md", "Caveat:", "[Request interrupted", "The following is the Codex agent history", "You are a helpful assistant"} {
		if strings.HasPrefix(t, p) {
			return false
		}
	}
	return true
}

func firstLine(s string, n int) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	if r := []rune(s); len(r) > n {
		s = string(r[:n]) + "…"
	}
	return s
}

type claudeLine struct {
	Type      string `json:"type"`
	SessionID string `json:"sessionId"`
	Cwd       string `json:"cwd"`
	IsMeta    bool   `json:"isMeta"`
	Sidechain bool   `json:"isSidechain"`
	Timestamp string `json:"timestamp"`
	Message   *struct {
		Role    string          `json:"role"`
		Model   string          `json:"model"`
		ID      string          `json:"id"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type block struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
}

func blocks(raw json.RawMessage) (string, []block) {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s, nil
	}
	var bs []block
	_ = json.Unmarshal(raw, &bs)
	return "", bs
}

func scanLines(file string, fn func([]byte) bool) { scanHead(file, 0, fn) }

// scanHead reads at most max bytes (0: all) of a file, a line at a time
func scanHead(file string, max int64, fn func([]byte) bool) {
	f, err := os.Open(file)
	if err != nil {
		return
	}
	defer f.Close()
	var rd io.Reader = f
	if max > 0 {
		rd = io.LimitReader(f, max)
	}
	sc := bufio.NewScanner(rd)
	sc.Buffer(make([]byte, 64<<10), 64<<20)
	for sc.Scan() {
		if !fn(sc.Bytes()) {
			return
		}
	}
}

// claudeInfo: the folder, the first thing asked and how many turns
func claudeInfo(file string) (sessionInfo, bool) {
	in := sessionInfo{Agent: "claude", File: file, ID: strings.TrimSuffix(filepath.Base(file), ".jsonl")}
	scanHead(file, headBytes, func(b []byte) bool {
		var l claudeLine
		if json.Unmarshal(b, &l) != nil || l.Sidechain {
			return true
		}
		if in.Cwd == "" && l.Cwd != "" {
			in.Cwd = l.Cwd
		}
		if l.Message == nil {
			return true
		}
		if l.Type == "assistant" && l.Message.Model != "" && l.Message.Model != "<synthetic>" {
			in.Model = l.Message.Model
		}
		if l.Type == "user" && !l.IsMeta {
			s, bs := blocks(l.Message.Content)
			if s == "" {
				for _, x := range bs {
					if x.Type == "text" {
						s = x.Text
						break
					}
				}
			}
			if humanText(s) {
				in.Turns++
				if in.Title == "" {
					in.Title = firstLine(s, 80)
				}
			}
		}
		return true
	})
	return in, in.Title != ""
}

func codexText(raw json.RawMessage) string {
	var bs []block
	_ = json.Unmarshal(raw, &bs)
	var out []string
	for _, x := range bs {
		if x.Text != "" {
			out = append(out, x.Text)
		}
	}
	s := strings.Join(out, "\n\n")
	// a message with files attached: Codex puts the request after the list
	if i := strings.Index(s, "## My request for Codex:"); i >= 0 {
		s = strings.TrimSpace(s[i+len("## My request for Codex:"):])
	}
	return s
}

type codexLine struct {
	Type    string `json:"type"`
	Payload struct {
		Type      string          `json:"type"`
		ID        string          `json:"id"`
		SessionID string          `json:"session_id"`
		Cwd       string          `json:"cwd"`
		Role      string          `json:"role"`
		Content   json.RawMessage `json:"content"`
		Name      string          `json:"name"`
		Arguments string          `json:"arguments"`
		Input     string          `json:"input"`
		CallID    string          `json:"call_id"`
		Output    json.RawMessage `json:"output"`
		Model     string          `json:"model"`
		Settings  *struct {
			Model string `json:"model"`
		} `json:"thread_settings"`
	} `json:"payload"`
	Timestamp string `json:"timestamp"`
}

func codexInfo(file string) (sessionInfo, bool) {
	in := sessionInfo{Agent: "codex", File: file}
	scanHead(file, headBytes, func(b []byte) bool {
		var l codexLine
		if json.Unmarshal(b, &l) != nil {
			return true
		}
		p := l.Payload
		switch {
		case l.Type == "session_meta":
			in.ID = cmpOr(p.SessionID, p.ID)
			if p.Cwd != "" {
				in.Cwd = p.Cwd
			}
		case l.Type == "turn_context" && in.Cwd == "" && p.Cwd != "":
			in.Cwd = p.Cwd
		case l.Type == "event_msg" && p.Settings != nil && p.Settings.Model != "":
			in.Model = p.Settings.Model
		case l.Type == "response_item" && p.Type == "message" && p.Role == "user":
			if s := codexText(p.Content); humanText(s) {
				in.Turns++
				if in.Title == "" {
					in.Title = firstLine(s, 80)
				}
			}
		}
		return true
	})
	if in.ID == "" {
		in.ID = strings.TrimSuffix(filepath.Base(file), ".jsonl")
	}
	// Codex's own reviewer runs are not chats
	if strings.Contains(in.Model, "auto-review") {
		return in, false
	}
	return in, in.Title != ""
}

// the head of a session holds its folder, first question and model; the
// rest (sometimes hundreds of MB) is read only when a chat is brought in
const headBytes = 512 << 10

type cachedInfo struct {
	mod time.Time
	in  sessionInfo
	ok  bool
}

var infoCache = struct {
	sync.Mutex
	m map[string]cachedInfo
}{m: map[string]cachedInfo{}}

func listSessions(limit int) []sessionInfo {
	type cand struct {
		agent, file string
		mod         time.Time
		size        int64
	}
	var cs []cand
	for _, r := range claudeRoots() {
		files, _ := filepath.Glob(filepath.Join(r, "projects", "*", "*.jsonl"))
		for _, f := range files {
			if st, err := os.Stat(f); err == nil && st.Size() > 0 {
				cs = append(cs, cand{"claude", f, st.ModTime(), st.Size()})
			}
		}
	}
	_ = filepath.WalkDir(codexRoot(), func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && strings.HasSuffix(p, ".jsonl") {
			if st, err := d.Info(); err == nil && st.Size() > 0 {
				cs = append(cs, cand{"codex", p, st.ModTime(), st.Size()})
			}
		}
		return nil
	})
	sort.Slice(cs, func(i, j int) bool { return cs[i].mod.After(cs[j].mod) })
	seen := map[string]bool{}
	var out []sessionInfo
	for _, c := range cs {
		if len(out) >= limit {
			break
		}
		// a Claude session copied between accounts shows once: its newest copy
		key := c.agent + ":" + strings.TrimSuffix(filepath.Base(c.file), ".jsonl")
		if c.agent == "claude" && seen[key] {
			continue
		}
		var in sessionInfo
		var ok bool
		infoCache.Lock()
		hit, had := infoCache.m[c.file]
		infoCache.Unlock()
		if had && hit.mod.Equal(c.mod) {
			in, ok = hit.in, hit.ok
		} else {
			if c.agent == "claude" {
				in, ok = claudeInfo(c.file)
			} else {
				in, ok = codexInfo(c.file)
			}
			infoCache.Lock()
			infoCache.m[c.file] = cachedInfo{c.mod, in, ok}
			infoCache.Unlock()
		}
		seen[key] = true
		if !ok {
			continue
		}
		in.Updated, in.Size = c.mod, c.size
		out = append(out, in)
	}
	return out
}

func clockOf(ts string) string {
	if t, err := time.Parse(time.RFC3339Nano, ts); err == nil {
		return t.Local().Format("15:04")
	}
	return ""
}

func readClaude(file string) []importMsg {
	var out []importMsg
	tools := map[string]*importPart{}
	var cur *importMsg
	lastID := ""
	scanLines(file, func(b []byte) bool {
		var l claudeLine
		if json.Unmarshal(b, &l) != nil || l.Sidechain || l.Message == nil {
			return true
		}
		s, bs := blocks(l.Message.Content)
		switch l.Type {
		case "user":
			if l.IsMeta {
				return true
			}
			// tool results fill the tool cards they answer
			human := s
			for _, x := range bs {
				switch x.Type {
				case "tool_result":
					if t := tools[x.ToolUseID]; t != nil {
						ok := !x.IsError
						t.OK = &ok
						t.Out = clip(resultText(x.Content), 4000)
					}
				case "text":
					if human == "" {
						human = x.Text
					}
				}
			}
			if humanText(human) {
				out = append(out, importMsg{Role: "user", Text: strings.TrimSpace(human)})
				cur, lastID = nil, ""
			}
		case "assistant":
			if cur == nil || (l.Message.ID != "" && l.Message.ID != lastID && len(out) > 0 && out[len(out)-1].Role != "assistant") {
				out = append(out, importMsg{Role: "assistant", Model: l.Message.Model, When: clockOf(l.Timestamp)})
				cur = &out[len(out)-1]
			}
			cur = &out[len(out)-1]
			lastID = l.Message.ID
			if l.Message.Model != "" && l.Message.Model != "<synthetic>" {
				cur.Model = l.Message.Model
			}
			for _, x := range bs {
				switch x.Type {
				case "text":
					if strings.TrimSpace(x.Text) != "" {
						cur.Parts = append(cur.Parts, importPart{K: "text", Text: x.Text})
					}
				case "tool_use":
					cur.Parts = append(cur.Parts, importPart{K: "tool", ID: x.ID, Name: x.Name, Input: x.Input})
					tools[x.ID] = &cur.Parts[len(cur.Parts)-1]
				}
			}
			// part pointers move when the slice grows: index them again
			for i := range cur.Parts {
				if cur.Parts[i].K == "tool" {
					tools[cur.Parts[i].ID] = &cur.Parts[i]
				}
			}
		}
		return true
	})
	return out
}

func readCodex(file string) []importMsg {
	var out []importMsg
	tools := map[string]int{} // call id -> index in the last reply's parts
	model := ""
	last := func() *importMsg {
		if len(out) == 0 || out[len(out)-1].Role != "assistant" {
			out = append(out, importMsg{Role: "assistant", Model: model})
			tools = map[string]int{}
		}
		return &out[len(out)-1]
	}
	scanLines(file, func(b []byte) bool {
		var l codexLine
		if json.Unmarshal(b, &l) != nil {
			return true
		}
		p := l.Payload
		if l.Type == "event_msg" && p.Settings != nil && p.Settings.Model != "" {
			model = p.Settings.Model
		}
		if l.Type != "response_item" {
			return true
		}
		switch p.Type {
		case "message":
			text := codexText(p.Content)
			if p.Role == "user" && humanText(text) {
				out = append(out, importMsg{Role: "user", Text: strings.TrimSpace(text)})
			} else if p.Role == "assistant" && strings.TrimSpace(text) != "" {
				m := last()
				m.When = clockOf(l.Timestamp)
				m.Parts = append(m.Parts, importPart{K: "text", Text: text})
			}
		case "function_call", "custom_tool_call":
			m := last()
			arg := p.Arguments
			if arg == "" {
				arg = p.Input
			}
			in, _ := json.Marshal(map[string]string{"input": clip(arg, 2000)})
			if json.Valid([]byte(arg)) && strings.HasPrefix(strings.TrimSpace(arg), "{") {
				in = json.RawMessage(arg)
			}
			m.Parts = append(m.Parts, importPart{K: "tool", ID: p.CallID, Name: p.Name, Input: in})
			tools[p.CallID] = len(m.Parts) - 1
		case "function_call_output", "custom_tool_call_output":
			if len(out) == 0 || out[len(out)-1].Role != "assistant" {
				return true
			}
			m := &out[len(out)-1]
			if i, ok := tools[p.CallID]; ok && i < len(m.Parts) {
				var s string
				if json.Unmarshal(p.Output, &s) != nil {
					s = codexText(p.Output)
				}
				okv := true
				m.Parts[i].OK = &okv
				m.Parts[i].Out = clip(s, 4000)
			}
		}
		return true
	})
	return out
}

func importRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/project/import/list", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"sessions": listSessions(400)})
	})
	mux.HandleFunc("GET /api/project/import/read", func(w http.ResponseWriter, r *http.Request) {
		file := r.URL.Query().Get("file")
		agent, ok := importable(file)
		if !ok {
			writeJSON(w, 404, map[string]string{"error": "That is not a chat Foxpit can bring in."})
			return
		}
		var msgs []importMsg
		var info sessionInfo
		if agent == "claude" {
			msgs = readClaude(file)
			info, _ = claudeInfo(file)
		} else {
			msgs = readCodex(file)
			info, _ = codexInfo(file)
		}
		writeJSON(w, 200, map[string]any{"info": info, "messages": msgs})
	})
}
