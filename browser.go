package main

// Foxpit's browser: a Chromium (Edge, Chrome…) already on the computer, run
// with no window and driven over the DevTools protocol. The page shows a
// tab beside the chat as a live picture (Page.startScreencast) and sends
// the person's mouse and keys back; the agents use the same tab through
// Foxpit's tool server (browser_tools.go). The profile is Foxpit's own and
// stays, so a site signed in to once stays signed in.

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

// ---------- a DevTools connection to one tab ----------

type cdpConn struct {
	ws     *websocket.Conn
	next   int64
	mu     sync.Mutex
	wait   map[int64]chan cdpReply
	onEv   func(method string, params json.RawMessage)
	closed chan struct{}
}

type cdpReply struct {
	Result json.RawMessage
	Err    string
}

func dialCDP(url string, onEv func(string, json.RawMessage)) (*cdpConn, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		return nil, err
	}
	ws.SetReadLimit(64 << 20)
	c := &cdpConn{ws: ws, wait: map[int64]chan cdpReply{}, onEv: onEv, closed: make(chan struct{})}
	go c.read()
	return c, nil
}

func (c *cdpConn) read() {
	defer close(c.closed)
	for {
		_, b, err := c.ws.Read(context.Background())
		if err != nil {
			c.mu.Lock()
			for id, ch := range c.wait {
				ch <- cdpReply{Err: "the browser tab closed"}
				delete(c.wait, id)
			}
			c.mu.Unlock()
			return
		}
		var m struct {
			ID     int64           `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(b, &m) != nil {
			continue
		}
		if m.ID != 0 {
			c.mu.Lock()
			ch := c.wait[m.ID]
			delete(c.wait, m.ID)
			c.mu.Unlock()
			if ch != nil {
				r := cdpReply{Result: m.Result}
				if m.Error != nil {
					r.Err = m.Error.Message
				}
				ch <- r
			}
			continue
		}
		if m.Method != "" && c.onEv != nil {
			c.onEv(m.Method, m.Params)
		}
	}
}

// call sends one DevTools command and waits for its answer
func (c *cdpConn) call(method string, params any, out any) error {
	if params == nil {
		params = map[string]any{}
	}
	id := atomic.AddInt64(&c.next, 1)
	ch := make(chan cdpReply, 1)
	c.mu.Lock()
	c.wait[id] = ch
	c.mu.Unlock()
	b, _ := json.Marshal(map[string]any{"id": id, "method": method, "params": params})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := c.ws.Write(ctx, websocket.MessageText, b); err != nil {
		c.mu.Lock()
		delete(c.wait, id)
		c.mu.Unlock()
		return err
	}
	select {
	case r := <-ch:
		if r.Err != "" {
			return errors.New(r.Err)
		}
		if out != nil && len(r.Result) > 0 {
			return json.Unmarshal(r.Result, out)
		}
		return nil
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.wait, id)
		c.mu.Unlock()
		return fmt.Errorf("%s: the browser did not answer", method)
	}
}

// send is call without waiting (input, screencast acks)
func (c *cdpConn) send(method string, params any) {
	go func() { _ = c.call(method, params, nil) }()
}

// ---------- the browser ----------

type logLine struct {
	Level string `json:"level"` // error, warning, info, log, network
	Text  string `json:"text"`
	At    int64  `json:"at"`
}

type btab struct {
	id      string
	conn    *cdpConn
	mu      sync.Mutex
	url     string
	title   string
	logs    []logLine
	frame   []byte // the last picture, jpeg
	fw, fh  int    // its size in CSS pixels
	view    view
	views   map[*websocket.Conn]context.CancelFunc
	casting bool
	owner   string // the chat run that opened it, when an agent did
	loading bool
}

// view is the size the tab is shown at: a device, or the pane's own size
type view struct {
	W      int     `json:"w"`
	H      int     `json:"h"`
	Mobile bool    `json:"mobile"`
	Scale  float64 `json:"scale"` // device pixel ratio
	Device string  `json:"device"`
}

var browser = struct {
	sync.Mutex
	cmd   *exec.Cmd
	port  int
	tabs  map[string]*btab
	order []string
	byRun map[string]string // chat run → the tab its agent uses
}{tabs: map[string]*btab{}, byRun: map[string]string{}}

// browserExe finds a Chromium on this computer
func browserExe() string {
	if p := os.Getenv("FOXPIT_BROWSER"); p != "" {
		return p
	}
	var list []string
	switch runtime.GOOS {
	case "windows":
		for _, root := range []string{os.Getenv("ProgramFiles(x86)"), os.Getenv("ProgramFiles"), os.Getenv("LOCALAPPDATA")} {
			if root == "" {
				continue
			}
			list = append(list,
				filepath.Join(root, `Microsoft\Edge\Application\msedge.exe`),
				filepath.Join(root, `Google\Chrome\Application\chrome.exe`),
				filepath.Join(root, `BraveSoftware\Brave-Browser\Application\brave.exe`),
				filepath.Join(root, `Chromium\Application\chrome.exe`))
		}
	case "darwin":
		home, _ := os.UserHomeDir()
		for _, app := range []string{"Google Chrome.app/Contents/MacOS/Google Chrome", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"Chromium.app/Contents/MacOS/Chromium", "Brave Browser.app/Contents/MacOS/Brave Browser", "Arc.app/Contents/MacOS/Arc"} {
			list = append(list, "/Applications/"+app, filepath.Join(home, "Applications", app))
		}
	default:
		for _, n := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"} {
			if p, err := exec.LookPath(n); err == nil {
				list = append(list, p)
			}
		}
	}
	for _, p := range list {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	return ""
}

func browserProfile() string {
	dir, err := os.UserCacheDir()
	if err != nil {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "Foxpit", "browser")
}

// browserUp starts the browser once, with no window; call with browser locked
func browserUp() error {
	if browser.cmd != nil && browser.cmd.ProcessState == nil && browser.port != 0 {
		if _, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/json/version", browser.port)); err == nil {
			return nil
		}
	}
	exe := browserExe()
	if exe == "" {
		return errors.New("no Chromium browser found (Edge, Chrome, Brave or Chromium): install one and try again")
	}
	prof := browserProfile()
	_ = os.MkdirAll(prof, 0o755)
	portFile := filepath.Join(prof, "DevToolsActivePort")
	_ = os.Remove(portFile)
	cmd := exec.Command(exe, "--headless=new", "--remote-debugging-port=0", "--remote-allow-origins=*",
		"--user-data-dir="+prof, "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
		"--disable-features=Translate,MediaRouter,OptimizationHints", "--hide-scrollbars=false",
		"--window-size=1280,800", "about:blank")
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("could not start %s: %v", filepath.Base(exe), err)
	}
	tieToApp(cmd)
	go func() { _ = cmd.Wait() }()
	// the browser writes the port it chose
	port := 0
	for i := 0; i < 100 && port == 0; i++ {
		time.Sleep(100 * time.Millisecond)
		if f, err := os.Open(portFile); err == nil {
			sc := bufio.NewScanner(f)
			if sc.Scan() {
				port, _ = strconv.Atoi(strings.TrimSpace(sc.Text()))
			}
			f.Close()
		}
	}
	if port == 0 {
		_ = cmd.Process.Kill()
		return errors.New("the browser started but did not open its DevTools port")
	}
	browser.cmd, browser.port = cmd, port
	browser.tabs, browser.order = map[string]*btab{}, nil
	log.Printf("browser: %s on port %d (pid %d)", filepath.Base(exe), port, cmd.Process.Pid)
	return nil
}

func stopBrowser() {
	browser.Lock()
	defer browser.Unlock()
	if browser.cmd != nil && browser.cmd.Process != nil {
		_ = browser.cmd.Process.Kill()
	}
	browser.cmd, browser.port = nil, 0
}

// openTab opens url in a new tab of Foxpit's browser
func openTab(url, owner string) (*btab, error) {
	url = fixURL(url)
	browser.Lock()
	if err := browserUp(); err != nil {
		browser.Unlock()
		return nil, err
	}
	port := browser.port
	browser.Unlock()
	req, _ := http.NewRequest(http.MethodPut, fmt.Sprintf("http://127.0.0.1:%d/json/new?about:blank", port), nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var t struct {
		ID string `json:"id"`
		WS string `json:"webSocketDebuggerUrl"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&t); err != nil || t.WS == "" {
		return nil, errors.New("the browser did not open a tab")
	}
	tab := &btab{id: t.ID, views: map[*websocket.Conn]context.CancelFunc{}, owner: owner,
		view: view{W: 1280, H: 800, Scale: 1}}
	tab.conn, err = dialCDP(t.WS, tab.event)
	if err != nil {
		return nil, err
	}
	for _, m := range []string{"Page.enable", "Runtime.enable", "Log.enable", "Network.enable"} {
		_ = tab.conn.call(m, nil, nil)
	}
	tab.applyView()
	browser.Lock()
	browser.tabs[tab.id] = tab
	browser.order = append(browser.order, tab.id)
	if owner != "" {
		browser.byRun[owner] = tab.id
	}
	browser.Unlock()
	go func() {
		<-tab.conn.closed
		browser.Lock()
		delete(browser.tabs, tab.id)
		for i, id := range browser.order {
			if id == tab.id {
				browser.order = append(browser.order[:i], browser.order[i+1:]...)
				break
			}
		}
		browser.Unlock()
		tab.broadcast(map[string]any{"t": "closed"})
	}()
	if url != "" {
		_ = tab.navigate(url)
	}
	return tab, nil
}

func getTab(id string) *btab {
	browser.Lock()
	defer browser.Unlock()
	return browser.tabs[id]
}

// fixURL gives a bare address its scheme: localhost:5173 → http://…
func fixURL(u string) string {
	u = strings.TrimSpace(u)
	if u == "" || strings.Contains(u, "://") || strings.HasPrefix(u, "about:") || strings.HasPrefix(u, "data:") {
		return u
	}
	host := strings.SplitN(u, "/", 2)[0]
	if strings.HasPrefix(host, "localhost") || strings.HasPrefix(host, "127.") || strings.HasPrefix(host, "0.0.0.0") || strings.HasPrefix(host, "[::1]") {
		return "http://" + u
	}
	if !strings.Contains(host, ".") {
		return "https://www.google.com/search?q=" + strings.ReplaceAll(u, " ", "+")
	}
	return "https://" + u
}

func (t *btab) navigate(url string) error {
	var r struct {
		ErrorText string `json:"errorText"`
	}
	if err := t.conn.call("Page.navigate", map[string]any{"url": fixURL(url)}, &r); err != nil {
		return err
	}
	if r.ErrorText != "" {
		return errors.New(r.ErrorText)
	}
	return nil
}

// applyView sets the page's size (and a phone's touch and user agent)
func (t *btab) applyView() {
	t.mu.Lock()
	v := t.view
	t.mu.Unlock()
	if v.W < 200 {
		v.W = 200
	}
	if v.H < 200 {
		v.H = 200
	}
	if v.Scale <= 0 {
		v.Scale = 1
	}
	_ = t.conn.call("Emulation.setDeviceMetricsOverride", map[string]any{"width": v.W, "height": v.H,
		"deviceScaleFactor": v.Scale, "mobile": v.Mobile}, nil)
	_ = t.conn.call("Emulation.setTouchEmulationEnabled", map[string]any{"enabled": v.Mobile, "maxTouchPoints": 5}, nil)
	// on a phone the mouse taps, as a finger would
	_ = t.conn.call("Emulation.setEmitTouchEventsForMouse", map[string]any{"enabled": v.Mobile, "configuration": "mobile"}, nil)
	ua := ""
	if v.Mobile {
		ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
		if strings.Contains(strings.ToLower(v.Device), "pixel") || strings.Contains(strings.ToLower(v.Device), "galaxy") || strings.Contains(strings.ToLower(v.Device), "samsung") {
			ua = "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36"
		}
	}
	_ = t.conn.call("Emulation.setUserAgentOverride", map[string]any{"userAgent": ua}, nil)
	t.mu.Lock()
	casting := t.casting
	t.mu.Unlock()
	if casting { // the picture's size changes with it
		t.stopCast()
		t.startCast()
	}
}

func (t *btab) startCast() {
	t.mu.Lock()
	if t.casting {
		t.mu.Unlock()
		return
	}
	t.casting = true
	v := t.view
	t.mu.Unlock()
	w, h := int(float64(v.W)*v.Scale), int(float64(v.H)*v.Scale)
	if w > 2400 {
		h, w = h*2400/w, 2400
	}
	_ = t.conn.call("Page.startScreencast", map[string]any{"format": "jpeg", "quality": 80, "maxWidth": w, "maxHeight": h, "everyNthFrame": 1}, nil)
}

func (t *btab) stopCast() {
	t.mu.Lock()
	t.casting = false
	t.mu.Unlock()
	_ = t.conn.call("Page.stopScreencast", nil, nil)
}

// shot is a fresh picture of the page, png
func (t *btab) shot() ([]byte, error) {
	var r struct {
		Data string `json:"data"`
	}
	if err := t.conn.call("Page.captureScreenshot", map[string]any{"format": "png"}, &r); err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(r.Data)
}

// eval runs JavaScript in the page and gives its value as JSON
func (t *btab) eval(js string) (json.RawMessage, error) {
	var r struct {
		Result struct {
			Value       json.RawMessage `json:"value"`
			Description string          `json:"description"`
			Type        string          `json:"type"`
		} `json:"result"`
		Exc *struct {
			Text      string `json:"text"`
			Exception struct {
				Description string `json:"description"`
			} `json:"exception"`
		} `json:"exceptionDetails"`
	}
	if err := t.conn.call("Runtime.evaluate", map[string]any{"expression": js, "returnByValue": true, "awaitPromise": true, "userGesture": true}, &r); err != nil {
		return nil, err
	}
	if r.Exc != nil {
		msg := r.Exc.Exception.Description
		if msg == "" {
			msg = r.Exc.Text
		}
		return nil, errors.New(msg)
	}
	if len(r.Result.Value) == 0 {
		b, _ := json.Marshal(cmpOr(r.Result.Description, r.Result.Type))
		return b, nil
	}
	return r.Result.Value, nil
}

func (t *btab) addLog(l logLine) {
	l.At = time.Now().UnixMilli()
	l.Text = clip(l.Text, 2000)
	t.mu.Lock()
	t.logs = append(t.logs, l)
	if len(t.logs) > 300 {
		t.logs = t.logs[len(t.logs)-300:]
	}
	t.mu.Unlock()
	t.broadcast(map[string]any{"t": "log", "log": l})
}

// event is one DevTools event from the tab
func (t *btab) event(method string, p json.RawMessage) {
	switch method {
	case "Page.screencastFrame":
		var f struct {
			Data      string `json:"data"`
			SessionID int    `json:"sessionId"`
			Meta      struct {
				W float64 `json:"deviceWidth"`
				H float64 `json:"deviceHeight"`
			} `json:"metadata"`
		}
		if json.Unmarshal(p, &f) != nil {
			return
		}
		t.conn.send("Page.screencastFrameAck", map[string]any{"sessionId": f.SessionID})
		b, err := base64.StdEncoding.DecodeString(f.Data)
		if err != nil {
			return
		}
		t.mu.Lock()
		t.frame, t.fw, t.fh = b, int(f.Meta.W), int(f.Meta.H)
		t.mu.Unlock()
		t.broadcastFrame(b, int(f.Meta.W), int(f.Meta.H))
	case "Page.frameNavigated":
		var f struct {
			Frame struct {
				ParentID string `json:"parentId"`
				URL      string `json:"url"`
			} `json:"frame"`
		}
		if json.Unmarshal(p, &f) == nil && f.Frame.ParentID == "" {
			t.mu.Lock()
			t.url = f.Frame.URL
			t.mu.Unlock()
			go t.sendState()
		}
	case "Page.loadEventFired", "Page.domContentEventFired":
		t.mu.Lock()
		t.loading = false
		t.mu.Unlock()
		go t.sendState()
	case "Page.frameStartedLoading":
		t.mu.Lock()
		t.loading = true
		t.mu.Unlock()
		go t.sendState()
	case "Runtime.consoleAPICalled":
		var c struct {
			Type string `json:"type"`
			Args []struct {
				Value       any    `json:"value"`
				Description string `json:"description"`
			} `json:"args"`
		}
		if json.Unmarshal(p, &c) != nil {
			return
		}
		var parts []string
		for _, a := range c.Args {
			if a.Value != nil {
				if s, ok := a.Value.(string); ok {
					parts = append(parts, s)
				} else {
					b, _ := json.Marshal(a.Value)
					parts = append(parts, string(b))
				}
			} else {
				parts = append(parts, a.Description)
			}
		}
		lv := c.Type
		if lv == "warning" {
			lv = "warning"
		} else if lv != "error" {
			lv = "log"
		}
		t.addLog(logLine{Level: lv, Text: strings.Join(parts, " ")})
	case "Runtime.exceptionThrown":
		var e struct {
			D struct {
				Text      string `json:"text"`
				URL       string `json:"url"`
				Line      int    `json:"lineNumber"`
				Exception struct {
					Description string `json:"description"`
				} `json:"exception"`
			} `json:"exceptionDetails"`
		}
		if json.Unmarshal(p, &e) == nil {
			msg := cmpOr(e.D.Exception.Description, e.D.Text)
			if e.D.URL != "" {
				msg += fmt.Sprintf(" (%s:%d)", e.D.URL, e.D.Line+1)
			}
			t.addLog(logLine{Level: "error", Text: msg})
		}
	case "Log.entryAdded":
		var e struct {
			Entry struct {
				Level string `json:"level"`
				Text  string `json:"text"`
				URL   string `json:"url"`
			} `json:"entry"`
		}
		if json.Unmarshal(p, &e) == nil && (e.Entry.Level == "error" || e.Entry.Level == "warning") {
			t.addLog(logLine{Level: e.Entry.Level, Text: strings.TrimSpace(e.Entry.Text + " " + e.Entry.URL)})
		}
	case "Network.responseReceived":
		var r struct {
			Type     string `json:"type"`
			Response struct {
				URL    string `json:"url"`
				Status int    `json:"status"`
			} `json:"response"`
		}
		if json.Unmarshal(p, &r) == nil && r.Response.Status >= 400 {
			t.addLog(logLine{Level: "network", Text: fmt.Sprintf("%d %s", r.Response.Status, r.Response.URL)})
		}
	case "Network.loadingFailed":
		var r struct {
			Err      string `json:"errorText"`
			Canceled bool   `json:"canceled"`
		}
		if json.Unmarshal(p, &r) == nil && !r.Canceled {
			t.addLog(logLine{Level: "network", Text: "failed: " + r.Err})
		}
	}
}

func (t *btab) state() map[string]any {
	var h struct {
		Current int `json:"currentIndex"`
		Entries []struct {
			Title string `json:"title"`
		} `json:"entries"`
	}
	_ = t.conn.call("Page.getNavigationHistory", nil, &h)
	title := ""
	if h.Current >= 0 && h.Current < len(h.Entries) {
		title = h.Entries[h.Current].Title
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if title != "" {
		t.title = title
	}
	errs, warns := 0, 0
	for _, l := range t.logs {
		if l.Level == "error" {
			errs++
		} else if l.Level == "warning" || l.Level == "network" {
			warns++
		}
	}
	return map[string]any{"t": "state", "id": t.id, "url": t.url, "title": t.title, "loading": t.loading,
		"back": h.Current > 0, "forward": h.Current >= 0 && h.Current < len(h.Entries)-1, "view": t.view,
		"errors": errs, "warnings": warns, "agent": t.owner != ""}
}

func (t *btab) sendState() { t.broadcast(t.state()) }

func (t *btab) broadcast(v any) {
	b, _ := json.Marshal(v)
	t.mu.Lock()
	var list []*websocket.Conn
	for ws := range t.views {
		list = append(list, ws)
	}
	t.mu.Unlock()
	for _, ws := range list {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_ = ws.Write(ctx, websocket.MessageText, b)
		cancel()
	}
}

// a picture goes as binary: 4 bytes width, 4 height (CSS px), then the jpeg
func (t *btab) broadcastFrame(jpg []byte, w, h int) {
	msg := make([]byte, 8+len(jpg))
	putU32(msg[0:], w)
	putU32(msg[4:], h)
	copy(msg[8:], jpg)
	t.mu.Lock()
	var list []*websocket.Conn
	for ws := range t.views {
		list = append(list, ws)
	}
	t.mu.Unlock()
	for _, ws := range list {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_ = ws.Write(ctx, websocket.MessageBinary, msg)
		cancel()
	}
}

func putU32(b []byte, v int) {
	b[0], b[1], b[2], b[3] = byte(v>>24), byte(v>>16), byte(v>>8), byte(v)
}

// ---------- the page's side: a live view and input ----------

type viewMsg struct {
	T       string  `json:"t"`
	Type    string  `json:"type"`
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Button  string  `json:"button"`
	Buttons int     `json:"buttons"`
	Clicks  int     `json:"clicks"`
	Mods    int     `json:"mods"`
	DX      float64 `json:"dx"`
	DY      float64 `json:"dy"`
	Key     string  `json:"key"`
	Code    string  `json:"code"`
	Text    string  `json:"text"`
	KeyCode int     `json:"keyCode"`
	URL     string  `json:"url"`
	View    *view   `json:"view"`
}

func browserViewHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t := getTab(r.URL.Query().Get("tab"))
		if t == nil {
			http.Error(w, "no such tab", http.StatusNotFound)
			return
		}
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		ws.SetReadLimit(1 << 20)
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		t.mu.Lock()
		t.views[ws] = cancel
		frame, fw, fh := t.frame, t.fw, t.fh
		t.mu.Unlock()
		defer func() {
			t.mu.Lock()
			delete(t.views, ws)
			left := len(t.views)
			t.mu.Unlock()
			if left == 0 {
				t.stopCast()
			}
			ws.Close(websocket.StatusNormalClosure, "")
		}()
		b, _ := json.Marshal(t.state())
		_ = ws.Write(ctx, websocket.MessageText, b)
		t.mu.Lock()
		logs := append([]logLine(nil), t.logs...)
		t.mu.Unlock()
		b, _ = json.Marshal(map[string]any{"t": "logs", "logs": logs})
		_ = ws.Write(ctx, websocket.MessageText, b)
		if len(frame) > 0 {
			msg := make([]byte, 8+len(frame))
			putU32(msg[0:], fw)
			putU32(msg[4:], fh)
			copy(msg[8:], frame)
			_ = ws.Write(ctx, websocket.MessageBinary, msg)
		}
		t.startCast()
		for {
			_, b, err := ws.Read(ctx)
			if err != nil {
				return
			}
			var m viewMsg
			if json.Unmarshal(b, &m) != nil {
				continue
			}
			t.input(m)
		}
	})
}

