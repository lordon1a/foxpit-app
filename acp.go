package main

// Other coding agents (OpenCode, Gemini CLI, Hermes…) run here through the
// Agent Client Protocol: JSON-RPC over the agent's stdin/stdout, one process
// per chat kept between turns, its session the chat's memory. Magpie already
// points these agents at the person's accounts and models; Foxpit only talks
// to them. Claude chats never come this way.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"
)

type acpAgent struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Provider string   `json:"provider"` // the page's icon family
	bin      string   // command on PATH
	args     []string // what starts its ACP side
}

// the agents Foxpit knows how to start in ACP mode; one not installed, or
// one that does not answer the handshake, is left out of the list
var acpKnown = []acpAgent{
	{ID: "opencode", Name: "OpenCode", Provider: "oc", bin: "opencode", args: []string{"acp"}},
	{ID: "gemini", Name: "Gemini CLI", Provider: "gemini", bin: "gemini", args: []string{"--acp"}},
	{ID: "hermes", Name: "Hermes Agent", Provider: "acp", bin: "hermes", args: []string{"acp"}},
	{ID: "goose", Name: "Goose", Provider: "acp", bin: "goose", args: []string{"acp"}},
	{ID: "qwen", Name: "Qwen Code", Provider: "acp", bin: "qwen", args: []string{"--acp"}},
}

func acpByID(id string) (acpAgent, bool) {
	for _, a := range acpKnown {
		if a.ID == id {
			return a, true
		}
	}
	return acpAgent{}, false
}

// ---------- the connection ----------

