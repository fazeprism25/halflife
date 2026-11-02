package main

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

// temporal-cues.json is copied from shared/temporal-cues.json at build time (see
// deploy/gateway.Dockerfile). The engine reads the same file, so inline triage and the
// engine's heuristic extractor share one definition.
//
//go:embed temporal-cues.json
var cuesJSON []byte

type cueGroup struct {
	ID         string   `json:"id"`
	Label      string   `json:"label"`
	TTLSeconds int      `json:"ttl_seconds"`
	Keywords   []string `json:"keywords"` // lowercase literals; one must occur for any pattern to match
	Patterns   []string `json:"patterns"`
	compiled   []*regexp.Regexp
}

// triageMaxBytes bounds the text scanned inline. Time-sensitive cues almost always appear in
// the prompt or the opening of an answer; the engine analyses the full text later.
const triageMaxBytes = 8 * 1024

type cueTable struct {
	Version string     `json:"version"`
	Groups  []cueGroup `json:"groups"`
}

// TriageResult is the plugin's inline, lexical view of a text. It decides only the cache
// TTL cap. It is not a freshness verdict: the engine does the real analysis later.
type TriageResult struct {
	Groups  []string // matched group ids, sorted
	TTLCap  int      // smallest ttl_seconds among matched groups; -1 when nothing matched
	NoStore bool     // a matched group has ttl_seconds == 0
}

func loadCues(b []byte) (*cueTable, error) {
	var t cueTable
	if err := json.Unmarshal(b, &t); err != nil {
		return nil, fmt.Errorf("temporal cues: %w", err)
	}
	if len(t.Groups) == 0 {
		return nil, fmt.Errorf("temporal cues: no groups")
	}
	for gi := range t.Groups {
		g := &t.Groups[gi]
		if g.ID == "" || g.TTLSeconds < 0 || len(g.Keywords) == 0 {
			return nil, fmt.Errorf("temporal cues: group %d invalid (id, ttl_seconds >= 0 and keywords required)", gi)
		}
		for i, k := range g.Keywords {
			g.Keywords[i] = strings.ToLower(k)
		}
		for _, p := range g.Patterns {
			re, err := regexp.Compile("(?i)" + p)
			if err != nil {
				return nil, fmt.Errorf("temporal cues: group %s pattern %q: %w", g.ID, p, err)
			}
			g.compiled = append(g.compiled, re)
		}
	}
	return &t, nil
}

// triage scans text (bounded by the caller) and returns the TTL cap. RE2 guarantees linear
// time, so a hostile text cannot cause catastrophic backtracking inside a hook.
func (t *cueTable) triage(text string) TriageResult {
	res := TriageResult{TTLCap: -1}
	if t == nil || text == "" {
		return res
	}
	lower := strings.ToLower(truncateUTF8(text, triageMaxBytes))
	for i := range t.Groups {
		g := &t.Groups[i]
		if g.matches(lower) {
			res.Groups = append(res.Groups, g.ID)
			if res.TTLCap < 0 || g.TTLSeconds < res.TTLCap {
				res.TTLCap = g.TTLSeconds
			}
			if g.TTLSeconds == 0 {
				res.NoStore = true
			}
		}
	}
	sort.Strings(res.Groups)
	return res
}

const (
	windowMargin = 100 // bytes either side of a keyword hit; every pattern spans < 80 bytes
	maxWindows   = 16  // beyond this many keyword hits, scan the whole text once instead
)

// matches reports whether any group pattern matches lower. Regexes only run inside small
// windows around keyword hits, extended to whitespace so word boundaries are unchanged.
func (g *cueGroup) matches(lower string) bool {
	windows := 0
	for _, k := range g.Keywords {
		for from := 0; ; {
			j := strings.Index(lower[from:], k)
			if j < 0 {
				break
			}
			j += from
			if windows++; windows > maxWindows {
				return g.matchAny(lower)
			}
			lo, hi := window(lower, j, j+len(k))
			if g.matchAny(lower[lo:hi]) {
				return true
			}
			from = j + len(k)
		}
	}
	return false
}

func (g *cueGroup) matchAny(s string) bool {
	for _, re := range g.compiled {
		if re.MatchString(s) {
			return true
		}
	}
	return false
}

// window returns [lo, hi) around [s, e), widened by windowMargin and then to the nearest
// whitespace (bounded), always on UTF-8 boundaries.
func window(text string, s, e int) (int, int) {
	lo, hi := s-windowMargin, e+windowMargin
	if lo < 0 {
		lo = 0
	}
	if hi > len(text) {
		hi = len(text)
	}
	for n := 0; lo > 0 && n < 40 && !isSpace(text[lo-1]); n++ {
		lo--
	}
	for n := 0; hi < len(text) && n < 40 && !isSpace(text[hi]); n++ {
		hi++
	}
	for lo > 0 && !utf8.RuneStart(text[lo]) {
		lo--
	}
	for hi < len(text) && !utf8.RuneStart(text[hi]) {
		hi++
	}
	return lo, hi
}

func isSpace(b byte) bool { return b == ' ' || b == '\n' || b == '\t' || b == '\r' }
