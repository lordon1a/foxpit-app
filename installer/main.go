// Foxpit's installer: one exe that carries foxpit.exe inside it.
//
//	FoxpitSetup.exe                 install for this Windows user (no admin):
//	                                %LOCALAPPDATA%\Programs\FoxpitApp, Start menu and
//	                                desktop shortcuts, an entry in Apps, then open it
//	FoxpitSetup.exe --update <pid>  what the app runs for an update: wait for that
//	                                Foxpit to close, put the new one in, open it
//	uninstall.exe --uninstall       Apps › Foxpit › Uninstall (chats and settings stay)
package main

import (
	_ "embed"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

//go:embed payload/foxpit.exe
var payload []byte

// Magpie (accounts and the model gateway) comes with Foxpit: nothing else
// to install. Foxpit looks for it in magpie\magpie.exe next to itself.
//
//go:embed payload/magpie.exe
var magpiePayload []byte

var version = "dev" // set by build.ps1

const (
	appName = "Foxpit"
	// FoxpitApp, not Foxpit: the Electron Foxpit (0.1.x) installs to
	// Programs\Foxpit with a Foxpit.exe, which this would overwrite
	folder = "FoxpitApp"
	regKey = `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\FoxpitApp`
	noWin  = 0x08000000 // CREATE_NO_WINDOW
	detach = 0x00000008 // DETACHED_PROCESS
)

func main() {
	args := os.Args[1:]
	var err error
	switch {
	case len(args) >= 1 && args[0] == "--uninstall":
		err = uninstall(len(args) >= 2 && args[1] == "--quiet")
	case len(args) >= 2 && args[0] == "--update":
		pid, _ := strconv.Atoi(args[1])
		err = install(pid, false)
	case len(args) >= 1 && args[0] == "--apply":
		// a running Foxpit put its update in place: the files step aside
		// (Windows lets a running exe be renamed), the next start is the
		// new version; no window, no launch, the exit code is the answer
		applying = true
		if err = install(0, false); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	default:
		err = install(0, true)
	}
	if err != nil {
		msg(appName+" setup", err.Error(), 0x10)
		os.Exit(1)
	}
}

// FOXPIT_SETUP_TEST=<folder>: a dry run for checks. Everything lands in that
// folder (and a FoxpitAppTest key), and nothing is opened.
var testRoot = os.Getenv("FOXPIT_SETUP_TEST")

// applying: --apply, from a running Foxpit (see main)
var applying bool

func key() string {
	if testRoot != "" {
		return regKey + "Test"
	}
	return regKey
}

func installDir() string {
	if testRoot != "" {
		return filepath.Join(testRoot, "Programs", folder)
	}
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", folder)
}

func install(waitPID int, fresh bool) error {
	dir := installDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("Could not make %s: %v", dir, err)
	}
	exe := filepath.Join(dir, "foxpit.exe")
	if waitPID > 0 {
		waitExit(waitPID, 20*time.Second)
	} else if !applying && running(exe) {
		return errors.New("Foxpit is open. Close it, then run setup again.")
	}
	if err := putExe(exe, payload); err != nil {
		return err
	}
	if len(magpiePayload) > 0 {
		_ = os.MkdirAll(filepath.Join(dir, "magpie"), 0o755)
		if err := putExe(filepath.Join(dir, "magpie", "magpie.exe"), magpiePayload); err != nil {
			return err
		}
	}
	// the uninstaller is this same program
	if self, err := os.Executable(); err == nil {
		if b, err := os.ReadFile(self); err == nil {
			_ = os.WriteFile(filepath.Join(dir, "uninstall.exe"), b, 0o755)
		}
	}
	register(dir, exe)
	if fresh {
		shortcut(filepath.Join(startMenu(), appName+".lnk"), exe, dir)
		if desk := desktop(); desk != "" {
			shortcut(filepath.Join(desk, appName+".lnk"), exe, dir)
		}
	}
	if testRoot != "" || applying {
		return nil
	}
	cmd := exec.Command(exe)
	cmd.Dir = dir
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: detach}
	return cmd.Start()
}

