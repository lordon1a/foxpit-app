package main

import (
	"encoding/json"
	"net/http"
	"net/url"
	"os/exec"
	"strings"
	"time"
)

// What a first start needs, in one answer: Claude Code to run chats, Magpie
// for accounts and models, a signed-in subscription. The page walks the
// person through what is missing.

const magpieReleases = "https://github.com/yetone/magpie/releases/latest"

func (m *Magpie) setupRoutes(mux *http.ServeMux, writeJSON func(http.ResponseWriter, int, any)) {
	mux.HandleFunc("GET /api/magpie/setup", func(w http.ResponseWriter, r *http.Request) {
		st := map[string]any{"magpie": m.path != "", "claude": false}
		if name, pre, err := claudeCommand(); err == nil {
			st["claude"] = true
			cmd := exec.Command(name, append(pre, "--version")...)
			hideWindow(cmd)
			done := make(chan []byte, 1)
			go func() { out, _ := cmd.Output(); done <- out }()
			select {
			case out := <-done:
				// only a version line ("2.1.325 (Claude Code)"), never other output
				if v := strings.TrimSpace(strings.SplitN(string(out), "\n", 2)[0]); v != "" && v[0] >= '0' && v[0] <= '9' && len(v) < 80 {
					st["claudeVersion"] = v
				}
			case <-time.After(8 * time.Second):
				if cmd.Process != nil {
					_ = cmd.Process.Kill()
				}
			}
		}
		if m.path != "" {
			st["gateway"] = m.Ensure() == nil
			if list, err := m.accounts(false); err == nil {
				working := map[string]int{}
				for _, a := range list {
					if a.Lapsed == "" && a.Error == "" && a.On {
						working[a.Agent]++
					}
				}
				st["accounts"] = working
				here := 0
				for _, a := range list {
					if a.Here {
						here++
					}
				}
				st["claudeHere"] = here
			}
		}
		writeJSON(w, http.StatusOK, st)
	})
	// the one outside page the setup opens: Magpie's download
	mux.HandleFunc("POST /api/magpie/get", func(w http.ResponseWriter, r *http.Request) {
		if err := openURL(magpieReleases); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"ok": magpieReleases})
	})
	// a link in a reply opens in the person's browser, never in the app
	mux.HandleFunc("POST /api/open", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			URL string `json:"url"`
		}
		_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&in)
		u, err := url.Parse(strings.TrimSpace(in.URL))
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Only web links open from a chat."})
			return
		}
		if err := openURL(u.String()); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"ok": u.String()})
	})
	// Magpie installed after Foxpit started: look again
	mux.HandleFunc("POST /api/magpie/rescan", func(w http.ResponseWriter, r *http.Request) {
		m.mu.Lock()
		if m.path == "" {
			m.path = findMagpie()
		}
		found := m.path != ""
		m.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]bool{"magpie": found})
	})
}
