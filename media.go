package main

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Files the user handed over: dropped on the window or picked in the
// attach dialog. The page reads dropped pictures and videos itself; other
// files go in as @paths, which only the native side knows. A file the user
// handed over may be served back (a picked video plays in the chat); nothing
// else outside the project is.
var handed = struct {
	sync.Mutex
	seq   int
	files []string
	ok    map[string]bool
	wake  chan struct{}
}{ok: map[string]bool{}, wake: make(chan struct{})}

func allowFiles(files []string) {
	handed.Lock()
	for _, f := range files {
		if abs, err := filepath.Abs(f); err == nil {
			handed.ok[strings.ToLower(abs)] = true
		}
	}
	handed.Unlock()
}

// noteDropped is the window's FilesDropped event.
func noteDropped(files []string) {
	allowFiles(files)
	handed.Lock()
	handed.seq++
	handed.files = append([]string(nil), files...)
	close(handed.wake)
	handed.wake = make(chan struct{})
	handed.Unlock()
}

var mediaTypes = map[string]string{
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
	".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".ogv": "video/ogg",
}

var mediaName = regexp.MustCompile(`^[0-9a-f]{16}\.(png|jpg|gif|webp)$`)

func mediaDir() string {
	dir, err := os.UserCacheDir()
	if err != nil {
		dir = os.TempDir()
	}
	return filepath.Join(dir, "Foxpit", "media")
}

func mediaRoutes(mux *http.ServeMux) {
	// the paths of the last drop: ?after=N waits (up to 3s) for a drop newer than N
	mux.HandleFunc("GET /api/project/dropped", func(w http.ResponseWriter, r *http.Request) {
		after, err := strconv.Atoi(r.URL.Query().Get("after"))
		if err != nil {
			after = -1
		}
		deadline := time.After(3 * time.Second)
		for {
			handed.Lock()
			seq, files, wake := handed.seq, handed.files, handed.wake
			handed.Unlock()
			if after < 0 || seq > after {
				if after < 0 {
					files = nil
				}
				writeJSON(w, 200, map[string]any{"seq": seq, "files": files})
				return
			}
			select {
			case <-wake:
			case <-deadline:
				writeJSON(w, 200, map[string]any{"seq": seq, "files": []string{}})
				return
			case <-r.Context().Done():
				return
			}
		}
	})
	// a chat's pictures at full size (one sent, or one a tool showed): the
	// saved chat keeps a small preview, the picture itself lives in Foxpit's
	// cache folder by its hash and opens from there
	mux.HandleFunc("POST /api/project/media", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Media string `json:"media"`
			Data  string `json:"data"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<20)).Decode(&in) != nil {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		ext := map[string]string{"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}[in.Media]
		b, err := base64.StdEncoding.DecodeString(in.Data)
		if ext == "" || err != nil || len(b) == 0 {
			http.Error(w, "bad", http.StatusBadRequest)
			return
		}
		sum := sha256.Sum256(b)
		name := hex.EncodeToString(sum[:8]) + ext
		dir := mediaDir()
		_ = os.MkdirAll(dir, 0o755)
		p := filepath.Join(dir, name)
		if _, err := os.Stat(p); err != nil {
			if err := os.WriteFile(p, b, 0o644); err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
		}
		writeJSON(w, 200, map[string]string{"url": "/api/project/media/" + name})
	})
	mux.HandleFunc("GET /api/project/media/{name}", func(w http.ResponseWriter, r *http.Request) {
		name := r.PathValue("name")
		ct := mediaTypes[strings.ToLower(filepath.Ext(name))]
		if !mediaName.MatchString(name) || ct == "" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Cache-Control", "max-age=31536000, immutable")
		http.ServeFile(w, r, filepath.Join(mediaDir(), name))
	})
	// a picture or video the user handed over, by its full path
	mux.HandleFunc("GET /api/project/local", func(w http.ResponseWriter, r *http.Request) {
		abs, err := filepath.Abs(r.URL.Query().Get("path"))
		ct := mediaTypes[strings.ToLower(filepath.Ext(abs))]
		handed.Lock()
		ok := handed.ok[strings.ToLower(abs)]
		handed.Unlock()
		if err != nil || !ok || ct == "" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", ct)
		w.Header().Set("Cache-Control", "no-store")
		http.ServeFile(w, r, abs)
	})
}
