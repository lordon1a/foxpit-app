package main

// The agents' side of Foxpit's browser: tools on Foxpit's tool server
// (approve.go), so any model can open a page in the tab the person watches
// beside the chat, read it, click, type and look at it.

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

func btool(name, desc string, props map[string]any, req ...string) map[string]any {
	s := map[string]any{"type": "object", "properties": props}
	if len(req) > 0 {
		s["required"] = req
	}
	return map[string]any{"name": name, "description": desc, "inputSchema": s}
}

func str(desc string) map[string]string {
	return map[string]string{"type": "string", "description": desc}
}

var browserTools = []map[string]any{
	btool("browser_open", "Open a web page in Foxpit's browser, a real Chromium tab the person sees live beside this chat and can use too (their sign-ins stay in it). "+
		"Use it to check a web app you run (a dev server: localhost:5173…) or any site. It returns the page's outline: its text and the clickable things, each with a [ref] for browser_click / browser_type. "+
		"After the first call, this chat's tab is reused; use browser_navigate to go elsewhere.",
		map[string]any{"url": str("The address: http://localhost:5173, example.com, …")}, "url"),
	btool("browser_navigate", "Go to an address in this chat's Foxpit browser tab, or back / forward / reload. Returns the page's outline.",
		map[string]any{"url": str("An address, or one of: back, forward, reload")}, "url"),
	btool("browser_snapshot", "Read the page in this chat's Foxpit browser tab now: title, address, its text and the clickable and typable things, each with a [ref].",
		map[string]any{}),
	btool("browser_click", "Click something on the page, by the [ref] from the last outline (or by its visible text). Returns the page's outline after.",
		map[string]any{"ref": str("The number in [ref] from the outline"), "text": str("Or: the visible text of what to click")}),
	btool("browser_type", "Type into a field on the page (by [ref]); what it held is replaced. submit presses Enter after.",
		map[string]any{"ref": str("The field's [ref] from the outline"), "text": str("What to type"),
			"submit": map[string]string{"type": "boolean", "description": "Press Enter after typing"}}, "ref", "text"),
	btool("browser_press", "Press a key in the page: Enter, Tab, Escape, Backspace, ArrowDown, PageDown, …, or a letter with a modifier like Control+a.",
		map[string]any{"key": str("The key")}, "key"),
	btool("browser_scroll", "Scroll the page (or the element with ref) by a number of pixels; negative goes up.",
		map[string]any{"dy": map[string]string{"type": "number", "description": "Pixels down (negative: up)"}, "ref": str("Optional: an element to scroll inside")}, "dy"),
	btool("browser_screenshot", "See the page as the person sees it now: a picture of this chat's Foxpit browser tab.", map[string]any{}),
	btool("browser_console", "The page's console errors, warnings and failed network requests since it opened (or since the last clear).",
		map[string]any{"clear": map[string]string{"type": "boolean", "description": "Empty the list after reading"}}),
	btool("browser_eval", "Run JavaScript in the page and get its value (JSON). For reading state the outline does not show.",
		map[string]any{"expression": str("A JavaScript expression; it may await")}, "expression"),
	btool("browser_resize", "Show the page at a device's size (\"iPhone 15\", \"Pixel 7\", \"iPad Air\", \"desktop\") or at width × height.",
		map[string]any{"device": str("A device name, or desktop"), "width": map[string]string{"type": "number"}, "height": map[string]string{"type": "number"}}),
}

func isBrowserTool(name string) bool { return strings.HasPrefix(name, "browser_") }

// the devices the size menu and the tool know (Traycer's list, MIT)
var devices = []struct {
	Name  string
	W, H  int
	Phone bool
}{
	{"iPhone SE", 375, 667, true}, {"iPhone 12 Pro", 390, 844, true}, {"iPhone 15", 393, 852, true}, {"iPhone 14 Pro Max", 430, 932, true},
	{"Pixel 7", 412, 915, true}, {"Samsung Galaxy S20 Ultra", 412, 915, true}, {"Galaxy Z Fold 5", 344, 882, true},
	{"iPad Mini", 768, 1024, true}, {"iPad Air", 820, 1180, true}, {"iPad Pro", 1024, 1366, true}, {"Surface Pro 7", 912, 1368, true},
}

// tabFor is the tab this chat's agent uses, opened when asked
func tabFor(run string, open bool) (*btab, error) {
	browser.Lock()
	id := browser.byRun[run]
	browser.Unlock()
	if t := getTab(id); t != nil {
		return t, nil
	}
	if !open {
		return nil, errors.New("no page is open for this chat yet: call browser_open first")
	}
	return openTab("about:blank", run)
}

