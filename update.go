package main

// Updates. An installed Foxpit (setup's Programs\FoxpitApp, or a Foxpit.app
// it may write over) asks GitHub for a newer release: tags "app-vX.Y.Z"
// carrying FoxpitSetup-X.Y.Z.exe and Foxpit-X.Y.Z-mac-<apple-silicon|intel>.zip.
// The page asks for a check soon after start and every half hour (Settings ›
// About can turn that off); the file for this computer downloads in the
// background, must match its SHA-256 (GitHub's asset digest, or a
// <file>.sha256 beside it), and goes in place at once (update_apply.go): the
// next start is the new version, and "Restart to update" starts it now.
// The chats are in the user's config folder, so they carry over untouched.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

var version = "dev" // set by build.ps1 (-X main.version=)

const updateRepo = "lordon1a/foxpit-app"

// quitApp closes the window app; set in main (nil in --dev-http)
var quitApp func()

type updState struct {
	Current   string `json:"current"`
	Installed bool   `json:"installed"` // runs from setup's folder, so it can update
	State     string `json:"state"`     // idle, checking, downloading, ready, error
	Latest    string `json:"latest,omitempty"`
	Notes     string `json:"notes,omitempty"`
	Error     string `json:"error,omitempty"`
	Checked   int64  `json:"checked,omitempty"` // unix ms of the last finished check
	Got       int64  `json:"got,omitempty"`     // bytes downloaded
	Size      int64  `json:"size,omitempty"`
	applied   string // the version put in place this run: the next start runs it
}

var upd = struct {
	sync.Mutex
	s updState
}{s: updState{State: "idle"}}

func updFeed() string {
	if f := os.Getenv("FOXPIT_UPDATE_FEED"); f != "" {
		return f
	}
	return "https://api.github.com/repos/" + updateRepo + "/releases?per_page=30"
}

func updInstalled() bool {
	if os.Getenv("FOXPIT_UPDATE_FEED") != "" {
		return true // a test feed: act as installed
	}
	if runtime.GOOS == "darwin" {
		return startBundle != "" && writable(filepath.Dir(startBundle))
	}
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	want := filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "FoxpitApp")
	return strings.EqualFold(filepath.Clean(filepath.Dir(exe)), filepath.Clean(want))
}

func updSnapshot() updState {
	upd.Lock()
	defer upd.Unlock()
	s := upd.s
	s.Current, s.Installed = version, updInstalled()
	return s
}

func updSet(f func(s *updState)) {
	upd.Lock()
	f(&upd.s)
	upd.Unlock()
}

