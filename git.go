package main

// The Changes tab: what git says changed in the project folder, a file's
// diff, and a commit the user asks for with the button.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

type changedFile struct {
	Path   string `json:"path"`
	Status string `json:"status"` // M A D R ? (git's letters, ? for untracked)
	Add    int    `json:"add"`
	Del    int    `json:"del"`
	Staged bool   `json:"staged"`
}

func gitOut(dir string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", append([]string{"-C", dir, "-c", "core.quotepath=false"}, args...)...)
	hideWindow(cmd)
	var errb bytes.Buffer
	cmd.Stderr = &errb
	out, err := cmd.Output()
	if err != nil && errb.Len() > 0 {
		return out, &gitError{strings.TrimSpace(errb.String())}
	}
	return out, err
}

type gitError struct{ msg string }

func (e *gitError) Error() string { return e.msg }

func gitChanges(dir string) ([]changedFile, error) {
	out, err := gitOut(dir, "status", "--porcelain=v1", "-z", "--untracked-files=all")
	if err != nil {
		return nil, err
	}
	var files []changedFile
	idx := map[string]int{}
	parts := strings.Split(string(out), "\x00")
	for i := 0; i < len(parts); i++ {
		p := parts[i]
		if len(p) < 4 {
			continue
		}
		x, y, path := p[0], p[1], p[3:]
		st := string(y)
		if y == ' ' {
			st = string(x)
		}
		if x == '?' {
			st = "?"
		}
		if x == 'R' || x == 'C' {
			i++ // the old name follows
		}
		idx[path] = len(files)
		files = append(files, changedFile{Path: path, Status: st, Staged: x != ' ' && x != '?'})
	}
	// line counts against HEAD (an empty repo has none)
	if num, err := gitOut(dir, "diff", "HEAD", "--numstat", "-z"); err == nil {
		for _, rec := range strings.Split(string(num), "\x00") {
			f := strings.SplitN(rec, "\t", 3)
			if len(f) != 3 {
				continue
			}
			if i, ok := idx[f[2]]; ok {
				files[i].Add, _ = strconv.Atoi(f[0])
				files[i].Del, _ = strconv.Atoi(f[1])
			}
		}
	}
	for i := range files {
		if files[i].Status == "?" {
			if b, err := os.ReadFile(filepath.Join(dir, files[i].Path)); err == nil && len(b) < 4<<20 && !bytes.Contains(b[:min(len(b), 8000)], []byte{0}) {
				files[i].Add = bytes.Count(b, []byte("\n"))
				if len(b) > 0 && b[len(b)-1] != '\n' {
					files[i].Add++
				}
			}
		}
	}
	return files, nil
}

// gitDiff is one file's diff against HEAD; an untracked file is all added.
func gitDiff(dir, path string) (string, error) {
	if strings.Contains(path, "..") {
		return "", &gitError{"bad path"}
	}
	out, err := gitOut(dir, "diff", "HEAD", "--no-color", "-U3", "--", path)
	if err == nil && len(out) > 0 {
		return clip(string(out), 400<<10), nil
	}
	if st, _ := gitOut(dir, "status", "--porcelain=v1", "--", path); strings.HasPrefix(string(st), "??") {
		b, err := os.ReadFile(filepath.Join(dir, path))
		if err != nil {
			return "", err
		}
		if bytes.Contains(b[:min(len(b), 8000)], []byte{0}) {
			return "Binary file", nil
		}
		var sb strings.Builder
		sb.WriteString("new file\n@@ -0,0 +1 @@\n")
		for _, l := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
			sb.WriteString("+" + l + "\n")
		}
		return clip(sb.String(), 400<<10), nil
	}
	return string(out), err
}

func gitRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/project/changes", func(w http.ResponseWriter, r *http.Request) {
		dir := r.URL.Query().Get("dir")
		g := readGit(dir)
		if !g.Repo {
			writeJSON(w, 200, map[string]any{"repo": false, "files": []changedFile{}})
			return
		}
		files, err := gitChanges(dir)
		if err != nil {
			writeJSON(w, 200, map[string]any{"repo": true, "error": err.Error(), "files": []changedFile{}})
			return
		}
		if files == nil {
			files = []changedFile{}
		}
		writeJSON(w, 200, map[string]any{"repo": true, "branch": g.Branch, "ahead": g.Ahead, "files": files})
	})
	mux.HandleFunc("GET /api/project/diff", func(w http.ResponseWriter, r *http.Request) {
		d, err := gitDiff(r.URL.Query().Get("dir"), r.URL.Query().Get("path"))
		if err != nil {
			writeJSON(w, 200, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]string{"diff": d})
	})
	mux.HandleFunc("POST /api/project/commit", func(w http.ResponseWriter, r *http.Request) {
		var q struct {
			Dir     string   `json:"dir"`
			Message string   `json:"message"`
			Paths   []string `json:"paths"`
		}
		if json.NewDecoder(r.Body).Decode(&q) != nil || strings.TrimSpace(q.Message) == "" {
			writeJSON(w, 400, map[string]string{"error": "Write a commit message."})
			return
		}
		add := []string{"add", "-A", "--"}
		if len(q.Paths) > 0 {
			add = append(add, q.Paths...)
		} else {
			add = append(add, ".")
		}
		if _, err := gitOut(q.Dir, add...); err != nil {
			writeJSON(w, 200, map[string]string{"error": err.Error()})
			return
		}
		args := []string{"commit", "-m", q.Message}
		if len(q.Paths) > 0 {
			args = append(args, "--")
			args = append(args, q.Paths...)
		}
		out, err := gitOut(q.Dir, args...)
		if err != nil {
			writeJSON(w, 200, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]string{"ok": strings.TrimSpace(string(out))})
	})
}
