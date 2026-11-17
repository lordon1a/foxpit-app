package main

// Asking before a command runs. Claude Code, run headless, can hand each
// permission question to a tool (--permission-prompt-tool). Foxpit serves
// that tool itself, as a tiny MCP server on the stream server: the question
// goes to the chat's own socket as an "ask" card, and the run waits for the
// person's answer.

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"
)

type answer struct {
	Allow  bool `json:"allow"`
	Always bool `json:"always"`
	// what the person filled in: a question's answers, an edited input
	Input json.RawMessage `json:"input,omitempty"`
	// why not, told to the model (a plan to keep working on)
	Message string `json:"message,omitempty"`
}

// a chat run that can be asked
type asker struct {
	send    func(chatEvent) error
	done    <-chan struct{}
	mu      sync.Mutex
	waiting map[string]chan answer
	always  map[string]bool // keys allowed for the rest of this chat
	// chats this one started (new_chat), and what each said at the end
	spawned map[string]*spawn
	order   []string
}

type spawn struct {
	title string
	done  chan struct{}
	text  string
	ok    bool
}

var askers = struct {
	sync.Mutex
	m map[string]*asker
}{m: map[string]*asker{}}

func newRunID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// chatRunID is a chat's approval address for the app's lifetime: its
// process keeps the same tool URL from turn to turn.
var chatRuns = struct {
	sync.Mutex
	m map[string]string
}{m: map[string]string{}}

func chatRunID(chat string) string {
	chatRuns.Lock()
	defer chatRuns.Unlock()
	id := chatRuns.m[chat]
	if id == "" {
		id = newRunID()
		chatRuns.m[chat] = id
	}
	return id
}

// bind points the chat's questions at this turn's socket.
func (a *asker) bind(send func(chatEvent) error, done <-chan struct{}, allow []string) {
	a.mu.Lock()
	a.send, a.done = send, done
	for _, k := range allow {
		a.always[k] = true
	}
	a.mu.Unlock()
}

func addAsker(id string, a *asker) {
	askers.Lock()
	askers.m[id] = a
	askers.Unlock()
}

func dropAsker(id string) {
	askers.Lock()
	delete(askers.m, id)
	askers.Unlock()
}

// answerFor routes the page's answer to the question waiting for it.
func (a *asker) answer(id string, an answer) {
	a.mu.Lock()
	ch := a.waiting[id]
	delete(a.waiting, id)
	a.mu.Unlock()
	if ch != nil {
		ch <- an
	}
}

// permKey is what "always allow" remembers: a shell command by its program
// (git, npm…), anything else by the tool's name.
func permKey(tool string, input json.RawMessage) string {
	if tool == "Bash" || tool == "PowerShell" {
		var in struct {
			Command string `json:"command"`
		}
		_ = json.Unmarshal(input, &in)
		f := strings.Fields(in.Command)
		if len(f) > 0 {
			prog := strings.ToLower(strings.Trim(f[0], `"'`))
			if i := strings.LastIndexAny(prog, `/\`); i >= 0 {
				prog = prog[i+1:]
			}
			return tool + ":" + strings.TrimSuffix(prog, ".exe")
		}
	}
	return tool
}

func (a *asker) ask(tool string, input json.RawMessage) answer {
	key := permKey(tool, input)
	a.mu.Lock()
	if a.always[key] {
		a.mu.Unlock()
		return answer{Allow: true}
	}
	id := newRunID()[:10]
	ch := make(chan answer, 1)
	a.waiting[id] = ch
	send, done := a.send, a.done
	a.mu.Unlock()
	if send == nil || send(chatEvent{T: "ask", ID: id, Name: tool, Input: input, Text: key}) != nil {
		return answer{}
	}
	select {
	case an := <-ch:
		if an.Allow && an.Always {
			a.mu.Lock()
			a.always[key] = true
			a.mu.Unlock()
		}
		return an
	case <-done:
		return answer{}
	case <-time.After(30 * time.Minute):
		return answer{}
	}
}

// approveHandler is the MCP server (streamable HTTP, JSON answers only).
func approveHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			http.Error(w, "post only", http.StatusMethodNotAllowed)
			return
		}
		askers.Lock()
		a := askers.m[r.URL.Query().Get("run")]
		askers.Unlock()
		var req struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&req); err != nil {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		if len(req.ID) == 0 || string(req.ID) == "null" {
			w.WriteHeader(http.StatusAccepted) // a notification
			return
		}
		reply := func(result any) {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
		}
		switch req.Method {
		case "initialize":
			var p struct {
				Version string `json:"protocolVersion"`
			}
			_ = json.Unmarshal(req.Params, &p)
			reply(map[string]any{
				"protocolVersion": cmpOr(p.Version, "2025-06-18"),
				"capabilities":    map[string]any{"tools": map[string]any{}},
				"serverInfo":      map[string]string{"name": "foxpit", "version": "1"},
			})
		case "ping":
			reply(map[string]any{})
		case "tools/list":
			reply(map[string]any{"tools": append(append([]map[string]any{}, browserTools...), newChatTool, waitChatsTool, map[string]any{
				"name":        "approve",
				"description": "Asks the person in Foxpit whether a tool may run.",
				"inputSchema": map[string]any{"type": "object", "properties": map[string]any{
					"tool_name": map[string]string{"type": "string"},
					"input":     map[string]string{"type": "object"},
				}, "required": []string{"tool_name", "input"}},
			})})
		case "tools/call":
			var head struct {
				Name string          `json:"name"`
				Args json.RawMessage `json:"arguments"`
			}
			_ = json.Unmarshal(req.Params, &head)
			if isBrowserTool(head.Name) {
				content, isErr := callBrowserTool(r.URL.Query().Get("run"), head.Name, head.Args)
				reply(map[string]any{"content": content, "isError": isErr})
				return
			}
			if head.Name == "new_chat" || head.Name == "wait_chats" {
				text, isErr := "Foxpit is not taking new chats from this run.", true
				if a != nil {
					if head.Name == "new_chat" {
						text, isErr = a.newChat(head.Args)
					} else {
						text, isErr = a.waitChats(r, head.Args)
					}
				}
				reply(map[string]any{"content": []map[string]string{{"type": "text", "text": text}}, "isError": isErr})
				return
			}
			var p struct {
				Args struct {
					Tool  string          `json:"tool_name"`
					Input json.RawMessage `json:"input"`
				} `json:"arguments"`
			}
			_ = json.Unmarshal(req.Params, &p)
			in := p.Args.Input
			if len(in) == 0 {
				in = json.RawMessage("{}")
			}
			an := answer{}
			if a != nil {
				an = a.ask(p.Args.Tool, in)
			}
			var out []byte
			if an.Allow {
				upd := in
				if len(an.Input) > 0 && json.Valid(an.Input) {
					upd = an.Input
				}
				out, _ = json.Marshal(map[string]any{"behavior": "allow", "updatedInput": upd})
			} else {
				msg := an.Message
				if msg == "" {
					msg = "The person declined this in Foxpit. Don't try it another way; say what you wanted to do and ask."
				}
				out, _ = json.Marshal(map[string]any{"behavior": "deny", "message": msg})
			}
			reply(map[string]any{"content": []map[string]string{{"type": "text", "text": string(out)}}})
		default:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": req.ID, "error": map[string]any{"code": -32601, "message": "method not found"}})
		}
	})
}

// newUUID is a random version-4 uuid
func newUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
