// Package main is the Halflife plugin for the Bifrost AI gateway (v2.4.0 plugin interface).
//
// Halflife is a freshness layer: it notices answers that contain time-sensitive claims,
// caps their cache lifetime inline (microseconds, lexical), and hands the text to the
// Halflife engine, which extracts claims, estimates how likely each is to be outdated, and
// verifies the risky ones against live web evidence (Tavily, via a Bifrost relay).
//
// Design rules (see research/ARCHITECTURE_DECISIONS.md):
//   - every exported hook recovers panics and fails open: the original request/response
//     passes through untouched when Halflife has a problem
//   - inline work is bounded (text size caps, RE2 regexes, non-blocking enqueue)
//   - only a correlation ID lives in BifrostContext; request data lives in a plugin store
//   - the engine's own LLM calls are recognised by a secret internal token and skipped
package main

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/maximhq/bifrost/core/schemas"
)

const pluginVersion = "0.1.0"

// Context keys owned by the semantic cache plugin (plugins/semanticcache/main.go:249,252).
// Declared by value so this plugin does not import the semanticcache module.
const (
	cacheTTLKey     schemas.BifrostContextKey = "semantic_cache-ttl"      // time.Duration
	cacheNoStoreKey schemas.BifrostContextKey = "semantic_cache-no_store" // bool
)

// Halflife-owned context key: the correlation ID (a string, so it is type-safe across .so builds).
const ctxReportID schemas.BifrostContextKey = "halflife-report-id"

// Request headers understood by the plugin.
const (
	hdrMode     = "x-halflife-mode"     // off | async | verify
	hdrInternal = "x-halflife-internal" // engine's own traffic (must carry the internal token)
)

var (
	cfg         Config
	cues        *cueTable
	store       *stateStore
	dlv         *deliverer
	cnt         = &counters{}
	ready       atomic.Bool
	sweeperStop chan struct{}
)

// ---------------------------------------------------------------- lifecycle

func GetName() string { return "halflife" }

func Init(config any) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("halflife: init panic: %v", r)
		}
	}()
	c, err := parseConfig(config)
	if err != nil {
		return err
	}
	t, err := loadCues(cuesJSON)
	if err != nil {
		return err
	}
	cfg, cues = c, t
	store = newStateStore(c.MaxTrackedReqs, 10*time.Minute)
	dlv = newDeliverer(c, cnt)
	dlv.start()
	sweeperStop = make(chan struct{})
	go sweeper(sweeperStop)
	ready.Store(true)
	logf("init ok: engine=%q mode=%s queue=%d workers=%d ttl=%v cues=%s ingest_token=%v internal_token=%v",
		c.EngineURL, c.DefaultMode, c.QueueSize, c.Workers, *c.ApplyTTL, t.Version,
		c.ingestToken != "", c.internalToken != "")
	return nil
}

func Cleanup() error {
	defer func() { _ = recover() }()
	if !ready.Swap(false) {
		return nil
	}
	close(sweeperStop)
	dlv.close()
	return nil
}

func sweeper(stop chan struct{}) {
	t := time.NewTicker(30 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case now := <-t.C:
			func() {
				defer func() { _ = recover() }()
				cnt.Swept.Add(int64(store.sweep(now)))
			}()
		}
	}
}

func trackedCount() int {
	if store == nil {
		return 0
	}
	return store.size()
}

func logf(format string, a ...any) {
	fmt.Fprintf(os.Stderr, "[halflife] "+format+"\n", a...)
}

// guard is deferred first in every hook. Hooks use named results that are set to the
// pass-through values before any work, so a recovered panic returns the original data.
func guard(hook string) {
	if r := recover(); r != nil {
		cnt.HookPanics.Add(1)
		logf("recovered panic in %s: %v", hook, r)
	}
}

// ---------------------------------------------------------------- helpers

func reportID(ctx *schemas.BifrostContext) string {
	if ctx == nil {
		return ""
	}
	id, _ := ctx.Value(ctxReportID).(string)
	return id
}