// parseVer: "app-v1.2.3" or "1.2.3" → [1 2 3]
func parseVer(v string) ([3]int, bool) {
	var out [3]int
	v = strings.TrimPrefix(strings.TrimPrefix(v, "app-"), "v")
	parts := strings.SplitN(v, ".", 3)
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(strings.SplitN(p, "-", 2)[0])
		if err != nil {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

func newer(a, b [3]int) bool {
	for i := range a {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return false
}

type ghAsset struct {
	Name   string `json:"name"`
	URL    string `json:"browser_download_url"`
	Digest string `json:"digest"`
	Size   int64  `json:"size"`
}

type ghRelease struct {
	Tag        string    `json:"tag_name"`
	Draft      bool      `json:"draft"`
	Prerelease bool      `json:"prerelease"`
	Body       string    `json:"body"`
	Assets     []ghAsset `json:"assets"`
}

var updClient = &http.Client{Timeout: 10 * time.Minute}

func updGet(url string) (*http.Response, error) {
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("User-Agent", "Foxpit/"+version)
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := updClient.Do(req)
	if err == nil && resp.StatusCode != 200 {
		resp.Body.Close()
		return nil, fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
	}
	return resp, err
}

// updCheck looks for a newer release and, if there is one, downloads it
func updCheck() {
	cur, ok := parseVer(version)
	if !ok || !updInstalled() {
		return
	}
	upd.Lock()
	if upd.s.State == "checking" || upd.s.State == "downloading" {
		upd.Unlock()
		return
	}
	upd.s.State, upd.s.Error = "checking", ""
	upd.Unlock()
	err := func() error {
		resp, err := updGet(updFeed())
		if err != nil {
			return err
		}
		var rels []ghRelease
		err = json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&rels)
		resp.Body.Close()
		if err != nil {
			return fmt.Errorf("the release list did not read: %v", err)
		}
		var best *ghRelease
		var bestV [3]int
		for i := range rels {
			r := &rels[i]
			v, ok := parseVer(r.Tag)
			if r.Draft || r.Prerelease || !strings.HasPrefix(r.Tag, "app-v") || !ok || !newer(v, cur) {
				continue
			}
			if best == nil || newer(v, bestV) {
				best, bestV = r, v
			}
		}
		if best == nil {
			updSet(func(s *updState) { s.State, s.Latest, s.Notes = "idle", "", "" })
			return nil
		}
		ver := fmt.Sprintf("%d.%d.%d", bestV[0], bestV[1], bestV[2])
		upd.Lock()
		done := upd.s.applied == ver
		upd.Unlock()
		if done { // in place already: waiting for a restart
			updSet(func(s *updState) { s.State, s.Latest = "ready", ver })
			return nil
		}
		name := updAsset(ver)
		var setup, sum *ghAsset
		for i := range best.Assets {
			switch best.Assets[i].Name {
			case name:
				setup = &best.Assets[i]
			case name + ".sha256":
				sum = &best.Assets[i]
			}
		}
		if setup == nil {
			return fmt.Errorf("release %s has no %s", best.Tag, name)
		}
		want := strings.TrimPrefix(setup.Digest, "sha256:")
		if want == "" && sum != nil {
			r, err := updGet(sum.URL)
			if err != nil {
				return err
			}
			b, _ := io.ReadAll(io.LimitReader(r.Body, 4096))
			r.Body.Close()
			if f := strings.Fields(string(b)); len(f) > 0 {
				want = f[0]
			}
		}
		if len(want) != 64 {
			return fmt.Errorf("release %s has no SHA-256 for %s", best.Tag, name)
		}
		dir := filepath.Join(os.TempDir(), "FoxpitUpdate")
		_ = os.MkdirAll(dir, 0o755)
		path := filepath.Join(dir, name)
		notes := clip(best.Body, 4000)
		put := func() error {
			updSet(func(s *updState) { s.State, s.Latest, s.Notes = "installing", ver, notes })
			if err := updApply(path); err != nil {
				return fmt.Errorf("the update did not go in: %v", err)
			}
			_ = os.Remove(path)
			updSet(func(s *updState) { s.State, s.applied = "ready", ver })
			log.Printf("update: %s is in place; the next start runs it", ver)
			return nil
		}
		// already here from an earlier check
		if have, err := fileSum(path); err == nil && strings.EqualFold(have, want) {
			return put()
		}
		updSet(func(s *updState) {
			s.State, s.Latest, s.Notes, s.Got, s.Size = "downloading", ver, clip(best.Body, 4000), 0, setup.Size
		})
		r, err := updGet(setup.URL)
		if err != nil {
			return err
		}
		defer r.Body.Close()
		f, err := os.Create(path + ".part")
		if err != nil {
			return err
		}
		h := sha256.New()
		buf := make([]byte, 256<<10)
		for {
			n, rerr := r.Body.Read(buf)
			if n > 0 {
				if _, err := f.Write(buf[:n]); err != nil {
					f.Close()
					return err
				}
				h.Write(buf[:n])
				updSet(func(s *updState) { s.Got += int64(n) })
			}
			if rerr == io.EOF {
				break
			}
			if rerr != nil {
				f.Close()
				return rerr
			}
		}
		f.Close()
		if got := hex.EncodeToString(h.Sum(nil)); !strings.EqualFold(got, want) {
			os.Remove(path + ".part")
			return errors.New("the downloaded update did not match its checksum, so it was thrown away")
		}
		_ = os.Remove(path)
		if err := os.Rename(path+".part", path); err != nil {
			return err
		}
		return put()
	}()
	updSet(func(s *updState) {
		s.Checked = time.Now().UnixMilli()
		if err != nil {
			log.Printf("update: %v", err)
			s.State, s.Error = "error", err.Error()
		}
	})
}

func fileSum(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func updateHandler(w http.ResponseWriter, r *http.Request) {
	if o := r.Header.Get("Origin"); o != "" && r.Method == http.MethodPost && !fromPage(o) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	switch {
	case r.URL.Path == "/api/update" && r.Method == http.MethodGet:
	case r.URL.Path == "/api/update/check" && r.Method == http.MethodPost:
		go updCheck()
		time.Sleep(150 * time.Millisecond) // so the answer already says "checking"
	case r.URL.Path == "/api/update/install" && r.Method == http.MethodPost:
		s := updSnapshot()
		if s.State != "ready" {
			http.Error(w, "No update is ready.", http.StatusConflict)
			return
		}
		if err := updRestart(); err != nil {
			http.Error(w, "Foxpit did not restart: "+err.Error(), http.StatusInternalServerError)
			return
		}
		log.Printf("update: restarting into %s", s.Latest)
		go func() {
			time.Sleep(400 * time.Millisecond)
			if quitApp != nil {
				quitApp()
				return
			}
			stopWorkers()
			os.Exit(0)
		}()
	default:
		http.NotFound(w, r)
		return
	}
	writeJSON(w, http.StatusOK, updSnapshot())
}
