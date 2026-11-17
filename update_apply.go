package main

// Putting an update in place, the way Magpie does it: the new build is
// downloaded and checked, then swapped in at once while this copy keeps
// running, so the next start is the new version whether the person
// restarts now ("Restart to update") or just quits and opens Foxpit later.
//
// Windows: the setup runs with --apply. A running exe can be renamed, so
// foxpit.exe and magpie\magpie.exe step aside as .old and the new ones go in.
// Mac: the zip is unpacked beside Foxpit.app in a hidden .foxpit-update
// folder, its signature checked, and the bundles renamed: the running app
// moves to .foxpit-update/old (it keeps going from there), the new one takes
// its place. Neither staged name ends in .app, so macOS never takes them
// for a second Foxpit.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// startBundle is the Foxpit.app this process started from ("" off a Mac or
// outside a bundle): read once, as the bundle moves when an update goes in
var startBundle = macBundle()

func macBundle() string {
	if runtime.GOOS != "darwin" {
		return ""
	}
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if r, err := filepath.EvalSymlinks(exe); err == nil {
		exe = r
	}
	i := strings.Index(exe, ".app/Contents/MacOS/")
	if i < 0 {
		return ""
	}
	return exe[:i+len(".app")]
}

// writable: may Foxpit change what is in dir
func writable(dir string) bool {
	f, err := os.CreateTemp(dir, ".foxpit-w-*")
	if err != nil {
		return false
	}
	f.Close()
	os.Remove(f.Name())
	return true
}

// macKind names the Mac zip for this computer's processor
func macKind() string {
	if runtime.GOARCH == "arm64" {
		return "apple-silicon"
	}
	return "intel"
}

// updAsset is the file of release ver this computer installs
func updAsset(ver string) string {
	if runtime.GOOS == "darwin" {
		return "Foxpit-" + ver + "-mac-" + macKind() + ".zip"
	}
	return "FoxpitSetup-" + ver + ".exe"
}

func stagingDir(bundle string) string {
	return filepath.Join(filepath.Dir(bundle), ".foxpit-update")
}

// updApply puts the downloaded, checked file in place
func updApply(file string) error {
	if runtime.GOOS == "darwin" {
		return macSwap(file, startBundle)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, file, "--apply")
	hideWindow(cmd)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	if err := cmd.Run(); err != nil {
		if t := strings.TrimSpace(out.String()); t != "" {
			return errors.New(t)
		}
		return fmt.Errorf("setup: %v", err)
	}
	return nil
}

func macSwap(zip, bundle string) error {
	if bundle == "" {
		return errors.New("Foxpit is not running from Foxpit.app")
	}
	dir := stagingDir(bundle)
	_ = os.RemoveAll(dir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	fail := func(err error) error { _ = os.RemoveAll(dir); return err }
	out := filepath.Join(dir, "unzip")
	if b, err := exec.Command("ditto", "-x", "-k", zip, out).CombinedOutput(); err != nil {
		return fail(fmt.Errorf("unzip: %v: %s", err, bytes.TrimSpace(b)))
	}
	staged := filepath.Join(dir, "payload")
	if err := os.Rename(filepath.Join(out, "Foxpit.app"), staged); err != nil {
		return fail(errors.New("the update has no Foxpit.app in it"))
	}
	_ = os.RemoveAll(out)
	if b, err := exec.Command("codesign", "--verify", "--deep", "--strict", staged).CombinedOutput(); err != nil {
		return fail(fmt.Errorf("the update's signature is broken: %s", bytes.TrimSpace(b)))
	}
	if id := bundleID(staged); id != bundleID(bundle) {
		return fail(fmt.Errorf("the update is %q, not Foxpit", id))
	}
	// signed by the same certificate as this Foxpit (its designated
	// requirement names it); a build signed ad hoc, before Foxpit had one,
	// takes the first signed update on the bundle id alone
	if have := designated(bundle); have != "" && !strings.Contains(have, "cdhash") {
		if got := designated(staged); got != have {
			return fail(errors.New("the update is not signed by Foxpit's certificate"))
		}
	}
	_ = exec.Command("xattr", "-dr", "com.apple.quarantine", staged).Run()
	old := filepath.Join(dir, "old")
	if err := os.Rename(bundle, old); err != nil {
		return fail(err)
	}
	if err := os.Rename(staged, bundle); err != nil {
		_ = os.Rename(old, bundle) // put it back
		return fail(err)
	}
	return nil
}

// designated is an app's designated requirement as codesign states it
func designated(app string) string {
	b, err := exec.Command("codesign", "-d", "-r-", app).CombinedOutput()
	if err != nil {
		return ""
	}
	for _, l := range strings.Split(string(b), "\n") {
		if i := strings.Index(l, "designated => "); i >= 0 {
			return strings.TrimSpace(l[i+len("designated => "):])
		}
	}
	return ""
}

func bundleID(app string) string {
	b, err := os.ReadFile(filepath.Join(app, "Contents", "Info.plist"))
	if err != nil {
		return ""
	}
	s := string(b)
	i := strings.Index(s, "<key>CFBundleIdentifier</key>")
	if i < 0 {
		return ""
	}
	s = s[i:]
	a, z := strings.Index(s, "<string>"), strings.Index(s, "</string>")
	if a < 0 || z < a {
		return ""
	}
	return strings.TrimSpace(s[a+len("<string>") : z])
}

// updRestart opens the new version once this process has ended
func updRestart() error {
	pid := strconv.Itoa(os.Getpid())
	if runtime.GOOS == "darwin" {
		if startBundle == "" {
			return errors.New("Foxpit is not running from Foxpit.app")
		}
		return exec.Command("open", "-n", startBundle, "--args", "--after", pid).Start()
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(filepath.Join(filepath.Dir(exe), "foxpit.exe"), "--after", pid)
	cmd.Dir = filepath.Dir(exe)
	detach(cmd)
	return cmd.Start()
}

// afterArg: started by updRestart with --after <pid>: wait for that Foxpit to
// end (its Magpie and ports with it) before this one starts
func afterArg() {
	if len(os.Args) < 3 || os.Args[1] != "--after" {
		return
	}
	pid, _ := strconv.Atoi(os.Args[2])
	os.Args = append(os.Args[:1], os.Args[3:]...)
	if pid > 0 {
		waitGone(pid, 20*time.Second)
	}
}

// updCleanup removes what the last update set aside
func updCleanup() {
	time.Sleep(5 * time.Second)
	if startBundle != "" {
		_ = os.RemoveAll(stagingDir(startBundle))
		return
	}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		for _, f := range []string{"foxpit.exe.old", filepath.Join("magpie", "magpie.exe.old")} {
			_ = os.Remove(filepath.Join(dir, f))
		}
	}
}
