package main

// A chat's own copy of the project (a git worktree): it works on its own
// branch in its own folder, so chats side by side never write over each
// other. When it is done the person merges it back, opens a pull request
// from it, or throws it away. And the GitHub side: the repo's issues and
// pull requests, read with the GitHub CLI (gh) the person is signed in to.
//
// The copies live outside the project, in Foxpit's data folder, so the
// project's own git status never shows them.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

func worktreeRoot(repo string) string {
	base, err := os.UserCacheDir()
	if err != nil {
		base = os.TempDir()
	}
	sum := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(repo))))
	return filepath.Join(base, "Foxpit", "worktrees", filepath.Base(repo)+"-"+hex.EncodeToString(sum[:])[:8])
}

var slugBad = regexp.MustCompile(`[^a-z0-9]+`)

func slugOf(title string) string {
	s := strings.Trim(slugBad.ReplaceAllString(strings.ToLower(title), "-"), "-")
	if len(s) > 32 {
		s = strings.Trim(s[:32], "-")
	}
	if s == "" {
		s = "chat"
	}
	return s
}

func gitTop(dir string) (string, error) {
	out, err := gitOut(dir, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", errors.New("This folder is not a git repository, so it can't have a separate copy.")
	}
	return filepath.Clean(strings.TrimSpace(string(out))), nil
}

type worktree struct {
	Path   string `json:"path"`
	Branch string `json:"branch"`
	Base   string `json:"base"` // the branch it started from
	Repo   string `json:"repo"` // the project it belongs to
}

func makeWorktree(cwd, title string) (worktree, error) {
	repo, err := gitTop(cwd)
	if err != nil {
		return worktree{}, err
	}
	base := strings.TrimSpace(string(must(gitOut(repo, "rev-parse", "--abbrev-ref", "HEAD"))))
	if base == "" || base == "HEAD" {
		base = strings.TrimSpace(string(must(gitOut(repo, "rev-parse", "--short", "HEAD"))))
	}
	if base == "" {
		return worktree{}, errors.New("The repository has no commit yet: make a first commit, then start a separate copy.")
	}
	slug := slugOf(title) + "-" + time.Now().Format("0102-1504")
	branch := "foxpit/" + slug
	path := filepath.Join(worktreeRoot(repo), slug)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return worktree{}, err
	}
	if _, err := gitOut(repo, "worktree", "add", "-b", branch, path, "HEAD"); err != nil {
		return worktree{}, fmt.Errorf("git could not make the copy: %v", err)
	}
	_ = trustFolder(path)
	return worktree{Path: path, Branch: branch, Base: base, Repo: repo}, nil
}

func must(b []byte, _ error) []byte { return b }

// commitAll saves whatever the chat changed in its copy, so it can merge or be pushed
func commitAll(dir, msg string) error {
	st, err := gitOut(dir, "status", "--porcelain")
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(st)) == "" {
		return nil
	}
	if _, err := gitOut(dir, "add", "-A"); err != nil {
		return err
	}
	_, err = gitOut(dir, "commit", "-m", msg)
	return err
}

func dropWorktree(w worktree) error {
	dropWorkersIn(w.Path)
	if _, err := gitOut(w.Repo, "worktree", "remove", "--force", w.Path); err != nil {
		_, _ = gitOut(w.Repo, "worktree", "prune")
	}
	for i := 0; i < 5; i++ { // what git left (a folder a process held a moment longer)
		if _, err := os.Stat(w.Path); err != nil || os.RemoveAll(w.Path) == nil {
			break
		}
		time.Sleep(300 * time.Millisecond)
	}
	_, err := gitOut(w.Repo, "branch", "-D", w.Branch)
	return err
}

// ghOut runs the GitHub CLI in a folder
func ghOut(dir string, args ...string) ([]byte, error) {
	cmd := exec.Command("gh", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GH_PROMPT_DISABLED=1", "NO_COLOR=1")
	hideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			return out, errors.New(strings.TrimSpace(string(ee.Stderr)))
		}
		if errors.Is(err, exec.ErrNotFound) {
			return out, errors.New("The GitHub CLI (gh) isn't installed. Install it from cli.github.com and sign in with: gh auth login")
		}
	}
	return out, err
}