type acpMsg struct {
	ID     json.RawMessage `json:"id,omitempty"`
	Method string          `json:"method,omitempty"`
	Params json.RawMessage `json:"params,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type acpConn struct {
	cmd  *exec.Cmd
	in   io.WriteCloser
	wmu  sync.Mutex
	mu   sync.Mutex
	next int
	pend map[int]chan acpMsg
	// where session/update notifications go (the running turn), and what
	// answers the agent's own requests (permission questions)
	sink  func(json.RawMessage)
	onReq func(acpMsg) (any, error)
	dead  chan struct{}
	errb  tailBuf
	init  struct {
		AgentCapabilities struct {
			LoadSession     bool `json:"loadSession"`
			McpCapabilities struct {
				HTTP bool `json:"http"`
			} `json:"mcpCapabilities"`
			PromptCapabilities struct {
				Image bool `json:"image"`
			} `json:"promptCapabilities"`
		} `json:"agentCapabilities"`
	}
}

// tailBuf keeps the last few KB an agent wrote to stderr: why it failed
type tailBuf struct {
	mu sync.Mutex
	b  []byte
}

func (t *tailBuf) Write(p []byte) (int, error) {
	t.mu.Lock()
	t.b = append(t.b, p...)
	if len(t.b) > 8000 {
		t.b = t.b[len(t.b)-8000:]
	}
	t.mu.Unlock()
	return len(p), nil
}

func (t *tailBuf) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.TrimSpace(string(t.b))
}

func startACP(a acpAgent, dir string) (*acpConn, error) {
	path, err := exec.LookPath(a.bin)
	if err != nil {
		return nil, fmt.Errorf("%s was not found on this computer", a.Name)
	}
	cmd := exec.Command(path, a.args...)
	cmd.Dir = dir
	env := []string{"FOXPIT=1"}
	for _, kv := range os.Environ() {
		if !strings.HasPrefix(strings.ToUpper(kv), "FOXPIT=") {
			env = append(env, kv)
		}
	}
	cmd.Env = env
	hideWindow(cmd)
	c := &acpConn{cmd: cmd, pend: map[int]chan acpMsg{}, dead: make(chan struct{})}
	cmd.Stderr = &c.errb
	if c.in, err = cmd.StdinPipe(); err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	tieToApp(cmd)
	go c.read(out)
	go func() { _ = cmd.Wait(); close(c.dead) }()

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	res, err := c.call(ctx, "initialize", map[string]any{
		"protocolVersion":    1,
		"clientCapabilities": map[string]any{"fs": map[string]bool{"readTextFile": false, "writeTextFile": false}, "terminal": false},
		"clientInfo":         map[string]string{"name": "foxpit", "version": version},
	})
	if err != nil {
		c.kill()
		return nil, fmt.Errorf("%s did not start its agent side: %w", a.Name, err)
	}
	_ = json.Unmarshal(res, &c.init)
	return c, nil
}

func (c *acpConn) read(out io.Reader) {
	r := bufio.NewReaderSize(out, 1<<20)
	for {
		line, err := r.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			var m acpMsg
			if json.Unmarshal(line, &m) == nil {
				c.dispatch(m)
			}
		}
		if err != nil {
			c.mu.Lock()
			for id, ch := range c.pend {
				close(ch)
				delete(c.pend, id)
			}
			c.mu.Unlock()
			return
		}
	}
}

func (c *acpConn) dispatch(m acpMsg) {
	switch {
	case m.Method != "" && len(m.ID) > 0:
		// the agent asks something of Foxpit
		go func() {
			c.mu.Lock()
			h := c.onReq
			c.mu.Unlock()
			var res any
			err := errors.New("not supported")
			if h != nil {
				res, err = h(m)
			}
			if err != nil {
				c.write(map[string]any{"jsonrpc": "2.0", "id": m.ID, "error": map[string]any{"code": -32601, "message": err.Error()}})
				return
			}
			c.write(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": res})
		}()
	case m.Method == "session/update":
		c.mu.Lock()
		s := c.sink
		c.mu.Unlock()
		if s != nil {
			s(m.Params)
		}
	case m.Method == "":
		var id int
		if json.Unmarshal(m.ID, &id) != nil {
			return
		}
		c.mu.Lock()
		ch := c.pend[id]
		delete(c.pend, id)
		c.mu.Unlock()
		if ch != nil {
			ch <- m
		}
	}
}

func (c *acpConn) write(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.wmu.Lock()
	defer c.wmu.Unlock()
	_, err = c.in.Write(append(b, '\n'))
	return err
}

func (c *acpConn) call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	c.mu.Lock()
	c.next++
	id := c.next
	ch := make(chan acpMsg, 1)
	c.pend[id] = ch
	c.mu.Unlock()
	if err := c.write(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		return nil, err
	}
	select {
	case m, ok := <-ch:
		if !ok {
			return nil, c.deathErr()
		}
		if m.Error != nil {
			return nil, errors.New(m.Error.Message)
		}
		return m.Result, nil
	case <-c.dead:
		return nil, c.deathErr()
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pend, id)
		c.mu.Unlock()
		return nil, ctx.Err()
	}
}

func (c *acpConn) notify(method string, params any) {
	_ = c.write(map[string]any{"jsonrpc": "2.0", "method": method, "params": params})
}

func (c *acpConn) deathErr() error {
	if s := c.errb.String(); s != "" {
		return errors.New("the agent stopped: " + clip(s, 1500))
	}
	return errors.New("the agent stopped")
}

func (c *acpConn) alive() bool {
	select {
	case <-c.dead:
		return false
	default:
		return true
	}
}

func (c *acpConn) kill() {
	if c.cmd.Process != nil {
		_ = killTree(c.cmd.Process.Pid)
	}
	_ = c.in.Close()
}

// ---------- a session's settings: model, mode, effort ----------

// what session/new (or load) says can be set; agents use either the newer
// config options or the older modes + models lists
type acpSetup struct {
	SessionID     string `json:"sessionId"`
	ConfigOptions []struct {
		ID       string `json:"id"`
		Category string `json:"category"`
		Current  string `json:"currentValue"`
		Options  []struct {
			Value string `json:"value"`
			Name  string `json:"name"`
		} `json:"options"`
	} `json:"configOptions"`
	Modes *struct {
		Available []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"availableModes"`
		Current string `json:"currentModeId"`
	} `json:"modes"`
	Models *struct {
		Available []struct {
			ID   string `json:"modelId"`
			Name string `json:"name"`
		} `json:"availableModels"`
		Current string `json:"currentModelId"`
	} `json:"models"`
}

type acpChoice struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

