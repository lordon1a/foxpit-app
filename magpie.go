package main

// Magpie is the gateway behind Foxpit: it holds the accounts, routes each
// request to a model and an account, and keeps the quotas. Foxpit reads it
// over its local HTTP API and never edits Magpie's own files.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

const magpieAddr = "http://127.0.0.1:3425"

type Magpie struct {
	mu      sync.Mutex
	path    string    // the magpie executable, "" when none was found
	cmd     *exec.Cmd // the gateway Foxpit started itself, nil when it was already running
	lastErr string
	client  *http.Client
}

func NewMagpie() *Magpie {
	return &Magpie{path: findMagpie(), client: &http.Client{Timeout: 8 * time.Second}}
}

// findMagpie looks where Magpie is installed: FOXPIT_MAGPIE first, then
// next to foxpit.exe (the bundled copy), then the per-user install, then PATH.
func findMagpie() string {
	if p := os.Getenv("FOXPIT_MAGPIE"); p != "" {
		return p
	}
	var tries []string
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		// the copy that comes with Foxpit: magpie\magpie.exe on Windows,
		// Foxpit.app/Contents/MacOS/magpie on a Mac
		tries = append(tries, filepath.Join(dir, "magpie", "magpie.exe"), filepath.Join(dir, "magpie.exe"),
			filepath.Join(dir, "magpie", "magpie"), filepath.Join(dir, "magpie"))
	}
	if la := os.Getenv("LOCALAPPDATA"); la != "" {
		// magpie.exe itself: magpie.com only launches it as a child
		tries = append(tries, filepath.Join(la, "Programs", "magpie", "magpie.exe"), filepath.Join(la, "Programs", "magpie", "magpie.com"))
	}
	for _, t := range tries {
		if st, err := os.Stat(t); err == nil && !st.IsDir() {
			return t
		}
	}
	if p, err := exec.LookPath("magpie"); err == nil {
		return p
	}
	return ""
}

// alive says whether a Magpie gateway answers on its port.
func (m *Magpie) alive() bool {
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, magpieAddr+"/", nil)
	res, err := m.client.Do(req)
	if err != nil {
		return false
	}
	defer res.Body.Close()
	var who struct {
		Name string `json:"name"`
	}
	_ = json.NewDecoder(io.LimitReader(res.Body, 1<<16)).Decode(&who)
	return who.Name == "magpie"
}

// Ensure makes sure a gateway answers: one already running (the Magpie app,
// its service, or an earlier Foxpit) is used as it is; otherwise Foxpit
// starts `magpie serve` with no window and waits for it.
func (m *Magpie) Ensure() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.alive() {
		m.lastErr = ""
		return nil
	}
	if m.path == "" {
		m.lastErr = "Magpie is not installed"
		return errors.New(m.lastErr)
	}
	if m.cmd == nil || m.cmd.ProcessState != nil {
		cmd := exec.Command(m.path, "serve")
		hideWindow(cmd)
		if err := cmd.Start(); err != nil {
			m.lastErr = "could not start Magpie: " + err.Error()
			return errors.New(m.lastErr)
		}
		tieToApp(cmd)
		m.cmd = cmd
		go func() { _ = cmd.Wait() }()
		log.Printf("magpie: started gateway (pid %d) from %s", cmd.Process.Pid, m.path)
	}
	for deadline := time.Now().Add(20 * time.Second); time.Now().Before(deadline); time.Sleep(300 * time.Millisecond) {
		if m.alive() {
			m.lastErr = ""
			return nil
		}
	}
	m.lastErr = "Magpie did not answer on " + magpieAddr
	return errors.New(m.lastErr)
}

// Stop ends the gateway only when Foxpit started it.
func (m *Magpie) Stop() {
	stopMagpieWeb()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cmd != nil && m.cmd.Process != nil {
		if err := killTree(m.cmd.Process.Pid); err != nil {
			_ = m.cmd.Process.Kill()
		}
		log.Printf("magpie: stopped the gateway Foxpit started")
	}
	m.cmd = nil
}

// get fetches one of the gateway's JSON routes as raw bytes.
func (m *Magpie) get(path string) ([]byte, error) {
	res, err := m.client.Get(magpieAddr + path)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s answered %d", path, res.StatusCode)
	}
	return body, nil
}

// Routes serves the interface's /api/magpie/* calls. The page never talks
// to the gateway itself: the gateway turns away browser origins.
func (m *Magpie) Routes() http.Handler {
	mux := http.NewServeMux()
	writeJSON := func(w http.ResponseWriter, code int, v any) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(v)
	}
	mux.HandleFunc("/api/magpie/status", func(w http.ResponseWriter, r *http.Request) {
		err := m.Ensure()
		m.mu.Lock()
		started := m.cmd != nil
		m.mu.Unlock()
		st := map[string]any{"ok": err == nil, "installed": m.path != "", "startedByFoxpit": started, "addr": magpieAddr}
		if err != nil {
			st["error"] = err.Error()
		}
		writeJSON(w, http.StatusOK, st)
	})
	pass := func(route string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if err := m.Ensure(); err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
				return
			}
			body, err := m.get(route)
			if err != nil {
				writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write(body)
		}
	}
	mux.HandleFunc("/api/magpie/quotas", func(w http.ResponseWriter, r *http.Request) {
		if err := m.Ensure(); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
			return
		}
		body, err := m.get("/v1/magpie/quotas")
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(patchQuotas(body)) // Claude's own numbers over Magpie's
	})
	mux.HandleFunc("/api/magpie/models", pass("/v1/models"))
	// usage and the recent calls: only the period and the page size pass on
	withQuery := func(route string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			q := url.Values{}
			if p := r.URL.Query().Get("period"); p == "today" || p == "7d" || p == "30d" {
				q.Set("period", p)
			}
			if n, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && n > 0 && n <= 200 {
				q.Set("limit", strconv.Itoa(n))
			}
			pass(route+"?"+q.Encode())(w, r)
		}
	}
	m.accountRoutes(mux, writeJSON)
	m.usageRoutes(mux, writeJSON)
	m.libRoutes(mux, writeJSON)
	m.setupRoutes(mux, writeJSON)
	// Magpie's whole app, framed in Foxpit
	mux.HandleFunc("/api/magpie/web", func(w http.ResponseWriter, r *http.Request) {
		u, err := m.webURL()
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"url": u})
	})
	mux.HandleFunc("/api/magpie/usage", withQuery("/v1/magpie/usage"))
	mux.HandleFunc("/api/magpie/requests", withQuery("/v1/magpie/usage/requests"))
	return mux
}
