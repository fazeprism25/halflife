// Package main is a feasibility probe for Halflife. It is NOT the product.
// It exercises Bifrost's documented plugin hooks to prove or disprove the
// integration points listed in HALFLIFE_FEASIBILITY_REPORT.md.
//
// Built as a Go .so plugin (-buildmode=plugin) inside the transports module so
// every shared dependency version is identical to the host binary.
//
// Control headers (test-only):
//
//	x-probe-ttl: <duration>      set semantic-cache TTL from the plugin (PostLLMHook)
//	x-probe-adaptive-ttl: true   derive TTL from a crude volatility heuristic on the response
//	x-probe-modify: true         append a marker to the non-stream response text
//	x-probe-stream-note: true    append a marker to the final streamed content chunk
//	x-probe-panic: true          panic inside PostLLMHook
//	x-probe-shortcircuit: true   short-circuit in HTTPTransportPreHook with a plugin-owned JSON body
//	x-probe-invalidate: true     async worker deletes the cache entry via Bifrost's /api/cache API
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	bifrost "github.com/maximhq/bifrost/core"
	"github.com/maximhq/bifrost/core/schemas"
)

// Overridden per build with -ldflags "-X main.pluginName=..."
var pluginName = "halflife-probe"

// Context keys owned by the semantic cache plugin (plugins/semanticcache/main.go:248-252).
// Re-declared by value so the probe does not import the semanticcache module.
const (
	cacheTTLKey     schemas.BifrostContextKey = "semantic_cache-ttl"
	cacheNoStoreKey schemas.BifrostContextKey = "semantic_cache-no_store"
)

// Probe-owned context keys.
const (
	kFlags  schemas.BifrostContextKey = "halflife-probe-flags"
	kTStart schemas.BifrostContextKey = "halflife-probe-t0"
	kCorr   schemas.BifrostContextKey = "halflife-probe-corr" // shared by both probe builds
)

type flags struct {
	TTL         string
	AdaptiveTTL bool
	Modify      bool
	StreamNote  bool
	Panic       bool
	Invalidate  bool
}

type event struct {
	At    time.Time `json:"at"`
	Hook  string    `json:"hook"`
	Note  string    `json:"note,omitempty"`
	HookN int64     `json:"hook_ns,omitempty"`
}

type report struct {
	RequestID  string    `json:"request_id"`
	Status     string    `json:"status"` // queued|done|failed|dropped
	Stream     bool      `json:"stream"`
	Text       string    `json:"text"`
	CacheHit   *bool     `json:"cache_hit,omitempty"`
	CacheID    string    `json:"cache_id,omitempty"`
	TTLSet     string    `json:"ttl_set,omitempty"`
	Verdict    string    `json:"verdict,omitempty"`
	Error      string    `json:"error,omitempty"`
	Invalidate string    `json:"invalidate,omitempty"`
	Events     []event   `json:"events"`
	QueuedAt   time.Time `json:"queued_at,omitempty"`
	DoneAt     time.Time `json:"done_at,omitempty"`
}

type job struct {
	id         string
	invalidate bool
}

var (
	cfg struct {
		SidecarAddr    string `json:"sidecar_addr"`
		VerifyDelayMS  int    `json:"verify_delay_ms"`
		VerifierURL    string `json:"verifier_url"` // optional: unreachable URL to test failure paths
		QueueSize      int    `json:"queue_size"`
		BifrostAdmin   string `json:"bifrost_admin_url"`
		PanicInWorker  bool   `json:"panic_in_worker"`
		FailInit       bool   `json:"fail_init"`
		ApplyTTL       bool   `json:"apply_ttl"` // only one probe instance sets the TTL, so placement effects are isolated
	}
	mu       sync.Mutex
	reports  = map[string]*report{}
	streams  = map[string]*strings.Builder{} // per-request accumulator (kept out of ctx, per Bifrost guidance)
	queue    chan job
	dropped  atomic.Int64
	stopCh   = make(chan struct{})
	srv      *http.Server
	volatile = regexp.MustCompile(`(?i)\b(as of|currently|latest|current|today|now|price|ceo|president|version|stock|rate)\b|\b20\d\d\b`)
)

