package main

import (
	"strings"
	"sync"
	"time"
)

// reqState is plugin-owned per-request data. Following Bifrost's guidance, only the
// correlation ID travels in BifrostContext; the request-sized data lives here.
type reqState struct {
	ID        string
	Created   time.Time
	Mode      string
	Stream    bool
	Prompt    string
	Model     string
	VKPrint   string
	Text      strings.Builder
	Truncated bool
	Triage    TriageResult
	TTLSet    string // "default" | "<n>s" | "no-store"
	NoteSent  bool
	Enqueued  bool
	CacheHit  *bool
	CacheID   string
	Sync      *syncResult // verify mode outcome
	SkipWhy   string
}

func (s *reqState) appendText(chunk string, max int) {
	if s.Truncated || chunk == "" {
		return
	}
	room := max - s.Text.Len()
	if room <= 0 {
		s.Truncated = true
		return
	}
	if len(chunk) > room {
		chunk = truncateUTF8(chunk, room)
		s.Truncated = true
	}
	s.Text.WriteString(chunk)
}

// truncateUTF8 cuts s to at most n bytes without splitting a rune.
func truncateUTF8(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && n < len(s) && (s[n]&0xC0) == 0x80 {
		n--
	}
	return s[:n]
}

// stateStore is a bounded map with age-based sweeping. When full, new requests are simply
// not tracked (fail open): inference is never delayed by Halflife bookkeeping.
type stateStore struct {
	mu     sync.Mutex
	m      map[string]*reqState
	max    int
	maxAge time.Duration
}

func newStateStore(max int, maxAge time.Duration) *stateStore {
	return &stateStore{m: make(map[string]*reqState), max: max, maxAge: maxAge}
}

func (s *stateStore) put(st *reqState) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.m) >= s.max {
		return false
	}
	s.m[st.ID] = st
	return true
}

// with runs fn on the state under the store lock. Returns false if the id is unknown.
func (s *stateStore) with(id string, fn func(*reqState)) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	st, ok := s.m[id]
	if !ok {
		return false
	}
	fn(st)
	return true
}

func (s *stateStore) remove(id string) {
	s.mu.Lock()
	delete(s.m, id)
	s.mu.Unlock()
}

func (s *stateStore) size() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.m)
}

// sweep drops entries older than maxAge (requests whose post hooks never ran, e.g. a
// provider error before any transport post hook). Returns the number removed.
func (s *stateStore) sweep(now time.Time) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for id, st := range s.m {
		if now.Sub(st.Created) > s.maxAge {
			delete(s.m, id)
			n++
		}
	}
	return n
}