func (t *btab) input(m viewMsg) {
	c := t.conn
	switch m.T {
	case "mouse":
		p := map[string]any{"type": m.Type, "x": m.X, "y": m.Y, "modifiers": m.Mods, "buttons": m.Buttons}
		if m.Type == "mouseWheel" {
			p["deltaX"], p["deltaY"] = m.DX, m.DY
		} else {
			p["button"] = cmpOr(m.Button, "none")
			if m.Clicks > 0 {
				p["clickCount"] = m.Clicks
			}
		}
		c.send("Input.dispatchMouseEvent", p)
	case "touch":
		// a phone's page reads touches: a tap is a touch start and end
		pts := []map[string]any{{"x": m.X, "y": m.Y}}
		if m.Type == "touchEnd" {
			pts = []map[string]any{}
		}
		c.send("Input.dispatchTouchEvent", map[string]any{"type": m.Type, "touchPoints": pts, "modifiers": m.Mods})
	case "key":
		p := map[string]any{"type": m.Type, "key": m.Key, "code": m.Code, "modifiers": m.Mods,
			"windowsVirtualKeyCode": m.KeyCode, "nativeVirtualKeyCode": m.KeyCode}
		if m.Text != "" {
			p["text"], p["unmodifiedText"] = m.Text, m.Text
		}
		c.send("Input.dispatchKeyEvent", p)
	case "text":
		c.send("Input.insertText", map[string]any{"text": m.Text})
	case "nav":
		go func() { _ = t.navigate(m.URL) }()
	case "back", "forward":
		go t.history(m.T == "back")
	case "reload":
		c.send("Page.reload", map[string]any{})
	case "stop":
		c.send("Page.stopLoading", map[string]any{})
	case "view":
		if m.View != nil {
			t.mu.Lock()
			t.view = *m.View
			t.mu.Unlock()
			go func() { t.applyView(); t.sendState() }()
		}
	case "clearlogs":
		t.mu.Lock()
		t.logs = nil
		t.mu.Unlock()
		go t.sendState()
	}
}