func Init(config any) error {
	b, _ := json.Marshal(config)
	_ = json.Unmarshal(b, &cfg)
	if cfg.FailInit {
		return fmt.Errorf("probe configured to fail Init")
	}
	if cfg.QueueSize <= 0 {
		cfg.QueueSize = 64
	}
	queue = make(chan job, cfg.QueueSize)
	for i := 0; i < 2; i++ {
		go worker()
	}
	if cfg.SidecarAddr != "" {
		mux := http.NewServeMux()
		mux.HandleFunc("/reports", func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			defer mu.Unlock()
			if id := r.URL.Query().Get("id"); id != "" {
				writeJSON(w, reports[id])
				return
			}
			writeJSON(w, map[string]any{"count": len(reports), "dropped": dropped.Load(), "reports": reports})
		})
		// Stand-in for a Tavily-shaped upstream (returns usage.credits) to test Bifrost relay pricing
		// without spending real credits. Clearly a mock; never presented as Tavily.
		mux.HandleFunc("/mock-search", func(w http.ResponseWriter, r *http.Request) {
			writeJSON(w, map[string]any{"mock": true, "auth_header_seen": r.Header.Get("Authorization") != "", "results": []any{}, "usage": map[string]int{"credits": 2}})
		})
		mux.HandleFunc("/health",func(w http.ResponseWriter, r *http.Request) { writeJSON(w, map[string]string{"plugin": pluginName, "ok": "true"}) })
		srv = &http.Server{Addr: cfg.SidecarAddr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
		go func() {
			if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				fmt.Fprintf(os.Stderr, "[%s] sidecar error: %v\n", pluginName, err)
			}
		}()
	}
	fmt.Printf("[%s] Init ok, sidecar=%q delay=%dms\n", pluginName, cfg.SidecarAddr, cfg.VerifyDelayMS)
	return nil
}

func GetName() string { return pluginName }

