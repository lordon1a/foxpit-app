package main

// Claude models run Claude Code once, on a Claude account Magpie keeps:
// Magpie holds each saved account's sign-in in a config directory of its
// own (~/.config/magpie/claude-accounts/<sha256(email)[:16]>), and Claude
// Code started with CLAUDE_CONFIG_DIR there is that account, signed in.
// Through the gateway instead, Magpie would start a second, hidden Claude
// Code for every turn. A chat moving to another account (or provider) has
// its session file carried along, so --resume finds it.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

func magpieConfigDir() string {
	if d := os.Getenv("FOXPIT_MAGPIE_CONFIG"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "magpie")
}

func claudeAccountDir(user string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(strings.TrimSpace(user))))
	return filepath.Join(magpieConfigDir(), "claude-accounts", hex.EncodeToString(sum[:])[:16])
}

func signedIn(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, ".credentials.json"))
	return err == nil
}

type quotaRow struct {
	Provider string `json:"provider"`
	User     string `json:"user"`
	On       *bool  `json:"on"`
	Error    string `json:"error"`
	Last     bool   `json:"last"`
	Windows  []struct {
		Name string  `json:"name"`
		Used float64 `json:"used"`
		Lane string  `json:"lane"`
	} `json:"windows"`
}

// claudeAccounts are Magpie's Claude accounts signed in here, best first:
// the one Magpie served last, then the one with the most room. want, when
// given, goes first. With auto on, an account with no room left goes last
// (want too); with it off, want is the only one when it can run.
func (m *Magpie) claudeAccounts(want string, auto bool) []string {
	// checks with the stand-in agent: accounts given by name, nothing read
	if os.Getenv("FOXPIT_AGENT_CMD") != "" && os.Getenv("FOXPIT_FAKE_ACCOUNTS") != "" {
		return strings.Split(os.Getenv("FOXPIT_FAKE_ACCOUNTS"), ",")
	}
	var rows []quotaRow
	if b, err := m.get("/v1/magpie/quotas"); err == nil {
		var q struct {
			Data []quotaRow `json:"data"`
		}
		if json.Unmarshal(b, &q) == nil {
			rows = q.Data
		}
	}
	type cand struct {
		user string
		used float64
		last bool
		full bool
	}
	var cs []cand
	for _, r := range rows {
		if r.Provider != "claude" || r.User == "" || (r.On != nil && !*r.On) || r.Error != "" {
			continue
		}
		if !signedIn(claudeAccountDir(r.User)) {
			continue
		}
		var used float64
		for _, w := range r.Windows {
			if w.Lane == "" && w.Used > used {
				used = w.Used
			}
		}
		// Claude itself said this account is out until a reset still ahead
		cs = append(cs, cand{r.User, used, r.Last, used >= 99.5 || outNow(r.User)})
	}
	sort.SliceStable(cs, func(i, j int) bool {
		if cs[i].full != cs[j].full {
			return !cs[i].full
		}
		if cs[i].last != cs[j].last {
			return cs[i].last
		}
		return cs[i].used < cs[j].used
	})
	wantFull := false
	for _, c := range cs {
		if c.user == want {
			wantFull = c.full
		}
	}
	var out []string
	if want != "" && signedIn(claudeAccountDir(want)) {
		if !auto {
			return []string{want}
		}
		if !wantFull {
			out = append(out, want)
		}
	}
	for _, c := range cs {
		if c.user != want || (auto && wantFull) {
			out = append(out, c.user)
		}
	}
	return out
}

var slugRe = regexp.MustCompile(`[^a-zA-Z0-9]`)

// projectSlug is the folder name Claude Code keeps a project's sessions in.
func projectSlug(cwd string) string { return slugRe.ReplaceAllString(cwd, "-") }

// defaultClaudeDir is Claude Code's own config directory.
func defaultClaudeDir() string {
	if d := os.Getenv("CLAUDE_CONFIG_DIR"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude")
}

// carrySession copies session id's transcript into toDir when it is kept
// in another config directory (another account's, or Claude Code's own).
func carrySession(id, cwd, toDir string) {
	if id == "" || strings.ContainsAny(id, `/\.`) {
		return
	}
	name := id + ".jsonl"
	dst := filepath.Join(toDir, "projects", projectSlug(cwd), name)
	var have time.Time
	if st, err := os.Stat(dst); err == nil {
		have = st.ModTime()
	}
	dirs := []string{defaultClaudeDir()}
	if more, err := filepath.Glob(filepath.Join(magpieConfigDir(), "claude-accounts", "*")); err == nil {
		dirs = append(dirs, more...)
	}
	// the copy written last: the account that ran the session most recently
	best, bestAt := "", have
	for _, d := range dirs {
		if filepath.Clean(d) == filepath.Clean(toDir) {
			continue
		}
		src := filepath.Join(d, "projects", projectSlug(cwd), name)
		if st, err := os.Stat(src); err == nil && st.ModTime().After(bestAt) {
			best, bestAt = src, st.ModTime()
		}
	}
	if best == "" {
		return
	}
	f, err := os.Open(best)
	if err != nil {
		return
	}
	defer f.Close()
	_ = os.MkdirAll(filepath.Dir(dst), 0o755)
	tmp := dst + ".foxpit"
	if out, err := os.Create(tmp); err == nil {
		_, cerr := io.Copy(out, f)
		_ = out.Close()
		if cerr == nil {
			_ = os.Rename(tmp, dst)
		} else {
			_ = os.Remove(tmp)
		}
	}
}

// shareUserConfig makes the user's own Claude Code extras (skills, commands,
// agents, CLAUDE.md in ~/.claude) seen in an account's config directory too,
// as links, so every account works with the same ones. What the account
// already has (Magpie's synced library among it) is left alone.
func shareUserConfig(dst string) {
	src := defaultClaudeDir()
	if dst == "" || filepath.Clean(dst) == filepath.Clean(src) {
		return
	}
	link := func(from, to string, dir bool) {
		if _, err := os.Lstat(to); err == nil {
			return
		}
		if dir {
			if err := linkDir(from, to); err != nil {
				log.Printf("share: %s: %v", to, err)
			}
			return
		}
		if err := os.Link(from, to); err != nil {
			log.Printf("share: %s: %v", to, err)
		}
	}
	for _, sub := range []string{"skills", "commands"} {
		ents, err := os.ReadDir(filepath.Join(src, sub))
		if err != nil {
			continue
		}
		_ = os.MkdirAll(filepath.Join(dst, sub), 0o755)
		for _, e := range ents {
			link(filepath.Join(src, sub, e.Name()), filepath.Join(dst, sub, e.Name()), e.IsDir())
		}
	}
	if st, err := os.Stat(filepath.Join(src, "agents")); err == nil && st.IsDir() {
		link(filepath.Join(src, "agents"), filepath.Join(dst, "agents"), true)
	}
	if _, err := os.Stat(filepath.Join(src, "CLAUDE.md")); err == nil {
		link(filepath.Join(src, "CLAUDE.md"), filepath.Join(dst, "CLAUDE.md"), false)
	}
}