func newReportID() string {
	var b [10]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("hl_%x", time.Now().UnixNano())
	}
	return "hl_" + hex.EncodeToString(b[:])
}

func fingerprint(secret string) string {
	if secret == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:6])
}

func isChatPath(p string) bool {
	return strings.HasSuffix(strings.TrimRight(p, "/"), "/chat/completions")
}

// requestBody is the subset of an OpenAI-compatible chat request the plugin reads.
type requestBody struct {
	Model    string `json:"model"`
	Stream   bool   `json:"stream"`
	Messages []struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"messages"`
}

// contentText flattens a chat message content (string or array of parts) to text.
func contentText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) == nil {
		var b strings.Builder
		for _, p := range parts {
			if p.Text != "" {
				if b.Len() > 0 {
					b.WriteByte('\n')
				}
				b.WriteString(p.Text)
			}
		}
		return b.String()
	}
	return ""
}

func messageText(m *schemas.ChatMessage) string {
	if m == nil || m.Content == nil {
		return ""
	}
	if m.Content.ContentStr != nil {
		return *m.Content.ContentStr
	}
	var b strings.Builder
	for _, blk := range m.Content.ContentBlocks {
		if blk.Text != nil {
			if b.Len() > 0 {
				b.WriteByte('\n')
			}
			b.WriteString(*blk.Text)
		}
	}
	return b.String()
}

// applyTTL turns a triage result into semantic-cache context values. The TTL is only ever
// lowered, never raised above the cache's configured default.
func applyTTL(ctx *schemas.BifrostContext, st *reqState, tri TriageResult) {
	st.Triage = tri
	if cfg.ApplyTTL == nil || !*cfg.ApplyTTL {
		st.TTLSet = "default"
		return
	}
	switch {
	case tri.NoStore:
		ctx.SetValue(cacheNoStoreKey, true)
		st.TTLSet = "no-store"
		cnt.NoStore.Add(1)
	case tri.TTLCap > 0 && (cfg.CacheTTLSeconds <= 0 || tri.TTLCap < cfg.CacheTTLSeconds):
		ctx.SetValue(cacheTTLKey, time.Duration(tri.TTLCap)*time.Second)
		st.TTLSet = strconv.Itoa(tri.TTLCap) + "s"
		cnt.TTLApplied.Add(1)
	default:
		st.TTLSet = "default"
	}
}

func payloadFrom(st *reqState) IngestPayload {
	return IngestPayload{
		ReportID:   st.ID,
		ObservedAt: st.Created.UTC(),
		Mode:       st.Mode,
		Stream:     st.Stream,
		Prompt:     st.Prompt,
		Text:       st.Text.String(),
		Truncated:  st.Truncated,
		Model:      st.Model,
		VKPrint:    st.VKPrint,
		Cache:      IngestCache{ID: st.CacheID, Hit: st.CacheHit, TTLSet: st.TTLSet},
		Triage:     IngestTriage{Groups: nonNil(st.Triage.Groups), TTLCap: st.Triage.TTLCap},
		PluginVer:  pluginVersion,
	}
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// ---------------------------------------------------------------- HTTP transport hooks

// HTTPTransportPreHook creates the correlation ID and per-request state. Bifrost's own
// request-id is not set yet at this point (verified in the feasibility sprint).
func HTTPTransportPreHook(ctx *schemas.BifrostContext, req *schemas.HTTPRequest) (resp *schemas.HTTPResponse, err error) {
	defer guard("HTTPTransportPreHook")
	if !ready.Load() || ctx == nil || req == nil || !isChatPath(req.Path) {
		return nil, nil
	}
	cnt.Observed.Add(1)
	st := &reqState{ID: newReportID(), Created: time.Now(), Mode: cfg.DefaultMode, TTLSet: "default"}
	st.Triage.TTLCap = -1

	if tok := req.CaseInsensitiveHeaderLookup(hdrInternal); tok != "" && cfg.internalToken != "" &&
		subtle.ConstantTimeCompare([]byte(tok), []byte(cfg.internalToken)) == 1 {
		cnt.Skipped.Add(1)
		return nil, nil // engine's own traffic: never analyse it (loop prevention)
	}
	if m := strings.ToLower(strings.TrimSpace(req.CaseInsensitiveHeaderLookup(hdrMode))); m != "" {
		if validMode(m) {
			st.Mode = m
		}
	}
	if st.Mode == ModeOff {
		cnt.Skipped.Add(1)
		return nil, nil
	}
	if len(req.Body) > 0 {
		var body requestBody
		if json.Unmarshal(req.Body, &body) == nil {
			st.Model, st.Stream = body.Model, body.Stream
			for i := len(body.Messages) - 1; i >= 0; i-- {
				if body.Messages[i].Role == "user" {
					st.Prompt = truncateUTF8(contentText(body.Messages[i].Content), 4000)
					break
				}
			}
		}
	}
	if st.Stream && st.Mode == ModeVerify {
		st.Mode = ModeAsync // headers commit before the body; streams are verified asynchronously
	}
	st.VKPrint = fingerprint(req.CaseInsensitiveHeaderLookup("x-bf-vk"))
	if !store.put(st) {
		cnt.Untracked.Add(1)
		return nil, nil
	}
	ctx.SetValue(ctxReportID, st.ID)
	return nil, nil
}

// HTTPTransportPostHook runs after every LLM post-hook, including on cache hits and, for
// streams, after the last chunk and before [DONE]. It is the one place where answer text,
// cache_id and hit status are all known, so it is where the job is enqueued.
func HTTPTransportPostHook(ctx *schemas.BifrostContext, req *schemas.HTTPRequest, resp *schemas.HTTPResponse) (err error) {
	defer guard("HTTPTransportPostHook")
	id := reportID(ctx)
	if id == "" || !ready.Load() {
		return nil
	}
	var p *IngestPayload
	var stream bool
	store.with(id, func(st *reqState) {
		stream = st.Stream
		if st.Enqueued {
			return
		}
		if resp != nil && resp.StatusCode >= 400 {
			st.SkipWhy = "upstream-error"
			return
		}
		if !st.Stream && resp != nil && len(resp.Body) > 0 {
			readBody(st, resp.Body)
		}
		if st.Text.Len() == 0 {
			st.SkipWhy = "no-text"
			return
		}
		if st.CacheHit != nil && *st.CacheHit && len(st.Triage.Groups) == 0 && st.Triage.TTLCap < 0 {
			st.Triage = cues.triage(st.Prompt + "\n" + st.Text.String()) // hits skip PostLLMHook
		}
		pl := payloadFrom(st)
		pl.LinkOnly = st.Sync != nil
		p = &pl
		st.Enqueued = true
	})
	if p != nil && !dlv.enqueue(*p) {
		store.with(id, func(st *reqState) { st.SkipWhy = "queue-full" })
	}
	if stream {
		store.remove(id) // stream headers were already written; nothing else needs the state
	}
	return nil
}

// readBody extracts cache_debug (stamped by semantic_cache) and, on cache hits where
// PostLLMHook did not run, the answer text from a non-stream response body.
func readBody(st *reqState, body []byte) {
	var b struct {
		Model   string `json:"model"`
		Choices []struct {
			Message struct {
				Content json.RawMessage `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		ExtraFields struct {
			CacheDebug *struct {
				CacheHit bool    `json:"cache_hit"`
				CacheID  *string `json:"cache_id"`
			} `json:"cache_debug"`
		} `json:"extra_fields"`
	}
	if json.Unmarshal(body, &b) != nil {
		return
	}
	if cd := b.ExtraFields.CacheDebug; cd != nil {
		hit := cd.CacheHit
		st.CacheHit = &hit
		if cd.CacheID != nil {
			st.CacheID = *cd.CacheID
		}
	}
	if st.Model == "" {
		st.Model = b.Model
	}
	if st.Text.Len() == 0 {
		for i, c := range b.Choices {
			if i > 0 {
				st.appendText("\n", cfg.MaxTextBytes)
			}
			st.appendText(contentText(c.Message.Content), cfg.MaxTextBytes)
		}
	}
}

