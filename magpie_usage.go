package main

import (
	"bytes"
	"encoding/csv"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// What the models cost: every request Magpie's gateway served, as
// `magpie usage --csv all` lists it, summed up for Foxpit's Usage tab.

type useRow struct {
	At                           time.Time
	Agent, Model, Account, Sess  string
	In, Out, CacheRead, CacheNew int
	Cost                         float64
	Millis, TTFT                 int
	Status                       int
	Err                          string
	Failed, Stopped              bool // Magpie's own word: a failure; or the agent called it off
}

type useSum struct {
	Name   string  `json:"name"`
	Sub    string  `json:"sub,omitempty"`
	Calls  int     `json:"calls"`
	Tokens int     `json:"tokens"`
	Cost   float64 `json:"cost"`
	TTFT   int     `json:"ttft"` // average, ms; 0 when none was timed
	ttftN  int
}

func (s *useSum) add(r useRow) {
	s.Calls++
	s.Tokens += r.In + r.Out
	s.Cost += r.Cost
	if r.TTFT > 0 {
		s.TTFT = (s.TTFT*s.ttftN + r.TTFT) / (s.ttftN + 1)
		s.ttftN++
	}
}

var useCache struct {
	sync.Mutex
	at   time.Time
	rows []useRow
}

func (m *Magpie) usageRows() ([]useRow, error) {
	useCache.Lock()
	defer useCache.Unlock()
	if time.Since(useCache.at) < 15*time.Second && useCache.rows != nil {
		return useCache.rows, nil
	}
	out, err := m.cli(30*time.Second, "usage", "--csv", "all")
	if err != nil {
		return nil, err
	}
	// the CSV starts at its header: anything printed before it is a log line
	if i := bytes.Index(out, []byte("time,agent,")); i > 0 {
		out = out[i:]
	}
	rd := csv.NewReader(bytes.NewReader(out))
	rd.FieldsPerRecord = -1
	recs, err := rd.ReadAll()
	if err != nil {
		return nil, err
	}
	rows := []useRow{}
	if len(recs) < 2 {
		useCache.rows, useCache.at = rows, time.Now()
		return rows, nil
	}
	col := map[string]int{}
	for i, n := range recs[0] {
		col[n] = i
	}
	get := func(r []string, n string) string {
		if i, ok := col[n]; ok && i < len(r) {
			return r[i]
		}
		return ""
	}
	num := func(r []string, n string) int { v, _ := strconv.Atoi(get(r, n)); return v }
	for _, r := range recs[1:] {
		at, err := time.Parse(time.RFC3339, get(r, "time"))
		if err != nil {
			continue
		}
		cost, _ := strconv.ParseFloat(get(r, "cost_usd"), 64)
		model := get(r, "requested_model")
		if model == "" {
			model = get(r, "model")
		}
		acct := get(r, "provider_account")
		if acct == "" {
			acct = get(r, "session_account")
		}
		rows = append(rows, useRow{At: at, Agent: get(r, "agent"), Model: model, Account: acct, Sess: get(r, "session"),
			In: num(r, "input_tokens"), Out: num(r, "output_tokens"), CacheRead: num(r, "cache_read_tokens"), CacheNew: num(r, "cache_write_tokens"),
			Cost: cost, Millis: num(r, "duration_ms"), TTFT: num(r, "ttft_ms"), Status: num(r, "status"),
			Err: strings.TrimSpace(get(r, "error_message")), Failed: get(r, "error") == "true", Stopped: get(r, "error_type") == "agent_canceled"})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].At.After(rows[j].At) })
	useCache.rows, useCache.at = rows, time.Now()
	return rows, nil
}

func (m *Magpie) usageRoutes(mux *http.ServeMux, writeJSON func(http.ResponseWriter, int, any)) {
	mux.HandleFunc("GET /api/magpie/spend", func(w http.ResponseWriter, r *http.Request) {
		rows, err := m.usageRows()
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "Magpie did not give its usage: " + err.Error()})
			return
		}
		days, _ := strconv.Atoi(r.URL.Query().Get("days"))
		now := time.Now()
		from := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
		if days > 1 {
			from = from.AddDate(0, 0, -(days - 1))
		}
		var total useSum
		total.Name = "all"
		var cacheRead, cacheNew, errs int
		byDay := map[string]*useSum{}
		group := func(m map[string]*useSum, k, sub string, r useRow) {
			if k == "" {
				k = "—"
			}
			s := m[k]
			if s == nil {
				s = &useSum{Name: k, Sub: sub}
				m[k] = s
			}
			s.add(r)
		}
		models, accts, sess := map[string]*useSum{}, map[string]*useSum{}, map[string]*useSum{}
		recent := []map[string]any{}
		for _, x := range rows {
			if x.At.Before(from) {
				continue
			}
			total.add(x)
			cacheRead += x.CacheRead
			cacheNew += x.CacheNew
			if x.Failed {
				errs++
			}
			group(byDay, x.At.In(now.Location()).Format("2006-01-02"), "", x)
			group(models, x.Model, "", x)
			group(accts, x.Account, "", x)
			if x.Sess != "" {
				group(sess, x.Sess, x.Agent, x)
			}
			if len(recent) < 40 {
				recent = append(recent, map[string]any{"at": x.At, "model": x.Model, "account": x.Account, "in": x.In, "out": x.Out,
					"cacheRead": x.CacheRead, "cost": x.Cost, "ms": x.Millis, "ttft": x.TTFT, "status": x.Status, "error": x.Err, "failed": x.Failed, "stopped": x.Stopped, "session": x.Sess})
			}
		}
		list := func(m map[string]*useSum, n int) []*useSum {
			out := make([]*useSum, 0, len(m))
			for _, s := range m {
				out = append(out, s)
			}
			sort.Slice(out, func(i, j int) bool {
				if out[i].Cost != out[j].Cost {
					return out[i].Cost > out[j].Cost
				}
				return out[i].Tokens > out[j].Tokens
			})
			if n > 0 && len(out) > n {
				out = out[:n]
			}
			return out
		}
		// every day of the range, the quiet ones too, oldest first
		span := days
		if span < 1 {
			span = 1
		}
		daily := []*useSum{}
		for i := span - 1; i >= 0; i-- {
			k := from.AddDate(0, 0, span-1-i).Format("2006-01-02")
			if s := byDay[k]; s != nil {
				daily = append(daily, s)
			} else {
				daily = append(daily, &useSum{Name: k})
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"total": total, "cacheRead": cacheRead, "cacheWrite": cacheNew, "errors": errs,
			"days": daily, "models": list(models, 0), "accounts": list(accts, 0), "sessions": list(sess, 50), "recent": recent})
	})
}
