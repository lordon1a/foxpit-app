package main

// One Claude Code per chat, kept running between turns. A fresh `claude -p`
// per message started everything again each time: the MCP servers in the
// user's config, the project's SessionStart hooks, Claude Code itself. The
// chat's process reads its messages as stream-json on standard input and
// stays up; a turn writes one message and reads until that turn's result.
// It is started again only when the run's setup changes (model, effort,
// mode, account, folder) or the chat goes back to an earlier reply.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	workerIdle = 20 * time.Minute // an unused chat's process ends after this
	workerMax  = 4                // chats kept running at once
)

type worker struct {
	chat   string
	sig    string // what the process was started with, its session aside
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	lines  chan []byte   // stdout, line by line; closed when it ends
	dead   chan struct{} // closed once the process has exited
	stderr strings.Builder
	errw   *limitWriter
	werr   error
	runID  string
	ak     *asker

	mu   sync.Mutex
	sid  string // the session it runs now
	used time.Time
	busy bool
	warm bool // started ahead of a new chat's first message, nothing sent yet
}

var workers = struct {
	sync.Mutex
	m map[string]*worker
}{m: map[string]*worker{}}

// workerSig is everything a turn's process depends on, the session aside.
func workerSig(name string, args []string, dir string, env []string) string {
	var keep []string
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--resume", "--resume-session-at":
			i++
			continue
		case "--fork-session":
			continue
		}
		keep = append(keep, args[i])
	}
	var ev []string
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		switch strings.ToUpper(k) {
		case "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", "CLAUDE_CONFIG_DIR":
			ev = append(ev, kv)
		}
	}
	sort.Strings(ev) // the env is built from a map: its order varies
	return name + "\x00" + dir + "\x00" + strings.Join(keep, "\x00") + "\x00" + strings.Join(ev, "\x00")
}

func (w *worker) alive() bool {
	select {
	case <-w.dead:
		return false
	default:
		return true
	}
}

func (w *worker) kill() {
	if w.cmd.Process != nil && w.alive() {
		_ = w.stdin.Close()
		_ = killTree(w.cmd.Process.Pid)
	}
}

// takeWorker gives the chat's running process when it can carry this turn
// (same setup, same session, no cut), or starts one. fresh says it is new.
func takeWorker(chat, name string, args []string, dir string, env []string, session, at, runID string, prep func()) (w *worker, fresh bool, err error) {
	sig := workerSig(name, args, dir, env)
	workers.Lock()
	defer workers.Unlock()
	if old := workers.m[chat]; old != nil {
		old.mu.Lock()
		same := old.alive() && !old.busy && old.sig == sig && at == "" &&
			((session != "" && old.sid == session) || (session == "" && old.warm && old.sid == ""))
		why := ""
		if !same {
			why = fmt.Sprintf("alive=%v busy=%v sameSetup=%v cut=%q session=%q had=%q", old.alive(), old.busy, old.sig == sig, at, session, old.sid)
		}
		old.mu.Unlock()
		if !same {
			log.Printf("chat: new process for %s: %s", chat, why)
		}
		if same {
			old.mu.Lock()
			old.busy, old.used, old.warm = true, time.Now(), false
			old.mu.Unlock()
			return old, false, nil
		}
		old.kill()
		delete(workers.m, chat)
	}
	// room for one more: the longest unused idle one goes
	for len(workers.m) >= workerMax {
		var lru *worker
		for _, x := range workers.m {
			x.mu.Lock()
			idle := !x.busy
			x.mu.Unlock()
			if idle && (lru == nil || x.used.Before(lru.used)) {
				lru = x
			}
		}
		if lru == nil {
			break
		}
		lru.kill()
		delete(workers.m, lru.chat)
	}

	w = &worker{chat: chat, sig: sig, lines: make(chan []byte, 512), dead: make(chan struct{}), sid: session, used: time.Now(), busy: true}
	w.runID = runID
	prep()
	w.ak = &asker{waiting: map[string]chan answer{}, always: map[string]bool{}}
	addAsker(w.runID, w.ak)
	w.cmd = exec.Command(name, args...)
	w.cmd.Dir = dir
	w.cmd.Env = env
	hideWindow(w.cmd)
	w.errw = &limitWriter{w: &w.stderr, n: 8 << 10}
	w.cmd.Stderr = w.errw
	if w.stdin, err = w.cmd.StdinPipe(); err != nil {
		dropAsker(w.runID)
		return nil, false, err
	}
	out, err := w.cmd.StdoutPipe()
	if err != nil {
		dropAsker(w.runID)
		return nil, false, err
	}
	if err = w.cmd.Start(); err != nil {
		dropAsker(w.runID)
		return nil, false, err
	}
	go func() {
		sc := bufio.NewScanner(out)
		sc.Buffer(make([]byte, 64<<10), 32<<20)
		for sc.Scan() {
			if noteSuggest(chat, sc.Bytes()) {
				continue // the next message guessed: kept aside, not part of a turn
			}
			w.lines <- append([]byte(nil), sc.Bytes()...)
		}
		close(w.lines)
		w.werr = w.cmd.Wait()
		dropAsker(w.runID)
		close(w.dead)
		log.Printf("chat: process for %s ended (pid %d)", chat, w.cmd.Process.Pid)
	}()
	workers.m[chat] = w
	return w, true, nil
}

