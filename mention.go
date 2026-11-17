package main

// @ in the message box: the project's files, found by name as you type.
// A git project lists what git tracks (ignored files stay out); any other
// folder is walked once, the heavy folders skipped, and kept for a minute.

import (
	"context"
	"io/fs"
	"net/http"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	mentionMax  = 60000 // files kept per folder
	mentionWalk = 4 * time.Second
	mentionTTL  = time.Minute
)

var skipDirs = map[string]bool{
	".git": true, "node_modules": true, "dist": true, "build": true, "out": true, ".next": true, ".nuxt": true,
	".venv": true, "venv": true, "__pycache__": true, ".cache": true, "target": true, "bin": true, "obj": true,
	".gradle": true, ".idea": true, ".vs": true, "Library": true, "Temp": true, "vendor": true, ".svelte-kit": true,
}

type fileList struct {
	at    time.Time
	files []string // relative, forward slashes
}

var fileLists = struct {
	sync.Mutex
	m map[string]*fileList
}{m: map[string]*fileList{}}

func projectFiles(root string) []string {
	fileLists.Lock()
	if l := fileLists.m[root]; l != nil && time.Since(l.at) < mentionTTL {
		fileLists.Unlock()
		return l.files
	}
	fileLists.Unlock()

	var files []string
	ctx, cancel := context.WithTimeout(context.Background(), mentionWalk)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard")
	hideWindow(cmd)
	if out, err := cmd.Output(); err == nil && len(out) > 0 {
		for _, l := range strings.Split(strings.TrimSpace(string(out)), "\n") {
			if l = strings.TrimSpace(l); l != "" {
				files = append(files, l)
				if len(files) >= mentionMax {
					break
				}
			}
		}
	} else {
		start := time.Now()
		_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				if d != nil && d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			if time.Since(start) > mentionWalk || len(files) >= mentionMax {
				return fs.SkipAll
			}
			if d.IsDir() {
				if p != root && (skipDirs[d.Name()] || strings.HasPrefix(d.Name(), ".")) {
					return fs.SkipDir
				}
				return nil
			}
			if rel, err := filepath.Rel(root, p); err == nil {
				files = append(files, filepath.ToSlash(rel))
			}
			return nil
		})
	}
	fileLists.Lock()
	fileLists.m[root] = &fileList{at: time.Now(), files: files}
	fileLists.Unlock()
	return files
}

// mentionScore: lower is better; -1 leaves the file out
func mentionScore(path, q string) int {
	lp := strings.ToLower(path)
	base := lp[strings.LastIndex(lp, "/")+1:]
	switch {
	case q == "":
		return strings.Count(lp, "/")*10 + len(lp)/8
	case base == q:
		return 0
	case strings.HasPrefix(base, q):
		return 10 + len(base)
	case strings.Contains(base, q):
		return 40 + len(base)
	case strings.Contains(lp, q):
		return 80 + len(lp)/4
	}
	// letters in order (gmjs → game.js)
	i := 0
	for _, r := range base {
		if i < len(q) && byte(r) == q[i] {
			i++
		}
	}
	if i == len(q) {
		return 200 + len(lp)
	}
	return -1
}

func mentionRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/project/files", func(w http.ResponseWriter, r *http.Request) {
		dir := r.URL.Query().Get("dir")
		if dir == "" {
			writeJSON(w, 200, map[string]any{"files": []string{}})
			return
		}
		root, err := filepath.Abs(dir)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": "bad folder"})
			return
		}
		q := strings.ToLower(strings.ReplaceAll(strings.TrimSpace(r.URL.Query().Get("q")), `\`, "/"))
		all := projectFiles(root)
		type hit struct {
			p string
			s int
		}
		var hits []hit
		for _, f := range all {
			if s := mentionScore(f, q); s >= 0 {
				hits = append(hits, hit{f, s})
			}
		}
		sort.Slice(hits, func(i, j int) bool {
			if hits[i].s != hits[j].s {
				return hits[i].s < hits[j].s
			}
			return hits[i].p < hits[j].p
		})
		out := []string{}
		for i := 0; i < len(hits) && i < 40; i++ {
			out = append(out, hits[i].p)
		}
		writeJSON(w, 200, map[string]any{"files": out, "total": len(all)})
	})
}