func (s acpSetup) list(cat string) (opts []acpChoice, current, configID string) {
	for _, o := range s.ConfigOptions {
		if o.Category == cat || (cat == "thought_level" && o.ID == "effort") {
			for _, v := range o.Options {
				opts = append(opts, acpChoice{v.Value, v.Name})
			}
			return opts, o.Current, o.ID
		}
	}
	if cat == "model" && s.Models != nil {
		for _, m := range s.Models.Available {
			opts = append(opts, acpChoice{m.ID, m.Name})
		}
		return opts, s.Models.Current, ""
	}
	if cat == "mode" && s.Modes != nil {
		for _, m := range s.Modes.Available {
			opts = append(opts, acpChoice{m.ID, m.Name})
		}
		return opts, s.Modes.Current, ""
	}
	return nil, "", ""
}

// set picks a value in one category, the way the agent takes it
func (s *acpSetup) set(ctx context.Context, c *acpConn, cat, value string) error {
	opts, cur, cid := s.list(cat)
	if value == "" || value == cur || !hasChoice(opts, value) {
		return nil
	}
	var err error
	switch {
	case cid != "":
		_, err = c.call(ctx, "session/set_config_option", map[string]any{"sessionId": s.SessionID, "configId": cid, "value": value})
	case cat == "model":
		_, err = c.call(ctx, "session/set_model", map[string]any{"sessionId": s.SessionID, "modelId": value})
	case cat == "mode":
		_, err = c.call(ctx, "session/set_mode", map[string]any{"sessionId": s.SessionID, "modeId": value})
	}
	if err == nil {
		for i := range s.ConfigOptions {
			if s.ConfigOptions[i].ID == cid {
				s.ConfigOptions[i].Current = value
			}
		}
		if cat == "model" && s.Models != nil {
			s.Models.Current = value
		}
		if cat == "mode" && s.Modes != nil {
			s.Modes.Current = value
		}
	}
	return err
}

func hasChoice(opts []acpChoice, v string) bool {
	for _, o := range opts {
		if o.ID == v {
			return true
		}
	}
	return false
}

// acpMode is the agent's own mode for Foxpit's permission setting
func acpMode(opts []acpChoice, mode string) string {
	want := map[string][]string{
		"full":  {"yolo", "bypassPermissions", "full-access", "full", "build", "default"},
		"edits": {"autoEdit", "acceptEdits", "auto-edit", "build", "default"},
		"plan":  {"plan", "read-only"},
	}[mode]
	for _, w := range want {
		for _, o := range opts {
			if strings.EqualFold(o.ID, w) {
				return o.ID
			}
		}
	}
	return ""
}

// ---------- chats on agents ----------

type acpSess struct {
	agent    acpAgent
	conn     *acpConn
	dir      string
	setup    acpSetup
	commands []string
	ak       *asker
	runID    string
	busy     bool
}

var acpChats = struct {
	sync.Mutex
	m map[string]*acpSess
}{m: map[string]*acpSess{}}

func stopACP() {
	acpChats.Lock()
	defer acpChats.Unlock()
	for k, s := range acpChats.m {
		s.conn.kill()
		dropAsker(s.runID)
		delete(acpChats.m, k)
	}
}

// the page keeps one session id per chat: an agent's is marked so a Claude
// turn never tries to resume it (and the other way round)
func acpSessionTag(agent, id string) string { return "acp:" + agent + ":" + id }

func acpSessionOf(agent, tagged string) string {
	if p := "acp:" + agent + ":"; strings.HasPrefix(tagged, p) {
		return strings.TrimPrefix(tagged, p)
	}
	return ""
}

