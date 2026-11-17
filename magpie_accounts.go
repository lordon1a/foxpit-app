package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Magpie's subscriptions, as `magpie accounts --json` gives them, and the
// few things Foxpit asks the CLI to do with them. A Claude account is only
// chosen for Foxpit's own chats (each runs in that account's folder):
// Claude Code's own sign-in on this computer is never switched from here.

type mpWindow struct {
	Name      string  `json:"name"`
	Used      float64 `json:"used"`
	Remaining float64 `json:"remaining"`
	ResetsAt  string  `json:"resetsAt,omitempty"`
}

type mpAccount struct {
	Agent   string     `json:"agent"`
	User    string     `json:"user"`
	Alias   string     `json:"alias,omitempty"`
	Plan    string     `json:"plan,omitempty"`
	Active  bool       `json:"active"`
	On      bool       `json:"on"`
	Windows []mpWindow `json:"windows"`
	Error   string     `json:"error,omitempty"`
	Lapsed  string     `json:"lapsed,omitempty"`
	Resets  *struct {
		Count int `json:"count"`
	} `json:"resets,omitempty"`
	// Foxpit's own: a Claude account its chats can run on
	Here bool `json:"here,omitempty"`
}

var mpCache = struct {
	sync.Mutex
	at   time.Time
	list []mpAccount
}{}

// forgetAccounts drops the cached list (an account just ran out)
func (m *Magpie) forgetAccounts() {
	mpCache.Lock()
	mpCache.at = time.Time{}
	mpCache.Unlock()
}

func (m *Magpie) cli(timeout time.Duration, args ...string) ([]byte, error) {
	if m.path == "" {
		return nil, exec.ErrNotFound
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, m.path, args...)
	hideWindow(cmd)
	return cmd.Output()
}

func (m *Magpie) accounts(fresh bool) ([]mpAccount, error) {
	mpCache.Lock()
	defer mpCache.Unlock()
	if !fresh && time.Since(mpCache.at) < 8*time.Second && mpCache.list != nil {
		return mpCache.list, nil
	}
	out, err := m.cli(20*time.Second, "accounts", "--json")
	if err != nil {
		return nil, err
	}
	var list []mpAccount
	if err := json.Unmarshal(out, &list); err != nil {
		return nil, err
	}
	for i := range list {
		a := &list[i]
		for j := range a.Windows {
			a.Windows[j].Name = fixMojibake(a.Windows[j].Name)
		}
		a.Lapsed, a.Error = fixMojibake(a.Lapsed), fixMojibake(a.Error)
		if a.Agent == "claude" && a.Lapsed == "" && signedIn(claudeAccountDir(a.User)) {
			a.Here = true
		}
		applyHeard(a)
	}
	mpCache.list, mpCache.at = list, time.Now()
	return list, nil
}

// the CLI writes UTF-8 that a console code page turned into Latin-1 pairs
func fixMojibake(s string) string {
	if !strings.ContainsAny(s, "ÂÃâ") {
		return s
	}
	b := make([]byte, 0, len(s))
	for _, r := range s {
		if r > 255 {
			switch r { // cp1252's own letters for 0x80-0x9f
			case '€':
				r = 0x80
			case '‚':
				r = 0x82
			case '„':
				r = 0x84
			case '…':
				r = 0x85
			case '†':
				r = 0x86
			case '‡':
				r = 0x87
			case '‰':
				r = 0x89
			case '‹':
				r = 0x8b
			case '‘':
				r = 0x91
			case '’':
				r = 0x92
			case '“':
				r = 0x93
			case '”':
				r = 0x94
			case '•':
				r = 0x95
			case '–':
				r = 0x96
			case '—':
				r = 0x97
			case '™':
				r = 0x99
			case '›':
				r = 0x9b
			default:
				return s
			}
		}
		b = append(b, byte(r))
	}
	return string(b)
}

// full says an account has no room left in one of its windows
func (a mpAccount) full() bool {
	for _, w := range a.Windows {
		if w.Remaining <= 0.5 && w.Used >= 99.5 {
			return true
		}
	}
	return false
}

var signInAgents = map[string]bool{"claude": true, "codex": true, "gemini": true, "antigravity": true, "copilot": true}

