package main

// After each turn Claude Code (run with --prompt-suggestions) guesses the
// person's next message, as Claude's own app shows it greyed in the box.
// It comes after the turn's result, when the reply is already over, so it
// is kept here by chat and the page asks for it once the reply ended.

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"sync"
)

var suggests = struct {
	sync.Mutex
	m map[string]string
}{m: map[string]string{}}

// noteSuggest keeps a prompt_suggestion line for the chat; true when it was one
func noteSuggest(chat string, line []byte) bool {
	if !bytes.Contains(line, []byte(`"prompt_suggestion"`)) {
		return false
	}
	var in struct {
		Type       string `json:"type"`
		Suggestion string `json:"suggestion"`
	}
	if json.Unmarshal(line, &in) != nil || in.Type != "prompt_suggestion" {
		return false
	}
	text := strings.TrimSpace(in.Suggestion)
	if chat != "" && text != "" {
		suggests.Lock()
		suggests.m[chat] = clip(text, 500)
		suggests.Unlock()
		log.Printf("chat: next-message guess for %s (%d chars)", chat, len(text))
	}
	return true
}

// a new turn makes the last guess stale
func clearSuggest(chat string) {
	suggests.Lock()
	delete(suggests.m, chat)
	suggests.Unlock()
}

func suggestRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/project/suggest", func(w http.ResponseWriter, r *http.Request) {
		chat := r.URL.Query().Get("chat")
		suggests.Lock()
		text := suggests.m[chat]
		suggests.Unlock()
		writeJSON(w, 200, map[string]string{"text": text})
	})
}