// release marks the turn over; a dead process leaves the table.
func (w *worker) release(session string) {
	w.mu.Lock()
	w.busy, w.used = false, time.Now()
	if session != "" {
		w.sid = session
	}
	w.mu.Unlock()
	if !w.alive() {
		workers.Lock()
		if workers.m[w.chat] == w {
			delete(workers.m, w.chat)
		}
		workers.Unlock()
	}
}

// drop ends a chat's process now (stopped, or on the wrong account).
func dropWorker(w *worker) {
	w.kill()
	workers.Lock()
	if workers.m[w.chat] == w {
		delete(workers.m, w.chat)
	}
	workers.Unlock()
}

// send writes one user message to the process.
func (w *worker) send(q chatReq) error {
	if !q.Warm {
		clearSuggest(w.chat)
	}
	content := []map[string]any{{"type": "text", "text": q.Prompt}}
	for _, im := range q.Images {
		content = append(content, map[string]any{"type": "image", "source": map[string]string{"type": "base64", "media_type": im.Media, "data": im.Data}})
	}
	in := map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": content}}
	if q.uuid != "" {
		in["uuid"] = q.uuid
	}
	b, _ := json.Marshal(in)
	_, err := w.stdin.Write(append(b, '\n'))
	return err
}

// drain drops what a finished turn left unread.
func (w *worker) drain() {
	for {
		select {
		case _, ok := <-w.lines:
			if !ok {
				return
			}
		default:
			return
		}
	}
}

func stopWorkers() {
	workers.Lock()
	defer workers.Unlock()
	for k, w := range workers.m {
		w.kill()
		delete(workers.m, k)
	}
}

// idle chats' processes end after a while; they start again on the next turn
func init() {
	go func() {
		for range time.Tick(time.Minute) {
			workers.Lock()
			for k, w := range workers.m {
				w.mu.Lock()
				old := !w.busy && time.Since(w.used) > workerIdle
				w.mu.Unlock()
				if old || !w.alive() {
					w.kill()
					delete(workers.m, k)
				}
			}
			workers.Unlock()
		}
	}()
}

// workerBusy: the chat's process is in the middle of a turn
func workerBusy(chat string) bool {
	workers.Lock()
	w := workers.m[chat]
	workers.Unlock()
	if w == nil {
		return false
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.busy && w.alive()
}

// dropWorkersIn ends the processes running in a folder (a chat's copy
// about to be removed: Windows won't delete a folder a process stands in)
func dropWorkersIn(dir string) {
	dir = strings.ToLower(filepath.Clean(dir))
	workers.Lock()
	var gone []*worker
	for k, w := range workers.m {
		if w.cmd != nil && strings.ToLower(filepath.Clean(w.cmd.Dir)) == dir {
			gone = append(gone, w)
			delete(workers.m, k)
		}
	}
	workers.Unlock()
	for _, w := range gone {
		w.kill()
	}
	if len(gone) > 0 {
		time.Sleep(400 * time.Millisecond)
	}
}
