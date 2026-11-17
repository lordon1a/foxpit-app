package main

// Projects are folders the user works in. Opening one also says yes to
// Claude Code's "Do you trust this folder?" for it, as its own dialog would:
// the agents Magpie starts there can't answer that question themselves.

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

var trustMu sync.Mutex

// claudeKey is how Claude Code names a folder in ~/.claude.json.
func claudeKey(dir string) string {
	return strings.ReplaceAll(filepath.Clean(dir), `\`, "/")
}

// trustFolder sets projects[dir].hasTrustDialogAccepted in ~/.claude.json,
// touching nothing else in it.
func trustFolder(dir string) error {
	trustMu.Lock()
	defer trustMu.Unlock()
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	path := filepath.Join(home, ".claude.json")
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		b = []byte("{}")
	} else if err != nil {
		return err
	}
	var root map[string]any
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber() // keep big ids as they are
	if err := dec.Decode(&root); err != nil {
		return err
	}
	projects, _ := root["projects"].(map[string]any)
	if projects == nil {
		projects = map[string]any{}
		root["projects"] = projects
	}
	key := claudeKey(dir)
	p, _ := projects[key].(map[string]any)
	if p == nil {
		p = map[string]any{}
		projects[key] = p
	}
	if v, _ := p["hasTrustDialogAccepted"].(bool); v {
		return nil
	}
	p["hasTrustDialogAccepted"] = true
	var out bytes.Buffer
	enc := json.NewEncoder(&out)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(root); err != nil {
		return err
	}
	tmp := path + ".foxpit.tmp"
	if err := os.WriteFile(tmp, out.Bytes(), 0o600); err != nil {
		return err
	}
	// Claude Code may hold it for a moment
	for i := 0; ; i++ {
		if err = os.Rename(tmp, path); err == nil || i == 5 {
			break
		}
		time.Sleep(80 * time.Millisecond)
	}
	if err != nil {
		_ = os.Remove(tmp)
		return err
	}
	log.Printf("project: trusted %s for Claude Code", key)
	return nil
}

type gitInfo struct {
	Repo   bool   `json:"repo"`
	Branch string `json:"branch"`
	Ahead  int    `json:"ahead"`
	Behind int    `json:"behind"`
	Dirty  int    `json:"dirty"`
}

func gitRun(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	hideWindow(cmd)
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err
}

func readGit(dir string) gitInfo {
	var g gitInfo
	if _, err := gitRun(dir, "rev-parse", "--is-inside-work-tree"); err != nil {
		return g
	}
	g.Repo = true
	g.Branch, _ = gitRun(dir, "branch", "--show-current")
	if g.Branch == "" {
		g.Branch, _ = gitRun(dir, "rev-parse", "--short", "HEAD")
	}
	if s, err := gitRun(dir, "rev-list", "--left-right", "--count", "@{upstream}...HEAD"); err == nil {
		if f := strings.Fields(s); len(f) == 2 {
			g.Behind, _ = strconv.Atoi(f[0])
			g.Ahead, _ = strconv.Atoi(f[1])
		}
	}
	if s, err := gitRun(dir, "status", "--porcelain"); err == nil && s != "" {
		g.Dirty = len(strings.Split(s, "\n"))
	}
	return g
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// projectRoutes: /api/project/open {path} (checks, trusts, describes),
// /api/project/git?dir=, and /api/project/pick (the native folder dialog,
// given by the window app; nil in --dev-http).
// pickFiles is the native file dialog for attachments (nil in --dev-http).
var pickFiles func(dir string) ([]string, error)

func projectRoutes(pick func() (string, error)) http.Handler {
	mux := http.NewServeMux()
	describe := func(w http.ResponseWriter, dir string) {
		st, err := os.Stat(dir)
		if err != nil || !st.IsDir() {
			writeJSON(w, 400, map[string]string{"error": "That folder does not exist."})
			return
		}
		abs, _ := filepath.Abs(dir)
		resp := map[string]any{"path": abs, "name": filepath.Base(abs), "git": readGit(abs)}
		if err := trustFolder(abs); err != nil {
			log.Printf("project: trust %s: %v", abs, err)
			resp["trustError"] = err.Error()
		}
		writeJSON(w, 200, resp)
	}
	mux.HandleFunc("POST /api/project/open", func(w http.ResponseWriter, r *http.Request) {
		var q struct {
			Path string `json:"path"`
		}
		_ = json.NewDecoder(r.Body).Decode(&q)
		describe(w, strings.TrimSpace(q.Path))
	})
	mux.HandleFunc("POST /api/project/pick", func(w http.ResponseWriter, r *http.Request) {
		if pick == nil {
			writeJSON(w, 501, map[string]string{"error": "The folder dialog is in the Foxpit app."})
			return
		}
		dir, err := pick()
		if err != nil || dir == "" {
			writeJSON(w, 200, map[string]any{"canceled": true})
			return
		}
		describe(w, dir)
	})
	mux.HandleFunc("POST /api/project/attach", func(w http.ResponseWriter, r *http.Request) {
		if pickFiles == nil {
			writeJSON(w, 501, map[string]string{"error": "The file dialog is in the Foxpit app."})
			return
		}
		files, err := pickFiles(r.URL.Query().Get("dir"))
		if err != nil {
			files = nil
		}
		allowFiles(files)
		writeJSON(w, 200, map[string]any{"files": files})
	})
	mux.HandleFunc("GET /api/project/commands", commandsHandler)
	// an image in the project folder, for a picture a reply points at
	mux.HandleFunc("GET /api/project/file", func(w http.ResponseWriter, r *http.Request) {
		dir, p := r.URL.Query().Get("dir"), r.URL.Query().Get("path")
		if dir == "" || p == "" {
			http.NotFound(w, r)
			return
		}
		root, _ := filepath.Abs(dir)
		full := p
		if !filepath.IsAbs(full) {
			full = filepath.Join(root, p)
		}
		full, _ = filepath.Abs(full)
		rel, err := filepath.Rel(root, full)
		ext := strings.ToLower(filepath.Ext(full))
		if err != nil || strings.HasPrefix(rel, "..") || mediaTypes[ext] == "" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", mediaTypes[ext])
		w.Header().Set("Cache-Control", "no-store")
		http.ServeFile(w, r, full)
	})
	gitRoutes(mux)
	mediaRoutes(mux)
	suggestRoutes(mux)
	browserRoutes(mux)
	importRoutes(mux)
	mentionRoutes(mux)
	spawnedRoute(mux)
	worktreeRoutes(mux)
	mux.HandleFunc("GET /api/project/git", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, readGit(r.URL.Query().Get("dir")))
	})
	return mux
}