func (m *Magpie) accountRoutes(mux *http.ServeMux, writeJSON func(http.ResponseWriter, int, any)) {
	mux.HandleFunc("GET /api/magpie/accounts", func(w http.ResponseWriter, r *http.Request) {
		list, err := m.accounts(r.URL.Query().Get("fresh") == "1")
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Magpie did not answer: " + err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"accounts": list})
	})
	// a ChatGPT account for everything that goes through Magpie (and Codex)
	mux.HandleFunc("POST /api/magpie/accounts/switch", func(w http.ResponseWriter, r *http.Request) {
		var q struct{ Agent, User string }
		if json.NewDecoder(r.Body).Decode(&q) != nil || q.Agent != "codex" || q.User == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Only ChatGPT accounts switch in Magpie; Claude is picked per chat."})
			return
		}
		if out, err := m.cli(30*time.Second, "accounts", "switch", "codex", q.User); err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": strings.TrimSpace(string(out)) + " " + err.Error()})
			return
		}
		_, _ = m.accounts(true)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	// a sign-in: Magpie's own flow in its own window (the browser opens there)
	mux.HandleFunc("POST /api/magpie/accounts/add", func(w http.ResponseWriter, r *http.Request) {
		agent := r.URL.Query().Get("agent")
		if !signInAgents[agent] || m.path == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Magpie can't sign in to that."})
			return
		}
		// magpie.exe is a windowed app; the console one beside it shows
		// the sign-in's words and takes what the person types
		bin := m.path
		if com := strings.TrimSuffix(bin, filepath.Ext(bin)) + ".com"; com != bin {
			if _, err := os.Stat(com); err == nil {
				bin = com
			}
		}
		cmd := consoleCmd("Magpie sign-in", bin, "accounts", "add", agent)
		log.Printf("magpie: sign-in for %s opened (%s)", agent, filepath.Base(bin))
		if err := cmd.Start(); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		go func() { _ = cmd.Wait() }()
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /api/magpie/accounts/refresh", func(w http.ResponseWriter, r *http.Request) {
		out, err := m.cli(60*time.Second, "accounts", "refresh")
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": strings.TrimSpace(string(out)) + " " + err.Error()})
			return
		}
		_, _ = m.accounts(true)
		writeJSON(w, http.StatusOK, map[string]string{"ok": strings.TrimSpace(string(out))})
	})
	mux.HandleFunc("POST /api/magpie/accounts/alias", func(w http.ResponseWriter, r *http.Request) {
		var q struct{ Agent, User, Name string }
		if json.NewDecoder(r.Body).Decode(&q) != nil || !signInAgents[q.Agent] || q.User == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Which account?"})
			return
		}
		args := []string{"accounts", "alias", q.Agent, q.User}
		if strings.TrimSpace(q.Name) == "" {
			args = append(args, "--clear")
		} else {
			args = append(args, strings.TrimSpace(q.Name))
		}
		if out, err := m.cli(20*time.Second, args...); err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": strings.TrimSpace(string(out)) + " " + err.Error()})
			return
		}
		_, _ = m.accounts(true)
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	// Magpie's own window, and whether it opens at log-in
	mux.HandleFunc("POST /api/magpie/open", func(w http.ResponseWriter, r *http.Request) {
		if m.path == "" {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "Magpie is not installed."})
			return
		}
		cmd := exec.Command(m.path)
		if err := cmd.Start(); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		go func() { _ = cmd.Wait() }()
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/magpie/autostart", func(w http.ResponseWriter, r *http.Request) {
		args := []string{"autostart"}
		if r.Method == http.MethodPost {
			if v := r.URL.Query().Get("on"); v == "1" {
				args = append(args, "on")
			} else {
				args = append(args, "off")
			}
		}
		out, err := m.cli(15*time.Second, args...)
		s := strings.ToLower(strings.TrimSpace(string(out)))
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": s})
			return
		}
		on := strings.Contains(s, " on") || strings.HasSuffix(s, "on") || strings.Contains(s, "opens")
		if strings.Contains(s, "off") || strings.Contains(s, "does not") || strings.Contains(s, "doesn't") {
			on = false
		}
		writeJSON(w, http.StatusOK, map[string]any{"on": on, "text": strings.TrimSpace(string(out))})
	})
}