func (t *btab) history(back bool) {
	var h struct {
		Current int `json:"currentIndex"`
		Entries []struct {
			ID int `json:"id"`
		} `json:"entries"`
	}
	if t.conn.call("Page.getNavigationHistory", nil, &h) != nil {
		return
	}
	i := h.Current + 1
	if back {
		i = h.Current - 1
	}
	if i >= 0 && i < len(h.Entries) {
		_ = t.conn.call("Page.navigateToHistoryEntry", map[string]any{"entryId": h.Entries[i].ID}, nil)
	}
}

// ---------- the page's calls ----------

func browserRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/project/browser/tabs", func(w http.ResponseWriter, r *http.Request) {
		browser.Lock()
		var out []map[string]any
		for _, id := range browser.order {
			if t := browser.tabs[id]; t != nil {
				t.mu.Lock()
				out = append(out, map[string]any{"id": t.id, "url": t.url, "title": t.title, "agent": t.owner != ""})
				t.mu.Unlock()
			}
		}
		browser.Unlock()
		writeJSON(w, 200, map[string]any{"tabs": out, "found": browserExe() != ""})
	})
	mux.HandleFunc("POST /api/project/browser/open", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			URL string `json:"url"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&in)
		t, err := openTab(cmpOr(in.URL, "about:blank"), "")
		if err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, 200, map[string]string{"id": t.id})
	})
	mux.HandleFunc("POST /api/project/browser/close", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			ID string `json:"id"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&in)
		browser.Lock()
		port := browser.port
		browser.Unlock()
		if port != 0 && in.ID != "" && !strings.ContainsAny(in.ID, "/?#") {
			if resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d/json/close/%s", port, in.ID)); err == nil {
				resp.Body.Close()
			}
		}
		w.WriteHeader(http.StatusNoContent)
	})
	// the page's picture now, for marking what is wrong
	mux.HandleFunc("GET /api/project/browser/shot", func(w http.ResponseWriter, r *http.Request) {
		t := getTab(r.URL.Query().Get("tab"))
		if t == nil {
			http.NotFound(w, r)
			return
		}
		b, err := t.shot()
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "image/png")
		w.Header().Set("Cache-Control", "no-store")
		_, _ = w.Write(b)
	})
	// DevTools for the tab, in a browser window of its own
	mux.HandleFunc("POST /api/project/browser/devtools", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			ID string `json:"id"`
		}
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&in)
		browser.Lock()
		port := browser.port
		browser.Unlock()
		if getTab(in.ID) == nil || port == 0 {
			http.NotFound(w, r)
			return
		}
		u := fmt.Sprintf("http://127.0.0.1:%d/devtools/inspector.html?ws=127.0.0.1:%d/devtools/page/%s", port, port, in.ID)
		if err := openDevtools(u); err != nil {
			writeJSON(w, 500, map[string]string{"error": err.Error()})
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

// openDevtools shows the DevTools page in a window: the same browser, but
// a real window of it, as an app (no tabs, no address bar)
var openDevtools = func(u string) error {
	exe := browserExe()
	if exe == "" {
		return openURL(u)
	}
	dir := filepath.Join(browserProfile() + "-devtools")
	cmd := exec.Command(exe, "--app="+u, "--user-data-dir="+dir, "--no-first-run", "--no-default-browser-check", "--window-size=1100,760")
	if err := cmd.Start(); err != nil {
		return openURL(u)
	}
	tieToApp(cmd)
	go func() { _ = cmd.Wait() }()
	return nil
}
