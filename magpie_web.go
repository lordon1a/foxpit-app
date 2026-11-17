package main

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Magpie's own window, inside Foxpit: `magpie web` serves the whole app
// (agents, sessions, library, providers, routing, gateway, usage, masking,
// plugins, settings) on loopback. Its sign-in is a cookie, which a page in
// an app frame can't carry, so Foxpit puts a small proxy in front that adds
// the key itself and only lets Foxpit's page frame it.

var pageOrigins = []string{"http://wails.localhost", "https://wails.localhost", "wails://localhost"}

type magpieWeb struct {
	mu     sync.Mutex
	cmd    *exec.Cmd
	proxy  string
	ln     net.Listener
	target *url.URL
	key    string
}

var mpWeb magpieWeb

func freePort() (string, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	defer ln.Close()
	return ln.Addr().String(), nil
}

func randomKey() string {
	b := make([]byte, 24)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

// webURL starts Magpie's web app and its proxy once, and gives the address
// Foxpit's page frames.
func (m *Magpie) webURL() (string, error) {
	mpWeb.mu.Lock()
	defer mpWeb.mu.Unlock()
	if mpWeb.proxy != "" && mpWeb.cmd != nil && mpWeb.cmd.ProcessState == nil {
		return mpWeb.proxy, nil
	}
	if m.path == "" {
		return "", errors.New("Magpie is not installed")
	}
	addr, err := freePort()
	if err != nil {
		return "", err
	}
	key := randomKey()
	cmd := exec.Command(m.path, "web", "--addr", addr, "--no-open")
	cmd.Env = append(os.Environ(), "MAGPIE_WEB_KEY="+key)
	hideWindow(cmd)
	if err := cmd.Start(); err != nil {
		return "", errors.New("Magpie's window did not start: " + err.Error())
	}
	tieToApp(cmd)
	go func() { _ = cmd.Wait() }()
	log.Printf("magpie: web app on %s (pid %d)", addr, cmd.Process.Pid)
	target, _ := url.Parse("http://" + addr)
	cookie := "magpie_web_" + target.Port() + "=" + key
	// up when it answers with the key
	ready := false
	cl := &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	for deadline := time.Now().Add(25 * time.Second); time.Now().Before(deadline); time.Sleep(300 * time.Millisecond) {
		req, _ := http.NewRequest("GET", target.String()+"/", nil)
		req.Header.Set("Cookie", cookie)
		if res, err := cl.Do(req); err == nil {
			res.Body.Close()
			if res.StatusCode < 400 {
				ready = true
				break
			}
		}
	}
	if !ready {
		_ = killTree(cmd.Process.Pid)
		return "", errors.New("Magpie's window did not answer")
	}

	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.Host = target.Host
			pr.Out.Header.Set("Cookie", cookie)
			if pr.Out.Header.Get("Origin") != "" {
				pr.Out.Header.Set("Origin", target.Scheme+"://"+target.Host)
			}
			pr.Out.Header.Del("Referer")
			// pages come back plain, for the skin to go in
			pr.Out.Header.Del("Accept-Encoding")
		},
		ModifyResponse: func(res *http.Response) error {
			res.Header.Del("Set-Cookie")
			res.Header.Del("X-Frame-Options")
			res.Header.Set("Content-Security-Policy", "frame-ancestors "+strings.Join(frameAncestors(), " "))
			return skinPage(res)
		},
		FlushInterval: -1,
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = killTree(cmd.Process.Pid)
		return "", err
	}
	srv := &http.Server{Handler: guardFrame(withSkin(rp)), ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	if mpWeb.ln != nil {
		_ = mpWeb.ln.Close()
	}
	mpWeb.cmd, mpWeb.ln, mpWeb.target, mpWeb.key = cmd, ln, target, key
	mpWeb.proxy = "http://" + ln.Addr().String() + "/"
	return mpWeb.proxy, nil
}

func frameAncestors() []string {
	return append([]string{"'self'"}, pageOrigins...)
}

func fromPage(ref string) bool {
	u, err := url.Parse(ref)
	if err != nil || u.Host == "" {
		return false
	}
	o := u.Scheme + "://" + u.Host
	for _, p := range pageOrigins {
		if o == p {
			return true
		}
	}
	return false
}

