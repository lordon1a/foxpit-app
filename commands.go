package main

// Claude Code's own slash commands and skills for a folder: the project's
// .claude/commands and .claude/skills, then the user's ~/.claude ones. The
// page lists them after "/"; sent as the message, Claude Code runs them.

import (
	"bufio"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type slashCmd struct {
	Name   string `json:"name"`
	Desc   string `json:"desc"`
	Kind   string `json:"kind"`   // command | skill
	Source string `json:"source"` // project | user
}

// frontmatter reads name and description from a markdown file's --- block.
func frontmatter(path string) (name, desc string) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	if !sc.Scan() || strings.TrimSpace(sc.Text()) != "---" {
		return
	}
	for i := 0; sc.Scan() && i < 60; i++ {
		l := sc.Text()
		if strings.TrimSpace(l) == "---" {
			break
		}
		k, v, ok := strings.Cut(l, ":")
		if !ok {
			continue
		}
		v = strings.Trim(strings.TrimSpace(v), `"'`)
		switch strings.TrimSpace(k) {
		case "name":
			name = v
		case "description":
			desc = v
		}
	}
	return
}

func listCommands(dir string) []slashCmd {
	seen := map[string]bool{}
	var out []slashCmd
	add := func(c slashCmd) {
		if c.Name == "" || seen[c.Name] {
			return
		}
		seen[c.Name] = true
		if len([]rune(c.Desc)) > 160 {
			c.Desc = string([]rune(c.Desc)[:157]) + "…"
		}
		out = append(out, c)
	}
	roots := []struct{ dir, source string }{}
	if dir != "" {
		roots = append(roots, struct{ dir, source string }{filepath.Join(dir, ".claude"), "project"})
	}
	roots = append(roots, struct{ dir, source string }{defaultClaudeDir(), "user"})
	for _, r := range roots {
		// commands: <root>/commands/**/*.md, a subfolder is a namespace (a:b)
		cdir := filepath.Join(r.dir, "commands")
		_ = filepath.WalkDir(cdir, func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() || !strings.EqualFold(filepath.Ext(p), ".md") {
				return nil
			}
			rel, _ := filepath.Rel(cdir, p)
			name := strings.TrimSuffix(filepath.ToSlash(rel), filepath.Ext(rel))
			name = strings.ReplaceAll(name, "/", ":")
			_, desc := frontmatter(p)
			add(slashCmd{Name: name, Desc: desc, Kind: "command", Source: r.source})
			return nil
		})
		// skills: <root>/skills/<name>/SKILL.md
		ents, _ := os.ReadDir(filepath.Join(r.dir, "skills"))
		for _, e := range ents {
			if !e.IsDir() {
				continue
			}
			p := filepath.Join(r.dir, "skills", e.Name(), "SKILL.md")
			if _, err := os.Stat(p); err != nil {
				continue
			}
			name, desc := frontmatter(p)
			if name == "" {
				name = e.Name()
			}
			add(slashCmd{Name: name, Desc: desc, Kind: "skill", Source: r.source})
		}
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Source != out[j].Source {
			return out[i].Source == "project"
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func commandsHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"commands": listCommands(r.URL.Query().Get("dir"))})
}
