//go:build !windows

package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

// tieToApp: off Windows, Foxpit stops its children itself when it quits
func tieToApp(cmd *exec.Cmd) {}

// waitGone waits up to max for process pid to end
func waitGone(pid int, max time.Duration) {
	for end := time.Now().Add(max); time.Now().Before(end); time.Sleep(200 * time.Millisecond) {
		if syscall.Kill(pid, 0) != nil {
			return
		}
	}
}

// fixPath: an app opened from Finder or the Dock gets launchd's bare PATH
// (/usr/bin:/bin…), so claude, magpie, git, gh and node would not be found.
// Take the PATH the person's login shell sets up, plus the usual places.
func fixPath() {
	seen := map[string]bool{}
	var dirs []string
	add := func(list string) {
		for _, d := range filepath.SplitList(list) {
			if d = strings.TrimSpace(d); d != "" && !seen[d] {
				seen[d] = true
				dirs = append(dirs, d)
			}
		}
	}
	add(os.Getenv("PATH"))
	sh := os.Getenv("SHELL")
	if sh == "" {
		sh = "/bin/zsh"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	if out, err := exec.CommandContext(ctx, sh, "-ilc", `printf '__FOXPATH__%s' "$PATH"`).Output(); err == nil {
		if i := strings.LastIndex(string(out), "__FOXPATH__"); i >= 0 {
			add(strings.TrimSpace(string(out)[i+len("__FOXPATH__"):]))
		}
	}
	home, _ := os.UserHomeDir()
	extra := []string{"/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"}
	if home != "" {
		extra = append(extra, filepath.Join(home, ".local", "bin"), filepath.Join(home, ".npm-global", "bin"),
			filepath.Join(home, ".claude", "local"), filepath.Join(home, ".bun", "bin"), filepath.Join(home, ".volta", "bin"))
	}
	add(strings.Join(extra, string(os.PathListSeparator)))
	os.Setenv("PATH", strings.Join(dirs, string(os.PathListSeparator)))
}

func hideWindow(cmd *exec.Cmd) {}

// consoleCmd runs bin in a terminal window of its own so a sign-in can be
// read and a code pasted (macOS: Terminal.app; elsewhere: x-terminal-emulator)
func consoleCmd(title, bin string, args ...string) *exec.Cmd {
	q := func(a string) string { return "'" + strings.ReplaceAll(a, "'", `'\''`) + "'" }
	line := "export PATH=" + q(os.Getenv("PATH")) + "; " + q(bin)
	for _, a := range args {
		line += " " + q(a)
	}
	if runtime.GOOS == "darwin" {
		esc := strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(line)
		return exec.Command("osascript", "-e", `tell application "Terminal" to do script "`+esc+`"`, "-e", `tell application "Terminal" to activate`)
	}
	if t, err := exec.LookPath("x-terminal-emulator"); err == nil {
		return exec.Command(t, "-e", "sh", "-c", line+"; echo; read -r _")
	}
	return exec.Command(bin, args...)
}

func killTree(pid int) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Kill()
}

func linkDir(from, to string) error { return os.Symlink(from, to) }

func startDictation() error { return os.ErrInvalid }

func detach(cmd *exec.Cmd) {}

func openURL(u string) error {
	name := "xdg-open"
	if runtime.GOOS == "darwin" {
		name = "open"
	}
	return exec.Command(name, u).Start()
}