// HTTPTransportResponseHeadersHook stamps Halflife headers. For non-streams it runs after
// HTTPTransportPostHook (so cache info and sync verdicts are known); for streams it runs
// before the first chunk (so only the report ID and the prompt-level TTL are known).
func HTTPTransportResponseHeadersHook(ctx *schemas.BifrostContext, req *schemas.HTTPRequest, resp *schemas.HTTPResponseMetadata) (err error) {
	defer guard("HTTPTransportResponseHeadersHook")
	id := reportID(ctx)
	if id == "" || resp == nil || !ready.Load() {
		return nil
	}
	resp.SetHeader("x-halflife-report", id)
	var stream bool
	store.with(id, func(st *reqState) {
		stream = st.Stream
		resp.SetHeader("x-halflife-mode", st.Mode)
		resp.SetHeader("x-halflife-ttl", st.TTLSet)
		if len(st.Triage.Groups) > 0 {
			resp.SetHeader("x-halflife-triage", strings.Join(st.Triage.Groups, ","))
		} else {
			resp.SetHeader("x-halflife-triage", "none")
		}
		if st.CacheHit != nil && *st.CacheHit {
			resp.SetHeader("x-halflife-cache", "hit")
		}
		resp.SetHeader("x-halflife-status", headerStatus(st))
	})
	if !stream {
		store.remove(id)
	}
	return nil
}