// takeACP gives the chat's agent session, started (or loaded) as needed
func takeACP(ctx context.Context, chat string, a acpAgent, dir, session, askURL, runID string) (*acpSess, error) {
	acpChats.Lock()
	s := acpChats.m[chat]
	if s != nil && (s.busy || !s.conn.alive() || s.agent.ID != a.ID || s.dir != dir || (session != "" && session != s.setup.SessionID)) {
		if s.busy {
			acpChats.Unlock()
			return nil, errors.New("this chat's agent is still answering")
		}
		s.conn.kill()
		dropAsker(s.runID)
		delete(acpChats.m, chat)
		s = nil
	}
	if s != nil {
		s.busy = true
		acpChats.Unlock()
		return s, nil
	}
	acpChats.Unlock()

	c, err := startACP(a, dir)
	if err != nil {
		return nil, err
	}
	var mcp []any
	if askURL != "" && c.init.AgentCapabilities.McpCapabilities.HTTP {
		mcp = append(mcp, map[string]any{"type": "http", "name": "foxpit", "url": askURL, "headers": []any{}})
	}
	if mcp == nil {
		mcp = []any{}
	}
	s = &acpSess{agent: a, conn: c, dir: dir, runID: runID, busy: true}
	// a loaded session replays its history as updates: kept away from the page
	var res json.RawMessage
	if session != "" && c.init.AgentCapabilities.LoadSession {
		res, err = c.call(ctx, "session/load", map[string]any{"sessionId": session, "cwd": dir, "mcpServers": mcp})
		if err == nil {
			_ = json.Unmarshal(res, &s.setup)
			s.setup.SessionID = session
		} else {
			log.Printf("acp: %s could not load session %s: %v", a.ID, session, err)
		}
	}
	if s.setup.SessionID == "" {
		res, err = c.call(ctx, "session/new", map[string]any{"cwd": dir, "mcpServers": mcp})
		if err != nil {
			c.kill()
			return nil, fmt.Errorf("%s did not open a session: %w", a.Name, err)
		}
		_ = json.Unmarshal(res, &s.setup)
	}
	s.ak = &asker{waiting: map[string]chan answer{}, always: map[string]bool{}}
	addAsker(runID, s.ak)
	acpChats.Lock()
	if old := acpChats.m[chat]; old != nil {
		old.conn.kill()
	}
	acpChats.m[chat] = s
	acpChats.Unlock()
	log.Printf("acp: %s session %s in %s (pid %d)", a.ID, s.setup.SessionID, dir, c.cmd.Process.Pid)
	return s, nil
}

func (s *acpSess) release() {
	acpChats.Lock()
	s.busy = false
	acpChats.Unlock()
}

// ---------- one turn ----------

// acpTool is what the page knows how to draw for one of the agent's steps
type acpTool struct {
	id, title, kind, name string
	input                 map[string]any
	paths                 []string
	shown, ended          bool
}

func (t *acpTool) merge(u map[string]any) {
	if v, _ := u["title"].(string); v != "" {
		t.title = v
	}
	if v, _ := u["kind"].(string); v != "" {
		t.kind = v
	}
	if v, _ := u["name"].(string); v != "" {
		t.name = v
	}
	if in, ok := u["rawInput"].(map[string]any); ok && len(in) > 0 {
		t.input = in
	}
	if locs, ok := u["locations"].([]any); ok && len(locs) > 0 {
		t.paths = nil
		for _, l := range locs {
			if m, ok := l.(map[string]any); ok {
				if p, _ := m["path"].(string); p != "" {
					t.paths = append(t.paths, p)
				}
			}
		}
	}
}

