// Foxpit: the desktop shell. Magpie runs beside it as the gateway (accounts,
// model routing, quotas); this app is only the window and its interface.
package main

import (
	"embed"
	"encoding/json"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

//go:embed all:frontend
var frontend embed.FS

func main() {
	assets, err := fs.Sub(frontend, "frontend")
	if err != nil {
		log.Fatal(err)
	}

	afterArg()
	fixPath()

	// a windowed exe has no console: keep the log in a file
	if dir, err := os.UserCacheDir(); err == nil {
		_ = os.MkdirAll(filepath.Join(dir, "Foxpit"), 0o755)
		if f, err := os.OpenFile(filepath.Join(dir, "Foxpit", "foxpit.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644); err == nil {
			log.SetOutput(f)
		}
	}

	go updCleanup()
	magpie := NewMagpie()
	// start the gateway early, so the first screen has its numbers
	go func() {
		if err := magpie.Ensure(); err != nil {
			log.Printf("magpie: %v", err)
		}
	}()
	api := magpie.Routes()
	stream, err := NewStreamServer()
	if err != nil {
		log.Fatal(err)
	}
	stream.Handle("/term", termHandler())
	stream.Handle("/browser", browserViewHandler())
	defer stopBrowser()
	stream.Handle("/chat", chatHandler(magpie))
	stream.Handle("/mcp", approveHandler())
	askBase, askKey = stream.URL, stream.Token
	// the window app, once there is one: the folder dialog needs it
	var app *application.App
	projects := projectRoutes(func() (string, error) {
		if app == nil {
			return "", os.ErrInvalid
		}
		d := app.Dialog.OpenFile().CanChooseDirectories(true).CanChooseFiles(false).SetTitle("Open a project folder")
		if w := app.Window.Current(); w != nil {
			d = d.AttachToWindow(w)
		}
		return d.PromptForSingleSelection()
	})
	pickFiles = func(dir string) ([]string, error) {
		if app == nil {
			return nil, os.ErrInvalid
		}
		d := app.Dialog.OpenFile().CanChooseFiles(true).SetTitle("Attach files")
		if dir != "" {
			d = d.SetDirectory(dir)
		}
		if w := app.Window.Current(); w != nil {
			d = d.AttachToWindow(w)
		}
		return d.PromptForMultipleSelection()
	}
	// /api/* is Foxpit's own backend; everything else is the page
	withAPI := func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/backend" {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Cache-Control", "no-store")
				_ = json.NewEncoder(w).Encode(map[string]string{"url": stream.URL, "key": stream.Token})
				return
			}
			if r.URL.Path == "/api/voice/dictate" && r.Method == http.MethodPost {
				if err := startDictation(); err != nil {
					http.Error(w, "Voice typing is a Windows feature.", http.StatusNotImplemented)
					return
				}
				w.WriteHeader(http.StatusNoContent)
				return
			}
			if r.URL.Path == "/api/update" || strings.HasPrefix(r.URL.Path, "/api/update/") {
				updateHandler(w, r)
				return
			}
			if r.URL.Path == "/api/state" {
				stateHandler(w, r)
				return
			}
			if strings.HasPrefix(r.URL.Path, "/api/project/") {
				projects.ServeHTTP(w, r)
				return
			}
			if strings.HasPrefix(r.URL.Path, "/api/") {
				api.ServeHTTP(w, r)
				return
			}
			next.ServeHTTP(w, r)
		})
	}

	// --dev-http <addr>: the same page and API in a browser, with no window,
	// for checks that must not touch the desktop
	if len(os.Args) == 3 && os.Args[1] == "--dev-http" {
		defer magpie.Stop()
		defer stopWorkers()
		log.Printf("foxpit: dev page on http://%s", os.Args[2])
		pageOrigins = append(pageOrigins, "http://"+os.Args[2])
		log.Fatal(http.ListenAndServe(os.Args[2], withAPI(http.FileServerFS(assets))))
	}

	app = application.New(application.Options{
		Name:        "Foxpit",
		Description: "All your coding agents, one window",
		Assets: application.AssetOptions{
			Handler:    application.AssetFileServerFS(assets),
			Middleware: withAPI,
		},
		OnShutdown: func() { stopWorkers(); stopBrowser(); magpie.Stop() },
	})

	quitApp = app.Quit
	win := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:             "main",
		Title:            "Foxpit",
		Width:            1440,
		Height:           900,
		MinWidth:         1100,
		MinHeight:        680,
		URL:              "/",
		BackgroundColour: application.NewRGB(12, 13, 15),
		// the title bar is the page's own (index.html .titlebar); on a Mac
		// the page runs under a hidden title bar and keeps the native
		// close/minimise/zoom buttons (html.mac in the page makes room)
		Frameless: runtime.GOOS != "darwin",
		Mac: application.MacWindow{
			TitleBar:                application.MacTitleBarHiddenInset,
			InvisibleTitleBarHeight: 38,
		},
		// files dropped on the chat (#panes, data-file-drop-target): the page
		// reads pictures and videos, the paths come in for everything else
		EnableFileDrop: true,
		Windows: application.WindowsWindow{
			Theme: application.Dark,
		},
	})

	win.OnWindowEvent(events.Common.WindowFilesDropped, func(e *application.WindowEvent) {
		noteDropped(e.Context().DroppedFiles())
	})

	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}
