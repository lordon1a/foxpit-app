package main

// The page's saved state (chats, picks): one JSON file in the user's config
// folder. Foxpit does not read inside it; the page owns its shape.

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var stateMu sync.Mutex

func statePath() string {
	if p := os.Getenv("FOXPIT_STATE"); p != "" {
		return p
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		dir = "."
	}
	return filepath.Join(dir, "Foxpit", "state.json")
}

func stateHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	p := statePath()
	switch r.Method {
	case http.MethodGet:
		stateMu.Lock()
		b, err := os.ReadFile(p)
		stateMu.Unlock()
		if err != nil {
			http.Error(w, "no state", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(b)
	case http.MethodPut, http.MethodPost:
		// a cut-off or broken state is never written (it once had a 64 MB cap
		// that a big chat list would have run into, leaving half a file)
		b, err := io.ReadAll(io.LimitReader(r.Body, 1<<30))
		if err != nil || len(b) == 0 || b[0] != '{' || !json.Valid(b) {
			http.Error(w, "bad state", http.StatusBadRequest)
			return
		}
		stateMu.Lock()
		defer stateMu.Unlock()
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		// an empty chat list never replaces one with chats in it: that is a
		// page that failed to read them, not a person who deleted them all
		var in struct {
			Chats []json.RawMessage `json:"chats"`
		}
		if json.Unmarshal(b, &in) == nil && len(in.Chats) == 0 {
			if old, err := os.ReadFile(p); err == nil {
				var was struct {
					Chats []json.RawMessage `json:"chats"`
				}
				if json.Unmarshal(old, &was) == nil && len(was.Chats) > 1 {
					log.Printf("state: refused to write an empty chat list over %d chats", len(was.Chats))
					http.Error(w, "refused: empty chat list", http.StatusConflict)
					return
				}
			}
		}
		// a much smaller state than the one on disk keeps the old one beside
		// it (state.prev.json): chats are not lost to one bad save
		if old, err := os.Stat(p); err == nil && old.Size() > 64<<10 && int64(len(b)) < old.Size()/2 {
			if prev, err := os.ReadFile(p); err == nil {
				_ = os.WriteFile(filepath.Join(filepath.Dir(p), "state.prev-"+time.Now().Format("20060102-150405")+".json"), prev, 0o644)
			}
		}
		tmp := p + ".tmp"
		if err := os.WriteFile(tmp, b, 0o644); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if err := os.Rename(tmp, p); err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "method", http.StatusMethodNotAllowed)
	}
}