func Cleanup() error {
	close(stopCh)
	if srv != nil {
		_ = srv.Close()
	}
	return nil
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

// reqID returns the probe's own correlation ID, set in HTTPTransportPreHook. Bifrost's
// request-id is not yet populated in the transport phase, so a plugin that must correlate
// transport hooks with LLM hooks needs its own key (tested: see results).
func reqID(ctx *schemas.BifrostContext) string {
	if id, ok := ctx.Value(kCorr).(string); ok && id != "" {
		return id
	}
	if id, ok := ctx.Value(schemas.BifrostContextKeyRequestID).(string); ok {
		return "bf-" + id
	}
	return ""
}

var corrSeq atomic.Int64

func newCorr() string { return fmt.Sprintf("hl-%d-%d", time.Now().UnixNano(), corrSeq.Add(1)) }

func rec(id, hook, note string, d time.Duration) *report {
	mu.Lock()
	defer mu.Unlock()
	r, ok := reports[id]
	if !ok {
		r = &report{RequestID: id, Status: "observed"}
		reports[id] = r
	}
	r.Events = append(r.Events, event{At: time.Now(), Hook: hook, Note: note, HookN: d.Nanoseconds()})
	return r
}

// ---------------- HTTP transport hooks ----------------

func HTTPTransportPreHook(ctx *schemas.BifrostContext, req *schemas.HTTPRequest) (*schemas.HTTPResponse, error) {
	f := flags{
		TTL:         req.CaseInsensitiveHeaderLookup("x-probe-ttl"),
		AdaptiveTTL: req.CaseInsensitiveHeaderLookup("x-probe-adaptive-ttl") == "true",
		Modify:      req.CaseInsensitiveHeaderLookup("x-probe-modify") == "true",
		StreamNote:  req.CaseInsensitiveHeaderLookup("x-probe-stream-note") == "true",
		Panic:       req.CaseInsensitiveHeaderLookup("x-probe-panic") == "true",
		Invalidate:  req.CaseInsensitiveHeaderLookup("x-probe-invalidate") == "true",
	}
	ctx.SetValue(flagsKey(), f) // per-plugin key: the two builds have distinct (non-assignable) flags types
	ctx.SetValue(kTStart, time.Now())
	// Both probe builds share this key, so the first transport pre-hook (pre_builtin) sets it and the
	// second reuses it: one correlation ID per request across both plugins.
	if existing, ok := ctx.Value(kCorr).(string); !ok || existing == "" {
		ctx.SetValue(kCorr, newCorr())
	}
	if req.CaseInsensitiveHeaderLookup("x-probe-shortcircuit") == "true" {
		resp := schemas.AcquireHTTPResponse()
		resp.StatusCode = 200
		resp.Headers["content-type"] = "application/json"
		resp.Body = []byte(fmt.Sprintf(`{"served_by":%q,"path":%q,"note":"plugin-owned response via HTTPTransportPreHook short-circuit"}`, pluginName, req.Path))
		return resp, nil
	}
	return nil, nil
}

func HTTPTransportPostHook(ctx *schemas.BifrostContext, req *schemas.HTTPRequest, resp *schemas.HTTPResponse) error {
	id := reqID(ctx)
	// Non-stream body is visible here AFTER all LLM post-hooks, so cache_debug stamped by
	// semantic_cache is readable even when the probe runs in post_builtin placement.
	if resp != nil && len(resp.Body) > 0 && id != "" {
		var body struct {
			ExtraFields struct {
				CacheDebug *struct {
					CacheHit bool    `json:"cache_hit"`
					CacheID  *string `json:"cache_id"`
				} `json:"cache_debug"`
			} `json:"extra_fields"`
		}
		if json.Unmarshal(resp.Body, &body) == nil && body.ExtraFields.CacheDebug != nil {
			mu.Lock()
			if r, ok := reports[id]; ok {
				hit := body.ExtraFields.CacheDebug.CacheHit
				r.CacheHit = &hit
				if body.ExtraFields.CacheDebug.CacheID != nil {
					r.CacheID = *body.ExtraFields.CacheDebug.CacheID
				}
			}
			mu.Unlock()
		}
	}
	rec(id, "HTTPTransportPostHook", "", 0)
	return nil
}

func HTTPTransportResponseHeadersHook(ctx *schemas.BifrostContext, req *schemas.HTTPRequest, resp *schemas.HTTPResponseMetadata) error {
	id := reqID(ctx)
	resp.SetHeader("x-halflife-report", id)
	resp.SetHeader("x-halflife-plugin-"+pluginName, "seen")
	rec(id, "HTTPTransportResponseHeadersHook", "", 0)
	return nil
}

func HTTPTransportStreamChunkHook(ctx *schemas.BifrostContext, req *schemas.HTTPRequest, chunk *schemas.BifrostStreamChunk) (*schemas.BifrostStreamChunk, error) {
	f, _ := ctx.Value(flagsKey()).(flags)
	if !f.StreamNote || chunk == nil || chunk.BifrostChatResponse == nil {
		return chunk, nil
	}
	for i := range chunk.BifrostChatResponse.Choices {
		c := &chunk.BifrostChatResponse.Choices[i]
		if c.FinishReason != nil && c.ChatStreamResponseChoice != nil {
			if c.Delta == nil {
				c.Delta = &schemas.ChatStreamResponseChoiceDelta{}
			}
			note := fmt.Sprintf(" [halflife: verification pending, report=%s]", reqID(ctx))
			if c.Delta.Content == nil {
				c.Delta.Content = &note
			} else {
				s := *c.Delta.Content + note
				c.Delta.Content = &s
			}
		}
	}
	return chunk, nil
}

// ---------------- LLM hooks ----------------

func PreRequestHook(_ *schemas.BifrostContext, _ *schemas.BifrostRequest) error { return nil }

func PreLLMHook(ctx *schemas.BifrostContext, req *schemas.BifrostRequest) (*schemas.BifrostRequest, *schemas.LLMPluginShortCircuit, error) {
	rec(reqID(ctx), "PreLLMHook", "", 0)
	return req, nil, nil
}

func PostLLMHook(ctx *schemas.BifrostContext, resp *schemas.BifrostResponse, bErr *schemas.BifrostError) (*schemas.BifrostResponse, *schemas.BifrostError, error) {
	t0 := time.Now()
	id := reqID(ctx)
	f, _ := ctx.Value(flagsKey()).(flags)
	if f.Panic {
		panic("halflife-probe: deliberate panic in PostLLMHook")
	}
	if bErr != nil || resp == nil || resp.ChatResponse == nil {
		rec(id, "PostLLMHook", "error-or-non-chat", time.Since(t0))
		return resp, bErr, nil
	}
	cr := resp.ChatResponse
	extra := resp.GetExtraFields()
	isStream := bifrost.IsStreamRequestType(extra.RequestType)

	var cacheNote string
	if extra.CacheDebug != nil {
		cacheNote = fmt.Sprintf("cache_debug visible: hit=%v", extra.CacheDebug.CacheHit)
	}

	if isStream {
		final := bifrost.IsFinalChunk(ctx)
		mu.Lock()
		sb, ok := streams[id]
		if !ok {
			sb = &strings.Builder{}
			streams[id] = sb
		}
		for _, c := range cr.Choices {
			if c.ChatStreamResponseChoice != nil && c.Delta != nil && c.Delta.Content != nil {
				sb.WriteString(*c.Delta.Content)
			}
		}
		text := sb.String()
		if final {
			delete(streams, id)
		}
		mu.Unlock()
		if final {
			r := rec(id, "PostLLMHook", "stream-final "+cacheNote, time.Since(t0))
			mu.Lock()
			r.Stream, r.Text = true, text
			mu.Unlock()
			applyTTL(ctx, f, text, r)
			enqueue(id, f.Invalidate)
		}
		return resp, nil, nil
	}

	var text string
	for i, c := range cr.Choices {
		if c.ChatNonStreamResponseChoice != nil && c.Message != nil && c.Message.Content != nil && c.Message.Content.ContentStr != nil {
			text += *c.Message.Content.ContentStr
			if f.Modify {
				s := *c.Message.Content.ContentStr + "\n\n[halflife-probe: response modified in PostLLMHook]"
				cr.Choices[i].Message.Content.ContentStr = &s
			}
		}
	}
	r := rec(id, "PostLLMHook", cacheNote, 0)
	mu.Lock()
	r.Text = text
	mu.Unlock()
	applyTTL(ctx, f, text, r)
	enqueue(id, f.Invalidate)
	mu.Lock()
	r.Events[len(r.Events)-1].HookN = time.Since(t0).Nanoseconds()
	mu.Unlock()
	return resp, nil, nil
}

func applyTTL(ctx *schemas.BifrostContext, f flags, text string, r *report) {
	var ttl time.Duration
	if !cfg.ApplyTTL {
		return
	}
	if f.TTL != "" {
		if d, err := time.ParseDuration(f.TTL); err == nil {
			ttl = d
		}
	} else if f.AdaptiveTTL && volatile.MatchString(text) {
		ttl = 5 * time.Second // crude stand-in for a half-life-derived TTL
	}
	if ttl > 0 {
		ctx.SetValue(cacheTTLKey, ttl)
		mu.Lock()
		r.TTLSet = ttl.String()
		mu.Unlock()
	}
}

func enqueue(id string, invalidate bool) {
	mu.Lock()
	if r, ok := reports[id]; ok {
		r.Status, r.QueuedAt = "queued", time.Now()
	}
	mu.Unlock()
	select {
	case queue <- job{id: id, invalidate: invalidate}:
	default: // never block inference: shed load instead
		dropped.Add(1)
		mu.Lock()
		if r, ok := reports[id]; ok {
			r.Status = "dropped"
		}
		mu.Unlock()
	}
}

func worker() {
	client := &http.Client{Timeout: 3 * time.Second}
	for {
		select {
		case <-stopCh:
			return
		case j := <-queue:
			func() {
				defer func() {
					if p := recover(); p != nil {
						setDone(j.id, "failed", "", fmt.Sprintf("worker panic recovered: %v", p))
					}
				}()
				if cfg.PanicInWorker {
					panic("deliberate worker panic")
				}
				time.Sleep(time.Duration(cfg.VerifyDelayMS) * time.Millisecond) // stands in for LLM+Tavily latency
				if cfg.VerifierURL != "" {
					resp, err := client.Get(cfg.VerifierURL)
					if err != nil {
						setDone(j.id, "failed", "", "verifier unreachable: "+err.Error())
						return
					}
					resp.Body.Close()
				}
				if j.invalidate {
					time.Sleep(300 * time.Millisecond) // let HTTPTransportPostHook capture cache_id
					mu.Lock()
					cid := reports[j.id].CacheID
					mu.Unlock()
					note := "no cache_id captured"
					if cid != "" && cfg.BifrostAdmin != "" {
						req, _ := http.NewRequest(http.MethodDelete, cfg.BifrostAdmin+"/api/cache/clear/"+cid, nil)
						if resp, err := client.Do(req); err != nil {
							note = "invalidate error: " + err.Error()
						} else {
							buf := new(bytes.Buffer)
							_, _ = buf.ReadFrom(resp.Body)
							resp.Body.Close()
							note = fmt.Sprintf("DELETE /api/cache/clear/%s -> %d %s", cid, resp.StatusCode, strings.TrimSpace(buf.String()))
						}
					}
					mu.Lock()
					reports[j.id].Invalidate = note
					mu.Unlock()
				}
				setDone(j.id, "done", "stub-verdict (no LLM/Tavily in probe)", "")
			}()
		}
	}
}

func setDone(id, status, verdict, errMsg string) {
	mu.Lock()
	defer mu.Unlock()
	if r, ok := reports[id]; ok {
		r.Status, r.Verdict, r.Error, r.DoneAt = status, verdict, errMsg, time.Now()
	}
}

func flagsKey() schemas.BifrostContextKey { return kFlags + schemas.BifrostContextKey("-"+pluginName) }