func mstr(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

// card turns the agent's step into the tool name and input the page draws
// (its Bash, Write, Edit, Read… cards); anything else keeps its own name
func (t *acpTool) card() (string, json.RawMessage) {
	in := t.input
	if in == nil {
		in = map[string]any{}
	}
	path := mstr(in, "file_path", "filePath", "path", "absolute_path")
	if path == "" && len(t.paths) > 0 {
		path = t.paths[0]
	}
	var name string
	var out map[string]any
	low := strings.ToLower(t.name + " " + t.title)
	switch {
	case strings.HasPrefix(t.name, "foxpit_") || strings.HasPrefix(t.title, "foxpit_"):
		name = "mcp__foxpit__" + strings.TrimPrefix(cmpOr(t.name, t.title), "foxpit_")
		out = in
	case t.kind == "execute":
		name = "Bash"
		out = map[string]any{"command": cmpOr(mstr(in, "command", "cmd"), t.title), "description": mstr(in, "description")}
	case t.kind == "edit" && (in["old_string"] != nil || in["oldString"] != nil):
		name = "Edit"
		out = map[string]any{"file_path": path, "old_string": cmpOr(mstr(in, "old_string"), mstr(in, "oldString")), "new_string": cmpOr(mstr(in, "new_string"), mstr(in, "newString"))}
	case t.kind == "edit":
		name = "Write"
		out = map[string]any{"file_path": path, "content": mstr(in, "content", "text")}
	case t.kind == "read":
		name = "Read"
		out = map[string]any{"file_path": path}
	case t.kind == "search":
		name = "Grep"
		out = map[string]any{"pattern": cmpOr(mstr(in, "pattern", "query", "glob"), t.title), "path": path}
	case t.kind == "fetch":
		name = "WebFetch"
		out = map[string]any{"url": cmpOr(mstr(in, "url"), t.title)}
	case strings.Contains(low, "todo"):
		name = "TodoWrite"
		out = in
	default:
		name = cmpOr(t.title, cmpOr(t.name, "Tool"))
		out = in
	}
	b, _ := json.Marshal(out)
	return name, b
}

// contentText is what a tool's result says, as text
func contentText(v any) string {
	list, _ := v.([]any)
	var parts []string
	for _, x := range list {
		m, _ := x.(map[string]any)
		switch m["type"] {
		case "content":
			if c, ok := m["content"].(map[string]any); ok {
				if t := mstr(c, "text"); t != "" {
					parts = append(parts, t)
				}
			}
		case "diff":
			parts = append(parts, "Edited "+mstr(m, "path"))
		case "terminal":
			parts = append(parts, "(terminal output)")
		}
	}
	return strings.Join(parts, "\n")
}

// acpChat runs one turn of a chat on another agent, over the page's socket
func acpChat(ctx context.Context, cancel context.CancelFunc, q chatReq, a acpAgent, dir string, send func(chatEvent) error, readLoop func(runID string, onSay func(id string))) {
	chatKey := q.Chat
	if chatKey == "" {
		chatKey = "once-" + newRunID()
	}
	runID := chatRunID(chatKey)
	askURL := ""
	if askBase != "" {
		askURL = askBase + "/mcp?key=" + askKey + "&run=" + runID
	}
	startCtx, sc := context.WithTimeout(ctx, 90*time.Second)
	s, err := takeACP(startCtx, chatKey, a, dir, acpSessionOf(a.ID, q.Session), askURL, runID)
	sc()
	if err != nil {
		_ = send(chatEvent{T: "error", Text: err.Error()})
		return
	}
	defer s.release()
	if q.Warm {
		_ = send(chatEvent{T: "warm"})
		return
	}

	// a message typed mid-reply waits for the next turn (the page queues it)
	go readLoop(runID, func(id string) { _ = send(chatEvent{T: "said", ID: id, Text: "not taken"}) })

	setCtx, sc2 := context.WithTimeout(ctx, 30*time.Second)
	modes, _, _ := s.setup.list("mode")
	for _, step := range [][2]string{{"model", q.Model}, {"mode", acpMode(modes, q.Mode)}, {"thought_level", q.Effort}} {
		if err := s.setup.set(setCtx, s.conn, step[0], step[1]); err != nil {
			log.Printf("acp: %s: setting %s to %q: %v", a.ID, step[0], step[1], err)
		}
	}
	sc2()

	s.ak.bind(send, ctx.Done(), q.Allow)
	tag := acpSessionTag(a.ID, s.setup.SessionID)
	_ = send(chatEvent{T: "session", Session: tag, Commands: s.commands})

	var mu sync.Mutex
	tools := map[string]*acpTool{}
	var order []string
	saidText := false
	used, window := 0, 0
	emit := func(e chatEvent) {
		if send(e) != nil {
			cancel()
		}
	}
	show := func(t *acpTool) {
		if t.shown {
			return
		}
		t.shown = true
		name, in := t.card()
		emit(chatEvent{T: "tool", ID: t.id, Name: name, Input: in})
	}
	s.conn.mu.Lock()
	s.conn.sink = func(raw json.RawMessage) {
		var p struct {
			Update map[string]any `json:"update"`
		}
		if json.Unmarshal(raw, &p) != nil || p.Update == nil {
			return
		}
		u := p.Update
		mu.Lock()
		defer mu.Unlock()
		switch u["sessionUpdate"] {
		case "agent_message_chunk":
			if c, ok := u["content"].(map[string]any); ok {
				if t := mstr(c, "text"); t != "" {
					saidText = true
					emit(chatEvent{T: "delta", Text: t})
				}
			}
		case "agent_thought_chunk":
			if c, ok := u["content"].(map[string]any); ok {
				if t := mstr(c, "text"); t != "" {
					emit(chatEvent{T: "think", Text: t})
				}
			}
		case "tool_call", "tool_call_update":
			id := mstr(u, "toolCallId")
			if id == "" {
				return
			}
			t := tools[id]
			if t == nil {
				t = &acpTool{id: id}
				tools[id] = t
				order = append(order, id)
			}
			t.merge(u)
			st := mstr(u, "status")
			if !t.shown && (len(t.input) > 0 || st == "completed" || st == "failed") {
				show(t)
			}
			if !t.shown && st == "pending" {
				emit(chatEvent{T: "status", Text: writing(cmpOr(t.title, "a tool"), 0)})
			}
			if (st == "completed" || st == "failed") && !t.ended {
				t.ended = true
				ok := st == "completed"
				emit(chatEvent{T: "tool_result", ID: id, OK: &ok, Text: clip(contentText(u["content"]), 4000)})
			}
		case "available_commands_update":
			var names []string
			if list, ok := u["availableCommands"].([]any); ok {
				for _, x := range list {
					if m, ok := x.(map[string]any); ok {
						if n := mstr(m, "name"); n != "" {
							names = append(names, n)
						}
					}
				}
			}
			s.commands = names
		case "usage_update":
			if v, ok := u["used"].(float64); ok {
				used = int(v)
			}
			if v, ok := u["size"].(float64); ok {
				window = int(v)
			}
		}
	}
	// the agent asks before a step: Foxpit's own approval card answers
	s.conn.onReq = func(m acpMsg) (any, error) {
		if m.Method != "session/request_permission" {
			return nil, errors.New("not supported")
		}
		var p struct {
			ToolCall map[string]any `json:"toolCall"`
			Options  []struct {
				ID   string `json:"optionId"`
				Kind string `json:"kind"`
			} `json:"options"`
		}
		_ = json.Unmarshal(m.Params, &p)
		pick := func(kinds ...string) string {
			for _, k := range kinds {
				for _, o := range p.Options {
					if o.Kind == k {
						return o.ID
					}
				}
			}
			return ""
		}
		selected := func(id string) (any, error) {
			if id == "" {
				return map[string]any{"outcome": map[string]any{"outcome": "cancelled"}}, nil
			}
			return map[string]any{"outcome": map[string]any{"outcome": "selected", "optionId": id}}, nil
		}
		if q.Mode == "full" {
			return selected(pick("allow_once", "allow_always"))
		}
		t := &acpTool{id: mstr(p.ToolCall, "toolCallId")}
		mu.Lock()
		if known := tools[t.id]; known != nil {
			*t = *known
		}
		mu.Unlock()
		t.merge(p.ToolCall)
		name, in := t.card()
		an := s.ak.ask(name, in)
		switch {
		case an.Allow && an.Always:
			return selected(pick("allow_always", "allow_once"))
		case an.Allow:
			return selected(pick("allow_once", "allow_always"))
		default:
			return selected(pick("reject_once", "reject_always"))
		}
	}
	s.conn.mu.Unlock()
	defer func() {
		s.conn.mu.Lock()
		s.conn.sink, s.conn.onReq = nil, nil
		s.conn.mu.Unlock()
	}()

	prompt := []any{map[string]any{"type": "text", "text": q.Prompt}}
	if s.conn.init.AgentCapabilities.PromptCapabilities.Image {
		for _, im := range q.Images {
			prompt = append(prompt, map[string]any{"type": "image", "mimeType": im.Media, "data": im.Data})
		}
	}
	t0 := time.Now()
	log.Printf("acp: %s turn model=%q mode=%q session=%s", a.ID, q.Model, q.Mode, s.setup.SessionID)
	type result struct {
		res json.RawMessage
		err error
	}
	done := make(chan result, 1)
	go func() {
		r, err := s.conn.call(context.Background(), "session/prompt", map[string]any{"sessionId": s.setup.SessionID, "prompt": prompt})
		done <- result{r, err}
	}()
	var r result
	select {
	case r = <-done:
	case <-ctx.Done():
		// Stop: the agent ends the turn itself; one that doesn't is ended
		s.conn.notify("session/cancel", map[string]any{"sessionId": s.setup.SessionID})
		select {
		case <-done:
		case <-time.After(8 * time.Second):
			s.conn.kill()
		}
		log.Printf("acp: %s stopped", a.ID)
		return
	}
	mu.Lock()
	defer mu.Unlock()
	// steps the agent never closed are closed here, so their cards settle
	for _, id := range order {
		if t := tools[id]; t.shown && !t.ended {
			t.ended = true
			ok := r.err == nil
			emit(chatEvent{T: "tool_result", ID: id, OK: &ok})
		}
	}
	if r.err != nil {
		emit(chatEvent{T: "error", Text: a.Name + ": " + r.err.Error(), Session: tag})
		return
	}
	var res struct {
		StopReason string `json:"stopReason"`
	}
	_ = json.Unmarshal(r.res, &res)
	ev := chatEvent{T: "done", Session: tag, Ms: time.Since(t0).Milliseconds(), Used: used, Window: window}
	if !saidText {
		switch res.StopReason {
		case "refusal":
			ev.Text = "The model refused to answer."
		case "max_tokens", "max_turn_requests":
			ev.Text = "The reply stopped at the model's length limit."
		}
	}
	emit(ev)
}

// ---------- which agents are here, and their models ----------

type acpInfo struct {
	acpAgent
	Models   []acpChoice `json:"models"`
	Current  string      `json:"current"`
	Efforts  []acpChoice `json:"efforts,omitempty"`
	Error    string      `json:"error,omitempty"`
	Commands []string    `json:"commands,omitempty"`
}

var acpCache = struct {
	sync.Mutex
	at   time.Time
	list []acpInfo
}{}

// probeACP starts an agent once, opens a session and reads what it offers
func probeACP(a acpAgent) acpInfo {
	info := acpInfo{acpAgent: a}
	dir, _ := os.UserHomeDir()
	c, err := startACP(a, dir)
	if err != nil {
		info.Error = err.Error()
		return info
	}
	defer c.kill()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	res, err := c.call(ctx, "session/new", map[string]any{"cwd": dir, "mcpServers": []any{}})
	if err != nil {
		info.Error = err.Error()
		return info
	}
	var s acpSetup
	_ = json.Unmarshal(res, &s)
	info.Models, info.Current, _ = s.list("model")
	info.Efforts, _, _ = s.list("thought_level")
	// the session existed only to ask: closed where the agent can
	_, _ = c.call(ctx, "session/close", map[string]any{"sessionId": s.SessionID})
	return info
}

func acpList(fresh bool) []acpInfo {
	acpCache.Lock()
	if !fresh && acpCache.list != nil && time.Since(acpCache.at) < 30*time.Minute {
		l := acpCache.list
		acpCache.Unlock()
		return l
	}
	acpCache.Unlock()
	var wg sync.WaitGroup
	var mu sync.Mutex
	var list []acpInfo
	for _, a := range acpKnown {
		if _, err := exec.LookPath(a.bin); err != nil {
			continue
		}
		wg.Add(1)
		go func(a acpAgent) {
			defer wg.Done()
			info := probeACP(a)
			if info.Error != "" {
				log.Printf("acp: %s left out: %s", a.ID, clip(info.Error, 300))
				return
			}
			mu.Lock()
			list = append(list, info)
			mu.Unlock()
		}(a)
	}
	wg.Wait()
	order := map[string]int{}
	for i, a := range acpKnown {
		order[a.ID] = i
	}
	sort.Slice(list, func(i, j int) bool { return order[list[i].ID] < order[list[j].ID] })
	if list == nil {
		list = []acpInfo{}
	}
	acpCache.Lock()
	acpCache.list, acpCache.at = list, time.Now()
	acpCache.Unlock()
	return list
}

func acpRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/project/agents", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"agents": acpList(r.URL.Query().Get("fresh") != "")})
	})
}