// sweepWorktrees removes empty copy folders a removal left behind
func sweepWorktrees() {
	base, err := os.UserCacheDir()
	if err != nil {
		return
	}
	root := filepath.Join(base, "Foxpit", "worktrees")
	repos, _ := os.ReadDir(root)
	for _, r := range repos {
		dirs, _ := os.ReadDir(filepath.Join(root, r.Name()))
		for _, d := range dirs {
			p := filepath.Join(root, r.Name(), d.Name())
			if in, err := os.ReadDir(p); err == nil && len(in) == 0 {
				_ = os.Remove(p)
			}
		}
	}
}

func worktreeRoutes(mux *http.ServeMux) {
	go sweepWorktrees()
	read := func(r *http.Request, v any) bool {
		return json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20)).Decode(v) == nil
	}
	fail := func(w http.ResponseWriter, err error) { writeJSON(w, 200, map[string]string{"error": err.Error()}) }

	mux.HandleFunc("POST /api/project/worktree", func(w http.ResponseWriter, r *http.Request) {
		var q struct {
			Cwd   string `json:"cwd"`
			Title string `json:"title"`
		}
		if !read(r, &q) || q.Cwd == "" {
			http.Error(w, "bad request", 400)
			return
		}
		wt, err := makeWorktree(q.Cwd, q.Title)
		if err != nil {
			fail(w, err)
			return
		}
		writeJSON(w, 200, wt)
	})

	// what the copy has that its base hasn't: commits, and files not yet committed
	mux.HandleFunc("POST /api/project/worktree/state", func(w http.ResponseWriter, r *http.Request) {
		var q worktree
		if !read(r, &q) || q.Path == "" {
			http.Error(w, "bad request", 400)
			return
		}
		if _, err := os.Stat(q.Path); err != nil {
			writeJSON(w, 200, map[string]any{"gone": true})
			return
		}
		ahead := strings.TrimSpace(string(must(gitOut(q.Path, "rev-list", "--count", q.Base+"..HEAD"))))
		files, _ := gitChanges(q.Path)
		pr := ""
		if out, err := ghOut(q.Path, "pr", "view", q.Branch, "--json", "url", "-q", ".url"); err == nil {
			pr = strings.TrimSpace(string(out))
		}
		writeJSON(w, 200, map[string]any{"ahead": ahead, "files": len(files), "pr": pr})
	})

	mux.HandleFunc("POST /api/project/worktree/merge", func(w http.ResponseWriter, r *http.Request) {
		var q struct {
			worktree
			Message string `json:"message"`
		}
		if !read(r, &q) || q.Path == "" || q.Repo == "" {
			http.Error(w, "bad request", 400)
			return
		}
		msg := strings.TrimSpace(q.Message)
		if msg == "" {
			msg = "Foxpit: " + strings.TrimPrefix(q.Branch, "foxpit/")
		}
		if err := commitAll(q.Path, msg); err != nil {
			fail(w, fmt.Errorf("Saving the copy's changes failed: %v", err))
			return
		}
		cur := strings.TrimSpace(string(must(gitOut(q.Repo, "rev-parse", "--abbrev-ref", "HEAD"))))
		if cur != q.Base {
			fail(w, fmt.Errorf("The project is on %q now, not %q where this copy started. Switch it back, then merge.", cur, q.Base))
			return
		}
		if st, _ := gitChanges(q.Repo); len(st) > 0 {
			fail(w, errors.New("The project folder has changes of its own that aren't committed. Commit or put them aside first, so the merge can't mix them up."))
			return
		}
		if out, err := gitOut(q.Repo, "merge", "--no-ff", "-m", "Merge "+q.Branch+": "+msg, q.Branch); err != nil {
			_, _ = gitOut(q.Repo, "merge", "--abort")
			fail(w, fmt.Errorf("The merge stopped on a conflict, so nothing changed: %v %s", err, strings.TrimSpace(string(out))))
			return
		}
		_ = dropWorktree(q.worktree)
		writeJSON(w, 200, map[string]any{"ok": true})
	})

	mux.HandleFunc("POST /api/project/worktree/discard", func(w http.ResponseWriter, r *http.Request) {
		var q worktree
		if !read(r, &q) || q.Path == "" || q.Repo == "" || !strings.HasPrefix(q.Branch, "foxpit/") {
			http.Error(w, "bad request", 400)
			return
		}
		if err := dropWorktree(q); err != nil {
			fail(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true})
	})

	// commit what's there, push the branch, open a pull request
	mux.HandleFunc("POST /api/project/pr", func(w http.ResponseWriter, r *http.Request) {
		var q struct {
			Dir   string `json:"dir"`
			Base  string `json:"base"`
			Title string `json:"title"`
			Body  string `json:"body"`
			Draft bool   `json:"draft"`
		}
		if !read(r, &q) || q.Dir == "" || strings.TrimSpace(q.Title) == "" {
			http.Error(w, "bad request", 400)
			return
		}
		branch := strings.TrimSpace(string(must(gitOut(q.Dir, "rev-parse", "--abbrev-ref", "HEAD"))))
		if branch == "" || branch == "HEAD" {
			fail(w, errors.New("Not on a branch, so there is nothing to push."))
			return
		}
		if q.Base != "" && branch == q.Base {
			fail(w, fmt.Errorf("This is %q itself: open the pull request from a separate copy or another branch.", branch))
			return
		}
		if err := commitAll(q.Dir, q.Title); err != nil {
			fail(w, fmt.Errorf("Saving the changes failed: %v", err))
			return
		}
		if _, err := gitOut(q.Dir, "push", "-u", "origin", branch); err != nil {
			fail(w, fmt.Errorf("git push failed: %v", err))
			return
		}
		if out, err := ghOut(q.Dir, "pr", "view", branch, "--json", "url", "-q", ".url"); err == nil && strings.TrimSpace(string(out)) != "" {
			writeJSON(w, 200, map[string]any{"url": strings.TrimSpace(string(out)), "existing": true})
			return
		}
		args := []string{"pr", "create", "--head", branch, "--title", q.Title, "--body", q.Body}
		if q.Base != "" {
			args = append(args, "--base", q.Base)
		}
		if q.Draft {
			args = append(args, "--draft")
		}
		out, err := ghOut(q.Dir, args...)
		if err != nil {
			fail(w, fmt.Errorf("Opening the pull request failed: %v", err))
			return
		}
		lines := strings.Fields(strings.TrimSpace(string(out)))
		url := ""
		if len(lines) > 0 {
			url = lines[len(lines)-1]
		}
		writeJSON(w, 200, map[string]any{"url": url})
	})

	mux.HandleFunc("POST /api/project/openurl", func(w http.ResponseWriter, r *http.Request) {
		var q struct {
			URL string `json:"url"`
		}
		if !read(r, &q) || !strings.HasPrefix(q.URL, "https://") || strings.ContainsAny(q.URL, " \"\n") {
			http.Error(w, "bad request", 400)
			return
		}
		if err := openURL(q.URL); err != nil {
			fail(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	// the repo's open issues and pull requests
	mux.HandleFunc("GET /api/project/gh/list", func(w http.ResponseWriter, r *http.Request) {
		dir, kind := r.URL.Query().Get("dir"), r.URL.Query().Get("kind")
		if kind != "pr" {
			kind = "issue"
		}
		fields := "number,title,labels,author,updatedAt,url,comments"
		if kind == "pr" {
			fields = "number,title,labels,author,updatedAt,url,headRefName,isDraft,reviewDecision"
		}
		args := []string{kind, "list", "--limit", "60", "--json", fields}
		if q := strings.TrimSpace(r.URL.Query().Get("q")); q != "" {
			args = append(args, "--search", q)
		}
		out, err := ghOut(dir, args...)
		if err != nil {
			fail(w, err)
			return
		}
		repo := strings.TrimSpace(string(must(ghOut(dir, "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"))))
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"repo":%q,"items":%s}`, repo, strings.TrimSpace(string(out)))
	})

	mux.HandleFunc("GET /api/project/gh/issue", func(w http.ResponseWriter, r *http.Request) {
		dir, n := r.URL.Query().Get("dir"), r.URL.Query().Get("n")
		if strings.Trim(n, "0123456789") != "" || n == "" {
			http.Error(w, "bad request", 400)
			return
		}
		kind := "issue"
		if r.URL.Query().Get("kind") == "pr" {
			kind = "pr"
		}
		out, err := ghOut(dir, kind, "view", n, "--json", "number,title,body,author,labels,url,comments,state")
		if err != nil {
			fail(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(out)
	})
}