// guardFrame: the frame's own requests, and Foxpit's page opening it; a
// page elsewhere in a browser gets nothing
func guardFrame(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		site, dest := r.Header.Get("Sec-Fetch-Site"), r.Header.Get("Sec-Fetch-Dest")
		ok := site == "" || site == "same-origin" || site == "none"
		if !ok && dest == "iframe" {
			ref := r.Header.Get("Referer")
			ok = ref == "" || fromPage(ref)
		}
		if !ok && fromPage(r.Header.Get("Origin")) {
			ok = true
		}
		if !ok {
			http.Error(w, "Magpie opens inside Foxpit.", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// stopWeb ends Magpie's web app with Foxpit
func stopMagpieWeb() {
	mpWeb.mu.Lock()
	defer mpWeb.mu.Unlock()
	if mpWeb.ln != nil {
		_ = mpWeb.ln.Close()
	}
	if mpWeb.cmd != nil && mpWeb.cmd.Process != nil && mpWeb.cmd.ProcessState == nil {
		_ = killTree(mpWeb.cmd.Process.Pid)
	}
	mpWeb.cmd, mpWeb.ln, mpWeb.proxy = nil, nil, ""
}

// Magpie's pages wear Foxpit's skin: its colours and type, its header left
// to Foxpit's tabs (frontend/mpskin). Magpie's own code runs unchanged.
const skinTags = `<link rel="stylesheet" href="/__foxpit/skin.css"><script src="/__foxpit/skin.js" defer></script>`

func skinPage(res *http.Response) error {
	if !strings.HasPrefix(res.Header.Get("Content-Type"), "text/html") || res.Header.Get("Content-Encoding") != "" {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, 16<<20))
	_ = res.Body.Close()
	if err != nil {
		return err
	}
	page := string(body)
	if i := strings.Index(strings.ToLower(page), "</head>"); i >= 0 {
		page = page[:i] + skinTags + page[i:]
	}
	res.Body = io.NopCloser(strings.NewReader(page))
	res.ContentLength = int64(len(page))
	res.Header.Set("Content-Length", strconv.Itoa(len(page)))
	return nil
}

func withSkin(next http.Handler) http.Handler {
	sub, _ := fs.Sub(frontend, "frontend/mpskin")
	files := http.StripPrefix("/__foxpit/", http.FileServerFS(sub))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/__foxpit/") {
			w.Header().Set("Cache-Control", "no-store")
			files.ServeHTTP(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// libRoutes: Foxpit's own Library tab asks Magpie's library the same
// questions Magpie's page does (/api/library/…), through the web app
// Foxpit already runs, so installing, linking and removing stay Magpie's code.
func (m *Magpie) libRoutes(mux *http.ServeMux, writeJSON func(http.ResponseWriter, int, any)) {
	cl := &http.Client{Timeout: 5 * time.Minute}
	mux.HandleFunc("/api/mplib/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			http.Error(w, "GET or POST", http.StatusMethodNotAllowed)
			return
		}
		if _, err := m.webURL(); err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		mpWeb.mu.Lock()
		target, key := mpWeb.target, mpWeb.key
		mpWeb.mu.Unlock()
		rest := strings.TrimPrefix(r.URL.Path, "/api/mplib/")
		u := target.String() + "/api/library"
		if rest != "" {
			u += "/" + rest
		}
		if r.URL.RawQuery != "" {
			u += "?" + r.URL.RawQuery
		}
		req, err := http.NewRequestWithContext(r.Context(), r.Method, u, io.LimitReader(r.Body, 4<<20))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		req.Header.Set("Cookie", "magpie_web_"+target.Port()+"="+key)
		req.Header.Set("Content-Type", "application/json")
		if r.Method == http.MethodPost {
			req.Header.Set("Origin", target.Scheme+"://"+target.Host)
		}
		res, err := cl.Do(req)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Magpie did not answer: " + err.Error()})
			return
		}
		defer res.Body.Close()
		w.Header().Set("Content-Type", res.Header.Get("Content-Type"))
		w.WriteHeader(res.StatusCode)
		_, _ = io.Copy(w, res.Body)
	})
}
