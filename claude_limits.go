package main

// Claude's own word on an account's plan limits. Every reply Claude Code
// streams carries a rate_limit_event (status, which window, when it resets,
// and often how much is used), read straight from Anthropic's answer to that
// account. Magpie's numbers can lag or mix accounts up; what Foxpit's own
// chats heard last for an account wins over them while it is fresh.
// Nothing here reads a sign-in: it is what Claude Code already tells Foxpit.

import (
	"encoding/json"
	"log"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type heardLimit struct {
	status   string // allowed, allowed_warning, rejected
	resets   time.Time
	used     float64 // 0-100, or -1 when the event had no number
	heard    time.Time
	overused bool
}

var heard = struct {
	sync.Mutex
	m map[string]map[string]heardLimit // account → window ("five_hour", "seven_day", "seven_day_opus"…)
}{m: map[string]map[string]heardLimit{}}

// noteLimit keeps one rate_limit_event for the account a chat ran on
func noteLimit(account string, raw json.RawMessage) {
	if account == "" || len(raw) == 0 {
		return
	}
	var in struct {
		Status    string   `json:"status"`
		ResetsAt  *float64 `json:"resetsAt"`
		Type      string   `json:"rateLimitType"`
		Util      *float64 `json:"utilization"`
		Overusing bool     `json:"isUsingOverage"`
	}
	if json.Unmarshal(raw, &in) != nil || in.Type == "" {
		return
	}
	h := heardLimit{status: in.Status, used: -1, heard: time.Now(), overused: in.Overusing}
	if in.ResetsAt != nil && *in.ResetsAt > 0 {
		sec := *in.ResetsAt
		if sec > 1e12 { // milliseconds
			sec /= 1000
		}
		h.resets = time.Unix(int64(sec), 0)
	}
	if in.Util != nil {
		u := *in.Util
		if u <= 1.0001 { // a fraction
			u *= 100
		}
		h.used = math.Max(0, math.Min(100, u))
	}
	key := strings.ToLower(strings.TrimSpace(account))
	loadHeard()
	heard.Lock()
	if heard.m[key] == nil {
		heard.m[key] = map[string]heardLimit{}
	}
	prev, had := heard.m[key][in.Type]
	heard.m[key][in.Type] = h
	saveHeard()
	heard.Unlock()
	if !had || prev.status != h.status || math.Abs(prev.used-h.used) >= 1 {
		log.Printf("limits: %s %s status=%s used=%.0f resets=%s", key, in.Type, h.status, h.used, h.resets.Format(time.RFC3339))
	}
}

// outNow: a chat on this account was refused for a usage limit that has not
// reset yet (a rate_limit_event with status "rejected")
func outNow(account string) bool {
	loadHeard()
	heard.Lock()
	defer heard.Unlock()
	now := time.Now()
	for _, h := range heard.m[strings.ToLower(strings.TrimSpace(account))] {
		if h.status == "rejected" && !h.resets.IsZero() && now.Before(h.resets) {
			return true
		}
	}
	return false
}

// the window names Magpie uses for Claude's windows
var windowNames = map[string]string{"five_hour": "5 hours", "seven_day": "7 days", "seven_day_opus": "7 days · Opus",
	"seven_day_sonnet": "7 days · Sonnet", "seven_day_fable": "7 days · Fable"}

// applyHeard puts what Foxpit's chats heard over Magpie's numbers for a
// Claude account: a window that has not reset since and was heard in the
// last six hours.
func applyHeard(a *mpAccount) {
	if a.Agent != "claude" {
		return
	}
	loadHeard()
	heard.Lock()
	got := heard.m[strings.ToLower(strings.TrimSpace(a.User))]
	heard.Unlock()
	if len(got) == 0 {
		return
	}
	now := time.Now()
	for typ, h := range got {
		if now.Sub(h.heard) > 6*time.Hour || (!h.resets.IsZero() && now.After(h.resets)) {
			continue
		}
		name := windowNames[typ]
		if name == "" {
			continue
		}
		used := h.used
		if used < 0 {
			if h.status != "rejected" {
				continue // no number, and not full: Magpie's number stays
			}
			used = 100
		}
		w := mpWindow{Name: name, Used: math.Round(used), Remaining: math.Round(100 - used)}
		if !h.resets.IsZero() {
			w.ResetsAt = h.resets.Format(time.RFC3339)
		}
		found := false
		for i := range a.Windows {
			if a.Windows[i].Name == name {
				if w.ResetsAt == "" {
					w.ResetsAt = a.Windows[i].ResetsAt
				}
				a.Windows[i], found = w, true
			}
		}
		if !found {
			a.Windows = append(a.Windows, w)
		}
	}
}

// what was heard stays across restarts: a small file in Foxpit's cache folder
type savedLimit struct {
	Status string    `json:"status"`
	Resets time.Time `json:"resets"`
	Used   float64   `json:"used"`
	Heard  time.Time `json:"heard"`
}

var heardLoaded sync.Once

func limitsFile() string {
	dir, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "Foxpit", "claude-limits.json")
}

// loadHeard reads the file once; call with heard unlocked
func loadHeard() {
	heardLoaded.Do(func() {
		f := limitsFile()
		b, err := os.ReadFile(f)
		if err != nil {
			return
		}
		var in map[string]map[string]savedLimit
		if json.Unmarshal(b, &in) != nil {
			return
		}
		heard.Lock()
		for acc, ws := range in {
			if heard.m[acc] == nil {
				heard.m[acc] = map[string]heardLimit{}
			}
			for typ, s := range ws {
				if _, have := heard.m[acc][typ]; !have {
					heard.m[acc][typ] = heardLimit{status: s.Status, resets: s.Resets, used: s.Used, heard: s.Heard}
				}
			}
		}
		heard.Unlock()
	})
}

// saveHeard writes the file; call with heard locked
func saveHeard() {
	out := map[string]map[string]savedLimit{}
	for acc, ws := range heard.m {
		out[acc] = map[string]savedLimit{}
		for typ, h := range ws {
			out[acc][typ] = savedLimit{Status: h.status, Resets: h.resets, Used: h.used, Heard: h.heard}
		}
	}
	b, _ := json.Marshal(out)
	if f := limitsFile(); f != "" {
		_ = os.MkdirAll(filepath.Dir(f), 0o755)
		_ = os.WriteFile(f, b, 0o644)
	}
}

// patchQuotas puts what was heard over the Claude rows of Magpie's
// /v1/magpie/quotas answer, which the side panel's account card reads
func patchQuotas(body []byte) []byte {
	var doc map[string]json.RawMessage
	if json.Unmarshal(body, &doc) != nil {
		return body
	}
	var rows []map[string]json.RawMessage
	if json.Unmarshal(doc["data"], &rows) != nil {
		return body
	}
	changed := false
	for _, row := range rows {
		var prov, user string
		_ = json.Unmarshal(row["provider"], &prov)
		_ = json.Unmarshal(row["user"], &user)
		if prov != "claude" || user == "" {
			continue
		}
		a := mpAccount{Agent: "claude", User: user}
		_ = json.Unmarshal(row["windows"], &a.Windows)
		before, _ := json.Marshal(a.Windows)
		applyHeard(&a)
		after, _ := json.Marshal(a.Windows)
		if string(before) != string(after) {
			row["windows"], changed = after, true
		}
	}
	if !changed {
		return body
	}
	doc["data"], _ = json.Marshal(rows)
	b, err := json.Marshal(doc)
	if err != nil {
		return body
	}
	return b
}