// putExe writes the new foxpit.exe. A running copy can't be overwritten on
// Windows but can be renamed, so the old one steps aside first.
func putExe(exe string, data []byte) error {
	old := exe + ".old"
	_ = os.Remove(old)
	if _, err := os.Stat(exe); err == nil {
		var last error
		for i := 0; i < 40; i++ { // a closing Foxpit may hold it a moment longer
			if last = os.Rename(exe, old); last == nil {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
		if last != nil {
			return errors.New("Foxpit is still open. Close it and run setup again.")
		}
	}
	if err := os.WriteFile(exe+".new", data, 0o755); err != nil {
		return fmt.Errorf("Could not write Foxpit: %v", err)
	}
	return os.Rename(exe+".new", exe)
}

func register(dir, exe string) {
	size := strconv.Itoa((len(payload)+len(magpiePayload))/1024 + 1)
	vals := [][3]string{
		{"DisplayName", "REG_SZ", appName},
		{"DisplayVersion", "REG_SZ", version},
		{"Publisher", "REG_SZ", appName},
		{"DisplayIcon", "REG_SZ", exe},
		{"InstallLocation", "REG_SZ", dir},
		{"UninstallString", "REG_SZ", `"` + filepath.Join(dir, "uninstall.exe") + `" --uninstall`},
		{"QuietUninstallString", "REG_SZ", `"` + filepath.Join(dir, "uninstall.exe") + `" --uninstall --quiet`},
		{"URLInfoAbout", "REG_SZ", "https://github.com/lordon1a/foxpit-app"},
		{"EstimatedSize", "REG_DWORD", size},
		{"NoModify", "REG_DWORD", "1"},
		{"NoRepair", "REG_DWORD", "1"},
	}
	for _, v := range vals {
		run("reg.exe", "add", key(), "/v", v[0], "/t", v[1], "/d", v[2], "/f")
	}
}

func uninstall(quiet bool) error {
	dir := installDir()
	if !quiet && msg("Uninstall "+appName, "Remove Foxpit from this computer?\n\nYour chats and settings stay, so a later install picks up where you left off.", 0x24) != 6 {
		return nil
	}
	if running(filepath.Join(dir, "foxpit.exe")) {
		return errors.New("Foxpit is open. Close it, then uninstall again.")
	}
	_ = os.Remove(filepath.Join(startMenu(), appName+".lnk"))
	if desk := desktop(); desk != "" {
		_ = os.Remove(filepath.Join(desk, appName+".lnk"))
	}
	run("reg.exe", "delete", key(), "/f")
	// this exe lives in the folder: a detached shell removes the folder once it exits
	cmd := exec.Command("cmd.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CmdLine:       `cmd.exe /c ping -n 3 127.0.0.1 >nul & rmdir /s /q "` + dir + `"`,
		CreationFlags: noWin | detach,
	}
	return cmd.Start()
}

func startMenu() string {
	if testRoot != "" {
		return filepath.Join(testRoot, "StartMenu")
	}
	return filepath.Join(os.Getenv("APPDATA"), `Microsoft\Windows\Start Menu\Programs`)
}

func desktop() string {
	if testRoot != "" {
		return filepath.Join(testRoot, "Desktop")
	}
	// from Windows itself: PowerShell's output comes back in the console's
	// code page, which turns "Masaüstü" into another folder's name
	p, err := windows.KnownFolderPath(windows.FOLDERID_Desktop, 0)
	if err != nil {
		return ""
	}
	return p
}

func shortcut(lnk, target, dir string) {
	_ = os.MkdirAll(filepath.Dir(lnk), 0o755)
	q := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	ps := "$s=(New-Object -ComObject WScript.Shell).CreateShortcut(" + q(lnk) + ");$s.TargetPath=" + q(target) +
		";$s.WorkingDirectory=" + q(dir) + ";$s.IconLocation=" + q(target+",0") + ";$s.Description='All your coding agents, one window';$s.Save()"
	run("powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps)
}

func run(name string, args ...string) {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: noWin}
	_ = cmd.Run()
}

// running: is a foxpit.exe from this folder open?
func running(exe string) bool {
	out, err := exec.Command("powershell.exe", "-NoProfile", "-Command",
		"(Get-Process foxpit -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '"+strings.ReplaceAll(exe, "'", "''")+"' }).Count").Output()
	return err == nil && strings.TrimSpace(string(out)) != "0" && strings.TrimSpace(string(out)) != ""
}

var (
	kernel32 = syscall.NewLazyDLL("kernel32.dll")
	user32   = syscall.NewLazyDLL("user32.dll")
)

func waitExit(pid int, max time.Duration) {
	const synchronize = 0x00100000
	h, _, _ := kernel32.NewProc("OpenProcess").Call(synchronize, 0, uintptr(pid))
	if h == 0 {
		return // already gone
	}
	defer kernel32.NewProc("CloseHandle").Call(h)
	kernel32.NewProc("WaitForSingleObject").Call(h, uintptr(max.Milliseconds()))
}

// msg shows a Windows message box and returns the button pressed (6 = Yes).
func msg(title, text string, flags uintptr) int {
	t, _ := syscall.UTF16PtrFromString(title)
	b, _ := syscall.UTF16PtrFromString(text)
	r, _, _ := user32.NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(b)), uintptr(unsafe.Pointer(t)), flags)
	return int(r)
}