// callBrowserTool runs one browser tool; the answer is MCP content
func callBrowserTool(run, name string, args json.RawMessage) ([]map[string]string, bool) {
	text := func(s string) []map[string]string { return []map[string]string{{"type": "text", "text": s}} }
	var in struct {
		URL        string  `json:"url"`
		Ref        any     `json:"ref"`
		Text       string  `json:"text"`
		Submit     bool    `json:"submit"`
		Key        string  `json:"key"`
		DY         float64 `json:"dy"`
		Clear      bool    `json:"clear"`
		Expression string  `json:"expression"`
		Device     string  `json:"device"`
		Width      int     `json:"width"`
		Height     int     `json:"height"`
	}
	_ = json.Unmarshal(args, &in)
	ref := ""
	switch v := in.Ref.(type) {
	case string:
		ref = strings.Trim(strings.TrimSpace(v), "[]")
	case float64:
		ref = strconv.Itoa(int(v))
	}
	t, err := tabFor(run, name == "browser_open")
	if err != nil {
		return text(err.Error()), true
	}
	fail := func(err error) ([]map[string]string, bool) { return text(err.Error()), true }
	switch name {
	case "browser_open", "browser_navigate":
		u := strings.TrimSpace(in.URL)
		switch strings.ToLower(u) {
		case "back", "forward":
			t.history(strings.EqualFold(u, "back"))
		case "reload":
			_ = t.conn.call("Page.reload", nil, nil)
		case "":
			return text("Give a url."), true
		default:
			if err := t.navigate(u); err != nil {
				return fail(fmt.Errorf("could not open %s: %v", u, err))
			}
		}
		t.settle(15 * time.Second)
		out := t.outline()
		if name == "browser_open" {
			out = "Opened in Foxpit's browser; the person can watch it beside the chat. [foxpit-tab:" + t.id + "]\n\n" + out
		}
		return text(out), false
	case "browser_snapshot":
		return text(t.outline()), false
	case "browser_click":
		if err := t.clickRef(ref, in.Text); err != nil {
			return fail(err)
		}
		t.settle(5 * time.Second)
		return text(t.outline()), false
	case "browser_type":
		if err := t.typeRef(ref, in.Text, in.Submit); err != nil {
			return fail(err)
		}
		if in.Submit {
			t.settle(8 * time.Second)
		}
		return text(t.outline()), false
	case "browser_press":
		t.press(in.Key)
		time.Sleep(300 * time.Millisecond)
		return text(t.outline()), false
	case "browser_scroll":
		js := fmt.Sprintf(`(()=>{const el=%s; (el||window).scrollBy(0,%f); return true})()`, refExpr(ref), in.DY)
		if _, err := t.eval(js); err != nil {
			return fail(err)
		}
		time.Sleep(250 * time.Millisecond)
		return text(t.outline()), false
	case "browser_screenshot":
		b, err := t.shot()
		if err != nil {
			return fail(err)
		}
		return []map[string]string{{"type": "image", "data": base64.StdEncoding.EncodeToString(b), "mimeType": "image/png"}}, false
	case "browser_console":
		t.mu.Lock()
		logs := append([]logLine(nil), t.logs...)
		if in.Clear {
			t.logs = nil
		}
		t.mu.Unlock()
		if len(logs) == 0 {
			return text("The console is empty: no errors, warnings or failed requests."), false
		}
		var sb strings.Builder
		for _, l := range logs {
			fmt.Fprintf(&sb, "%s  %s\n", strings.ToUpper(l.Level), l.Text)
		}
		return text(clip(sb.String(), 20000)), false
	case "browser_eval":
		v, err := t.eval(in.Expression)
		if err != nil {
			return fail(err)
		}
		return text(clip(string(v), 20000)), false
	case "browser_resize":
		v := view{W: 1280, H: 800, Scale: 1, Device: "Desktop"}
		d := strings.ToLower(strings.TrimSpace(in.Device))
		if in.Width > 0 && in.Height > 0 {
			v = view{W: in.Width, H: in.Height, Scale: 1, Mobile: in.Width < 800, Device: fmt.Sprintf("%d × %d", in.Width, in.Height)}
		} else if d != "" && d != "desktop" {
			found := false
			for _, dv := range devices {
				if strings.Contains(strings.ToLower(dv.Name), d) || strings.Contains(d, strings.ToLower(dv.Name)) {
					v, found = view{W: dv.W, H: dv.H, Scale: 2, Mobile: dv.Phone, Device: dv.Name}, true
					break
				}
			}
			if !found {
				return text("Unknown device. Known: iPhone SE, iPhone 12 Pro, iPhone 15, iPhone 14 Pro Max, Pixel 7, iPad Mini, iPad Air, iPad Pro, desktop; or give width and height."), true
			}
		}
		t.mu.Lock()
		t.view = v
		t.mu.Unlock()
		t.applyView()
		t.sendState()
		time.Sleep(400 * time.Millisecond)
		return text("The page is now shown at " + v.Device + ".\n\n" + t.outline()), false
	}
	return text("unknown browser tool"), true
}