func headerStatus(st *reqState) string {
	switch {
	case st.Sync != nil:
		s := st.Sync.Status
		if st.Sync.Summary != "" {
			s += "; " + sanitizeHeader(st.Sync.Summary)
		}
		return s
	case st.SkipWhy != "":
		return "skipped; " + st.SkipWhy
	case st.Stream:
		return "pending"
	case st.Enqueued:
		return "queued"
	default:
		return "observed"
	}
}

func sanitizeHeader(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r > 0x7e {
			return ' '
		}
		return r
	}, s)
	return truncateUTF8(s, 200)
}

// HTTPTransportStreamChunkHook accumulates streamed text (this hook also runs on cache
// hits, unlike the LLM hooks of a post_builtin plugin) and optionally appends a single
// report pointer to the final chunk.
func HTTPTransportStreamChunkHook(ctx *schemas.BifrostContext, req *schemas.HTTPRequest, chunk *schemas.BifrostStreamChunk) (out *schemas.BifrostStreamChunk, err error) {
	out = chunk
	defer guard("HTTPTransportStreamChunkHook")
	id := reportID(ctx)
	if id == "" || chunk == nil || chunk.BifrostChatResponse == nil || !ready.Load() {
		return chunk, nil
	}
	cr := chunk.BifrostChatResponse
	store.with(id, func(st *reqState) {
		if st.Model == "" {
			st.Model = cr.Model
		}
		if cd := cr.ExtraFields.CacheDebug; cd != nil {
			hit := cd.CacheHit
			st.CacheHit = &hit
			if cd.CacheID != nil {
				st.CacheID = *cd.CacheID
			}
		}
		for i := range cr.Choices {
			c := &cr.Choices[i]
			if c.ChatStreamResponseChoice == nil || c.Delta == nil {
				continue
			}
			if c.Delta.Content != nil {
				st.appendText(*c.Delta.Content, cfg.MaxTextBytes)
			}
			// Bifrost can emit more than one chunk carrying finish_reason (seen in the
			// feasibility probe), so the note is guarded to be appended exactly once.
			if c.FinishReason != nil && cfg.StreamNote && !st.NoteSent {
				st.NoteSent = true
				note := "\n\n[Halflife: freshness check running, report " + st.ID + "]"
				if c.Delta.Content == nil {
					c.Delta.Content = &note
				} else {
					s := *c.Delta.Content + note
					c.Delta.Content = &s
				}
			}
		}
	})
	return chunk, nil
}

