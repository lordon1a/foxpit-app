package main

// Chats that start chats. Foxpit's own tool server (approve.go) gives every
// run two tools: new_chat starts a separate Foxpit chat on a task (the
// person sees it under its chat, opens it, can talk to it), and wait_chats
// waits for the ones started and brings back what each said at the end.
// Any model gets them, the ones through Magpie's gateway too: the tools are
// Foxpit's, the model only calls them.

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

var newChatTool = map[string]any{
	"name": "new_chat",
	"description": "Start a separate Foxpit chat that works on one task on its own: a sub-agent the person can see, open and talk to. " +
		"It returns at once, so start several for independent pieces of work and they run side by side; then call wait_chats to get what each found or did. " +
		"Give it a complete brief: it does not see this conversation. It works in the same project folder. " +
		"model is optional: leave it out to use the same model as this chat, or name one (\"opus\", \"sonnet\", \"haiku\", \"gpt\", \"gemini\", or an exact id).",
	"inputSchema": map[string]any{"type": "object", "properties": map[string]any{
		"title":  map[string]string{"type": "string", "description": "A short name for the chat, shown in the person's list (3-6 words)."},
		"prompt": map[string]string{"type": "string", "description": "The whole task: what to do, where, what done looks like, what to report back."},
		"model":  map[string]string{"type": "string", "description": "Optional. Which model the chat runs on."},
	}, "required": []string{"title", "prompt"}},
}

var waitChatsTool = map[string]any{
	"name":        "wait_chats",
	"description": "Wait for chats started with new_chat to finish, and get each one's final answer. With no ids it waits for every chat this one started that has not been reported yet.",
	"inputSchema": map[string]any{"type": "object", "properties": map[string]any{
		"ids": map[string]any{"type": "array", "items": map[string]string{"type": "string"}, "description": "Optional: the chat ids new_chat gave back."},
	}},
}

func (a *asker) newChat(args json.RawMessage) (string, bool) {
	var in struct {
		Title  string `json:"title"`
		Prompt string `json:"prompt"`
		Model  string `json:"model"`
	}
	_ = json.Unmarshal(args, &in)
	in.Title, in.Prompt = strings.TrimSpace(in.Title), strings.TrimSpace(in.Prompt)
	if in.Prompt == "" {
		return "new_chat needs a prompt: the whole task for the new chat.", true
	}
	if in.Title == "" {
		in.Title = clip(strings.SplitN(in.Prompt, "\n", 2)[0], 48)
	}
	id := "k" + newRunID()[:10]
	a.mu.Lock()
	if a.spawned == nil {
		a.spawned = map[string]*spawn{}
	}
	a.spawned[id] = &spawn{title: in.Title, done: make(chan struct{})}
	a.order = append(a.order, id)
	send := a.send
	a.mu.Unlock()
	raw, _ := json.Marshal(map[string]string{"model": in.Model})
	if send == nil || send(chatEvent{T: "spawn", ID: id, Name: in.Title, Text: in.Prompt, Input: raw}) != nil {
		return "Foxpit could not open the chat: this chat's window is not listening.", true
	}
	return fmt.Sprintf("Started chat %s (\"%s\"). It works on its own now; call wait_chats when you need its answer.", id, in.Title), false
}

func (a *asker) waitChats(r *http.Request, args json.RawMessage) (string, bool) {
	var in struct {
		IDs []string `json:"ids"`
	}
	_ = json.Unmarshal(args, &in)
	a.mu.Lock()
	ids := in.IDs
	if len(ids) == 0 {
		for _, id := range a.order {
			if s := a.spawned[id]; s != nil {
				ids = append(ids, id)
			}
		}
	}
	type one struct {
		id string
		s  *spawn
	}
	var list []one
	var unknown []string
	for _, id := range ids {
		if s := a.spawned[id]; s != nil {
			list = append(list, one{id, s})
		} else {
			unknown = append(unknown, id)
		}
	}
	done := a.done
	a.mu.Unlock()
	if len(list) == 0 {
		if len(unknown) > 0 {
			return "No chat by these ids: " + strings.Join(unknown, ", "), true
		}
		return "No chats are waiting: start some with new_chat first.", true
	}
	var b strings.Builder
	for _, x := range list {
		select {
		case <-x.s.done:
		case <-r.Context().Done():
			log.Printf("chat: wait_chats: the tool call went away (%v)", r.Context().Err())
			return "Stopped while waiting.", true
		case <-done:
			log.Printf("chat: wait_chats: the chat's turn ended")
			return "Stopped while waiting.", true
		case <-time.After(25 * time.Minute):
		}
		a.mu.Lock()
		text, ok, finished := x.s.text, x.s.ok, isClosed(x.s.done)
		if finished {
			delete(a.spawned, x.id) // reported once
		}
		a.mu.Unlock()
		state := "finished"
		switch {
		case !finished:
			state, text = "still working after 25 minutes", "(no answer yet: wait_chats again with its id)"
		case !ok:
			state = "stopped with an error"
		}
		fmt.Fprintf(&b, "## %s (%s): %s\n\n%s\n\n", x.s.title, x.id, state, strings.TrimSpace(text))
	}
	if len(unknown) > 0 {
		fmt.Fprintf(&b, "No chat by these ids: %s\n", strings.Join(unknown, ", "))
	}
	return strings.TrimSpace(b.String()), false
}

func isClosed(c chan struct{}) bool {
	select {
	case <-c:
		return true
	default:
		return false
	}
}

// spawnedRoute: the page says a started chat has finished, and what it said
func spawnedRoute(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/project/spawned", func(w http.ResponseWriter, r *http.Request) {
		var q struct {
			Parent string `json:"parent"` // the page's id of the chat that started it
			ID     string `json:"id"`
			Text   string `json:"text"`
			OK     bool   `json:"ok"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<20)).Decode(&q) != nil || q.Parent == "" || q.ID == "" {
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		askers.Lock()
		a := askers.m[chatRunID(q.Parent)]
		askers.Unlock()
		if a != nil {
			a.mu.Lock()
			if s := a.spawned[q.ID]; s != nil && !isClosed(s.done) {
				s.text, s.ok = q.Text, q.OK
				close(s.done)
			}
			a.mu.Unlock()
		}
		w.WriteHeader(http.StatusNoContent)
	})
}