// settle waits for the page to finish loading, and a moment more
func (t *btab) settle(max time.Duration) {
	end := time.Now().Add(max)
	for time.Now().Before(end) {
		v, err := t.eval(`document.readyState`)
		if err == nil && string(v) == `"complete"` {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	time.Sleep(300 * time.Millisecond)
}

func refExpr(ref string) string {
	if ref == "" {
		return "null"
	}
	b, _ := json.Marshal(ref)
	return `document.querySelector('[data-fx-ref="'+` + string(b) + `+'"]')`
}

// outlineJS marks what can be clicked or typed into with data-fx-ref and
// writes the page as lines
const outlineJS = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0"; };
  const act = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=option],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  let n = 0; const lines = []; const seen = new Set();
  document.querySelectorAll("[data-fx-ref]").forEach((e) => e.removeAttribute("data-fx-ref"));
  const name = (el) => (el.getAttribute("aria-label") || el.innerText || el.value || el.placeholder || el.title || el.alt || el.name || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const walk = (el) => {
    if (!(el instanceof Element) || !vis(el)) return;
    const tag = el.tagName.toLowerCase();
    if (["script", "style", "noscript", "svg", "template"].includes(tag)) return;
    if (el.matches(act)) {
      n++; el.setAttribute("data-fx-ref", String(n));
      const role = el.getAttribute("role") || (tag === "a" ? "link" : tag === "input" ? "input " + (el.type || "text") : tag);
      let extra = "";
      if (tag === "input" || tag === "textarea") extra = el.value ? ' value="' + String(el.value).slice(0, 60) + '"' : (el.placeholder ? ' placeholder="' + el.placeholder.slice(0, 60) + '"' : "");
      if (tag === "select") extra = ' value="' + (el.options[el.selectedIndex] || {}).text + '"';
      if (el.checked) extra += " checked";
      if (el.disabled) extra += " disabled";
      if (tag === "a") extra += " -> " + (el.getAttribute("href") || "").slice(0, 80);
      lines.push("[" + n + "] " + role + ' "' + name(el) + '"' + extra);
      seen.add(el);
      if (tag !== "div" && tag !== "span" && tag !== "li") return;
    }
    if (/^h[1-6]$/.test(tag)) { lines.push("#".repeat(+tag[1]) + " " + el.innerText.replace(/\s+/g, " ").trim().slice(0, 120)); return; }
    for (const c of el.childNodes) {
      if (c.nodeType === 3) { const s = c.textContent.replace(/\s+/g, " ").trim(); if (s.length > 1) lines.push(s.slice(0, 200)); }
      else walk(c);
    }
  };
  walk(document.body || document.documentElement);
  let out = "", total = 0;
  for (const l of lines) { if (total + l.length > 12000) { out += "… (the page goes on; scroll or use browser_eval)\n"; break; } out += l + "\n"; total += l.length; }
  return { title: document.title, url: location.href, w: innerWidth, h: innerHeight, sy: Math.round(scrollY), sh: document.documentElement.scrollHeight, text: out };
})()`

func (t *btab) outline() string {
	v, err := t.eval(outlineJS)
	if err != nil {
		return "The page could not be read: " + err.Error()
	}
	var o struct {
		Title string `json:"title"`
		URL   string `json:"url"`
		W     int    `json:"w"`
		H     int    `json:"h"`
		SY    int    `json:"sy"`
		SH    int    `json:"sh"`
		Text  string `json:"text"`
	}
	_ = json.Unmarshal(v, &o)
	t.mu.Lock()
	errs := 0
	for _, l := range t.logs {
		if l.Level == "error" {
			errs++
		}
	}
	t.mu.Unlock()
	head := fmt.Sprintf("Page: %s\nAddress: %s\nViewport %d×%d, scrolled %d of %d px", o.Title, o.URL, o.W, o.H, o.SY, o.SH)
	if errs > 0 {
		head += fmt.Sprintf("\nConsole: %d error(s), see browser_console", errs)
	}
	return head + "\n\n" + strings.TrimSpace(o.Text)
}

// center finds an element by ref or visible text, scrolled into view
func (t *btab) center(ref, text string) (float64, float64, error) {
	tx, _ := json.Marshal(strings.TrimSpace(text))
	js := `(() => { let el = ` + refExpr(ref) + `;
	  if (!el && ` + string(tx) + `) { const want = ` + string(tx) + `.toLowerCase();
	    const all = [...document.querySelectorAll('a,button,[role=button],[role=link],[role=tab],[role=menuitem],summary,label,input[type=submit],input[type=button],li,span,div')];
	    el = all.find((e) => (e.innerText || e.value || "").trim().toLowerCase() === want) || all.find((e) => (e.innerText || e.value || "").toLowerCase().includes(want)); }
	  if (!el) return null;
	  el.scrollIntoView({ block: "center", inline: "center" });
	  const r = el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`
	v, err := t.eval(js)
	if err != nil {
		return 0, 0, err
	}
	var p []float64
	if json.Unmarshal(v, &p) != nil || len(p) != 2 {
		if ref != "" {
			return 0, 0, fmt.Errorf("no element [%s] on the page now: take a new browser_snapshot", ref)
		}
		return 0, 0, fmt.Errorf("nothing with the text %q on the page", text)
	}
	return p[0], p[1], nil
}

func (t *btab) clickRef(ref, text string) error {
	if ref == "" && strings.TrimSpace(text) == "" {
		return errors.New("give the ref (or the text) of what to click")
	}
	x, y, err := t.center(ref, text)
	if err != nil {
		return err
	}
	c := t.conn
	_ = c.call("Input.dispatchMouseEvent", map[string]any{"type": "mouseMoved", "x": x, "y": y}, nil)
	_ = c.call("Input.dispatchMouseEvent", map[string]any{"type": "mousePressed", "x": x, "y": y, "button": "left", "buttons": 1, "clickCount": 1}, nil)
	return c.call("Input.dispatchMouseEvent", map[string]any{"type": "mouseReleased", "x": x, "y": y, "button": "left", "buttons": 0, "clickCount": 1}, nil)
}

func (t *btab) typeRef(ref, text string, submit bool) error {
	if ref == "" {
		return errors.New("give the field's ref")
	}
	if err := t.clickRef(ref, ""); err != nil {
		return err
	}
	// what the field held is selected, so the typing replaces it
	_, _ = t.eval(`(() => { const el = ` + refExpr(ref) + `; if (!el) return;
	  el.focus(); if (el.select) el.select(); else if (el.isContentEditable) document.execCommand("selectAll"); })()`)
	if text == "" {
		t.press("Backspace")
	} else if err := t.conn.call("Input.insertText", map[string]any{"text": text}, nil); err != nil {
		return err
	}
	if submit {
		t.press("Enter")
	}
	return nil
}

var keyCodes = map[string]int{"Enter": 13, "Tab": 9, "Escape": 27, "Backspace": 8, "Delete": 46, " ": 32, "Space": 32,
	"ArrowLeft": 37, "ArrowUp": 38, "ArrowRight": 39, "ArrowDown": 40, "PageUp": 33, "PageDown": 34, "Home": 36, "End": 35}

// press sends a key, with modifiers written as Control+a, Shift+Tab…
func (t *btab) press(combo string) {
	parts := strings.Split(combo, "+")
	key := parts[len(parts)-1]
	if key == "" && len(parts) > 1 { // "Control++"
		key = "+"
	}
	mods := 0
	for _, m := range parts[:len(parts)-1] {
		switch strings.ToLower(m) {
		case "alt", "option":
			mods |= 1
		case "control", "ctrl":
			mods |= 2
		case "meta", "cmd", "command":
			mods |= 4
		case "shift":
			mods |= 8
		}
	}
	if key == "Space" {
		key = " "
	}
	code := keyCodes[key]
	keyName, codeName, txt := key, key, ""
	if len([]rune(key)) == 1 {
		r := []rune(key)[0]
		if code == 0 {
			code = int(strings.ToUpper(key)[0])
		}
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' {
			codeName = "Key" + strings.ToUpper(key)
		} else if r >= '0' && r <= '9' {
			codeName = "Digit" + key
		} else if r == ' ' {
			codeName = "Space"
		}
		if mods&(2|4) == 0 {
			txt = key
		}
	}
	if key == "Enter" {
		txt = "\r"
	}
	down := map[string]any{"type": "keyDown", "key": keyName, "code": codeName, "modifiers": mods, "windowsVirtualKeyCode": code, "nativeVirtualKeyCode": code}
	if txt != "" {
		down["text"] = txt
	} else {
		down["type"] = "rawKeyDown"
	}
	_ = t.conn.call("Input.dispatchKeyEvent", down, nil)
	_ = t.conn.call("Input.dispatchKeyEvent", map[string]any{"type": "keyUp", "key": keyName, "code": codeName, "modifiers": mods, "windowsVirtualKeyCode": code, "nativeVirtualKeyCode": code}, nil)
}
