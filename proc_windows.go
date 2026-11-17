//go:build windows

package main

import (
	"fmt"
	"log"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const createNoWindow = 0x08000000

// fixPath: Windows apps get the full user PATH already
func fixPath() {}

// waitGone waits up to max for process pid to end
func waitGone(pid int, max time.Duration) {
	h, err := syscall.OpenProcess(syscall.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return // gone already
	}
	defer syscall.CloseHandle(h)
	_, _ = syscall.WaitForSingleObject(h, uint32(max/time.Millisecond))
}

// hideWindow keeps a console child from flashing a window.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

// consoleCmd runs bin in a console window of its own, shown, that stays
// open at the end (press a key) so a failed sign-in can be read. "start"
// opens it: a child Go starts itself gets NUL for its input and output, so
// it could neither print the sign-in's words nor read a pasted code.
func consoleCmd(title, bin string, args ...string) *exec.Cmd {
	line := `"` + bin + `"`
	for _, a := range args {
		line += " " + a
	}
	cmd := exec.Command("cmd.exe")
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CmdLine:       `cmd.exe /c start "` + title + `" cmd.exe /c ` + line + ` ^& echo. ^& pause`,
		CreationFlags: createNoWindow,
	}
	return cmd
}

// killTree ends a process and everything it started: magpie.com hands the
// work to a magpie.exe child, which a plain Kill would leave running.
func killTree(pid int) error {
	cmd := exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(pid))
	hideWindow(cmd)
	return cmd.Run()
}

// linkDir makes a directory junction (no admin right needed).
func linkDir(from, to string) error {
	cmd := exec.Command("cmd", "/c", "mklink", "/J", to, from)
	hideWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

var (
	user32     = syscall.NewLazyDLL("user32.dll")
	keybdEvent = user32.NewProc("keybd_event")
)

// startDictation opens Windows voice typing (Win+H) for the focused field.
func startDictation() error {
	const vkLWin, vkH, keyUp = 0x5B, 0x48, 0x0002
	for _, k := range [][2]uintptr{{vkLWin, 0}, {vkH, 0}, {vkH, keyUp}, {vkLWin, keyUp}} {
		keybdEvent.Call(k[0], 0, k[1], 0)
	}
	return nil
}

// detach: the process lives on after Foxpit closes (the updater)
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008} // DETACHED_PROCESS
}

// openURL shows a web page in the person's browser
func openURL(u string) error {
	cmd := exec.Command("rundll32", "url.dll,FileProtocolHandler", u)
	hideWindow(cmd)
	return cmd.Start()
}

// tieToApp puts a child Foxpit started (Magpie's gateway, its window app)
// in a job that Windows closes with Foxpit: however Foxpit ends (quit, a
// crash, Task Manager), the child ends too instead of running on unseen.
var appJob = func() windows.Handle {
	j, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		log.Printf("job: %v", err)
		return 0
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(j, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		log.Printf("job: limits: %v", err)
		windows.CloseHandle(j)
		return 0
	}
	return j
}()

func tieToApp(cmd *exec.Cmd) {
	if appJob == 0 || cmd.Process == nil {
		return
	}
	h, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		log.Printf("job: open %d: %v", cmd.Process.Pid, err)
		return
	}
	defer windows.CloseHandle(h)
	if err := windows.AssignProcessToJobObject(appJob, h); err != nil {
		log.Printf("job: assign %d: %v", cmd.Process.Pid, err)
	}
}