// ---------------------------------------------------------------- LLM hooks

// PreLLMHook decides the cache TTL for streams from the prompt alone: the semantic cache
// locks a stream entry's expiry at the first chunk, before any answer text exists.
func PreLLMHook(ctx *schemas.BifrostContext, req *schemas.BifrostRequest) (outReq *schemas.BifrostRequest, sc *schemas.LLMPluginShortCircuit, err error) {
	outReq = req
	defer guard("PreLLMHook")
	id := reportID(ctx)
	if id == "" || !ready.Load() {
		return req, nil, nil
	}
	store.with(id, func(st *reqState) {
		if st.Stream && st.Triage.TTLCap < 0 && len(st.Triage.Groups) == 0 {
			applyTTL(ctx, st, cues.triage(st.Prompt))
		}
	})
	return req, nil, nil
}

// PostLLMHook (non-stream, cache miss): capture the answer, cap the cache TTL from the
// prompt+answer, and in verify mode ask the engine synchronously before the cache write.
// A post_builtin plugin's PostLLMHook runs before semantic_cache's, so a no-store decided
// here prevents a known-stale answer from being cached at all.
func PostLLMHook(ctx *schemas.BifrostContext, resp *schemas.BifrostResponse, bErr *schemas.BifrostError) (outResp *schemas.BifrostResponse, outErr *schemas.BifrostError, err error) {
	outResp, outErr = resp, bErr
	defer guard("PostLLMHook")
	id := reportID(ctx)
	if id == "" || !ready.Load() || bErr != nil || resp == nil || resp.ChatResponse == nil {
		return resp, bErr, nil
	}
	cr := resp.ChatResponse
	var verify bool
	var payload IngestPayload
	found := store.with(id, func(st *reqState) {
		if st.Stream {
			return
		}
		if st.Model == "" {
			st.Model = cr.Model
		}
		for i, c := range cr.Choices {
			if c.ChatNonStreamResponseChoice == nil {
				continue
			}
			if i > 0 {
				st.appendText("\n", cfg.MaxTextBytes)
			}
			st.appendText(messageText(c.Message), cfg.MaxTextBytes)
		}
		applyTTL(ctx, st, cues.triage(st.Prompt+"\n"+st.Text.String()))
		if st.Mode == ModeVerify && st.Text.Len() > 0 {
			verify = true
			payload = payloadFrom(st)
		}
	})
	if !found || !verify {
		return resp, bErr, nil
	}
	// Synchronous call happens outside the store lock.
	res, verr := dlv.verifySync(payload)
	store.with(id, func(st *reqState) {
		if verr != nil {
			st.Sync = &syncResult{Status: "unverified", Summary: "engine unavailable"}
			return
		}
		st.Sync = res
		if res.NoStore && cfg.ApplyTTL != nil && *cfg.ApplyTTL {
			ctx.SetValue(cacheNoStoreKey, true)
			st.TTLSet = "no-store"
			cnt.NoStore.Add(1)
		}
	})
	if verr == nil && res != nil && cfg.AnnotateVerified && res.Annotation != "" {
		annotate(cr, res.Annotation)
	}
	return resp, bErr, nil
}

// annotate appends a plain-text note to the first non-stream choice.
func annotate(cr *schemas.BifrostChatResponse, note string) {
	for i := range cr.Choices {
		c := &cr.Choices[i]
		if c.ChatNonStreamResponseChoice == nil || c.Message == nil || c.Message.Content == nil || c.Message.Content.ContentStr == nil {
			continue
		}
		s := *c.Message.Content.ContentStr + "\n\n" + note
		c.Message.Content.ContentStr = &s
		return
	}
}
