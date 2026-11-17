package main

// A real terminal: a shell in a pseudo console (ConPTY on Windows), wired to
// the page's xterm.js over a WebSocket. One shell per connection; closing
// the socket ends the shell.

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"time"

	"github.com/aymanbagabas/go-pty"
	"github.com/coder/websocket"
)

// shellCommand picks the user's shell: PowerShell 7 when installed, else
// Windows PowerShell; $SHELL elsewhere.
func shellCommand() (string, []string) {
	if runtime.GOOS == "windows" {
		// a full path: the pseudo console resolves a bare name against Dir
		if p, err := exec.LookPath("pwsh.exe"); err == nil {
			return p, []string{"-NoLogo"}
		}
		if p, err := exec.LookPath("powershell.exe"); err == nil {
			return p, []string{"-NoLogo"}
		}
		return filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), []string{"-NoLogo"}
	}
	if sh := os.Getenv("SHELL"); sh != "" {
		return sh, []string{"-l"}
	}
	return "/bin/sh", nil
}

func termDir(want string) string {
	if want != "" {
		if st, err := os.Stat(want); err == nil && st.IsDir() {
			return want
		}
	}
	if home, err := os.UserHomeDir(); err == nil {
		return home
	}
	return "."
}

type termMsg struct {
	T    string `json:"t"` // "in" | "resize"
	D    string `json:"d,omitempty"`
	Cols int    `json:"c,omitempty"`
	Rows int    `json:"r,omitempty"`
}

func termHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// the key already proved the caller; the page's origin is the app's own scheme
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		ws.SetReadLimit(1 << 20)
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()

		p, err := pty.New()
		if err != nil {
			log.Printf("term: pty: %v", err)
			ws.Close(websocket.StatusInternalError, "no pseudo console: "+err.Error())
			return
		}
		defer p.Close()
		cols, _ := strconv.Atoi(r.URL.Query().Get("cols"))
		rows, _ := strconv.Atoi(r.URL.Query().Get("rows"))
		if cols < 2 || rows < 2 {
			cols, rows = 80, 24
		}
		_ = p.Resize(cols, rows)

		name, args := shellCommand()
		cmd := p.Command(name, args...)
		cmd.Dir = termDir(r.URL.Query().Get("cwd"))
		cmd.Env = append(os.Environ(), "TERM=xterm-256color", "COLORTERM=truecolor", "FOXPIT=1")
		if err := cmd.Start(); err != nil {
			log.Printf("term: start %s: %v", name, err)
			ws.Close(websocket.StatusInternalError, "shell did not start: "+err.Error())
			return
		}
		log.Printf("term: %s in %s (pid %d)", name, cmd.Dir, cmd.Process.Pid)

		// shell → page
		go func() {
			buf := make([]byte, 32<<10)
			for {
				n, err := p.Read(buf)
				if n > 0 {
					wctx, c := context.WithTimeout(ctx, 10*time.Second)
					werr := ws.Write(wctx, websocket.MessageBinary, buf[:n])
					c()
					if werr != nil {
						cancel()
						return
					}
				}
				if err != nil {
					log.Printf("term: read ended: %v", err)
					cancel()
					return
				}
			}
		}()
		// the shell ending ends the socket
		go func() {
			werr := cmd.Wait()
			log.Printf("term: shell ended: %v", werr)
			ws.Close(websocket.StatusNormalClosure, "shell exited")
			cancel()
		}()
		// page → shell
		for {
			typ, data, err := ws.Read(ctx)
			if err != nil {
				break
			}
			if typ == websocket.MessageBinary {
				_, _ = p.Write(data)
				continue
			}
			var m termMsg
			if json.Unmarshal(data, &m) != nil {
				continue
			}
			switch m.T {
			case "in":
				_, _ = io.WriteString(p, m.D)
			case "resize":
				if m.Cols > 1 && m.Rows > 1 {
					_ = p.Resize(m.Cols, m.Rows)
				}
			}
		}
		if cmd.Process != nil {
			_ = killTree(cmd.Process.Pid)
		}
	})
}
