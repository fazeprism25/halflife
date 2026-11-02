package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/maximhq/bifrost/core/schemas"
)

// fakeEngine records ingest payloads. It is a test double for the Halflife engine only.
type fakeEngine struct {
	mu       sync.Mutex
	ingests  []IngestPayload
	auth     []string
	beats    int
	syncResp *syncResult
	delay    time.Duration
	srv      *httptest.Server
}

func newFakeEngine(t *testing.T) *fakeEngine {
	fe := &fakeEngine{}
	fe.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		fe.mu.Lock()
		defer fe.mu.Unlock()
		switch r.URL.Path {
		case "/v1/ingest":
			var p IngestPayload
			_ = json.Unmarshal(b, &p)
			fe.ingests = append(fe.ingests, p)
			fe.auth = append(fe.auth, r.Header.Get("authorization"))
			if p.Sync {
				if fe.delay > 0 {
					fe.mu.Unlock()
					time.Sleep(fe.delay)
					fe.mu.Lock()
				}
				_ = json.NewEncoder(w).Encode(fe.syncResp)
				return
			}
			w.WriteHeader(http.StatusAccepted)
		case "/v1/plugin/heartbeat":
			fe.beats++
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(fe.srv.Close)
	return fe
}

func (fe *fakeEngine) payloads() []IngestPayload {
	fe.mu.Lock()
	defer fe.mu.Unlock()
	return append([]IngestPayload(nil), fe.ingests...)
}

func setup(t *testing.T, extra map[string]any) *fakeEngine {
	t.Helper()
	_ = Cleanup()
	fe := newFakeEngine(t)
	t.Setenv("HL_TEST_INGEST", "ingest-secret")
	t.Setenv("HL_TEST_INTERNAL", "internal-secret")
	c := map[string]any{
		"engine_url":         fe.srv.URL,
		"ingest_token_env":   "HL_TEST_INGEST",
		"internal_token_env": "HL_TEST_INTERNAL",
		"heartbeat_seconds":  3600,
	}
	for k, v := range extra {
		c[k] = v
	}
	if err := Init(c); err != nil {
		t.Fatalf("Init: %v", err)
	}
	t.Cleanup(func() { _ = Cleanup() })
	return fe
}

func newCtx() *schemas.BifrostContext {
	return schemas.NewBifrostContext(context.Background(), schemas.NoDeadline)
}

func chatReq(body string, headers map[string]string) *schemas.HTTPRequest {
	h := map[string]string{"content-type": "application/json"}
	for k, v := range headers {
		h[k] = v
	}
	return &schemas.HTTPRequest{Method: "POST", Path: "/v1/chat/completions", Headers: h, Body: []byte(body)}
}

func chatResp(text string) *schemas.BifrostResponse {
	return &schemas.BifrostResponse{ChatResponse: &schemas.BifrostChatResponse{
		Model: "test-model",
		Choices: []schemas.BifrostResponseChoice{{
			ChatNonStreamResponseChoice: &schemas.ChatNonStreamResponseChoice{
				Message: &schemas.ChatMessage{Role: "assistant", Content: &schemas.ChatMessageContent{ContentStr: &text}},
			},
		}},
	}}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not met within 3s")
}

// runNonStream drives the hooks in Bifrost's documented order for a non-stream cache miss.
func runNonStream(t *testing.T, ctx *schemas.BifrostContext, req *schemas.HTTPRequest, answer string, body string) (*schemas.BifrostResponse, *schemas.HTTPResponseMetadata) {
	t.Helper()
	if r, err := HTTPTransportPreHook(ctx, req); r != nil || err != nil {
		t.Fatalf("pre hook short-circuited: %v %v", r, err)
	}
	if _, _, err := PreLLMHook(ctx, &schemas.BifrostRequest{}); err != nil {
		t.Fatal(err)
	}
	resp, _, err := PostLLMHook(ctx, chatResp(answer), nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := HTTPTransportPostHook(ctx, req, &schemas.HTTPResponse{StatusCode: 200, Body: []byte(body)}); err != nil {
		t.Fatal(err)
	}
	md := &schemas.HTTPResponseMetadata{Headers: map[string]string{}}
	if err := HTTPTransportResponseHeadersHook(ctx, req, md); err != nil {
		t.Fatal(err)
	}
	return resp, md
}

// ---------------------------------------------------------------- config

func TestParseConfigDefaultsAndValidation(t *testing.T) {
	c, err := parseConfig(nil)
	if err != nil || c.DefaultMode != ModeAsync || c.QueueSize != 256 || !*c.ApplyTTL || c.CacheTTLSeconds != 300 {
		t.Fatalf("defaults wrong: %+v %v", c, err)
	}
	if _, err := parseConfig(map[string]any{"default_mode": "loud"}); err == nil {
		t.Fatal("invalid mode accepted")
	}
	if _, err := parseConfig(map[string]any{"engine_url": "ftp://x"}); err == nil {
		t.Fatal("non-http engine_url accepted")
	}
	c, _ = parseConfig(map[string]any{"queue_size": 10_000_000, "workers": -3, "engine_url": "http://e:1/"})
	if c.QueueSize != 100000 || c.Workers != 4 || c.EngineURL != "http://e:1" {
		t.Fatalf("clamping wrong: %+v", c)
	}
}

// ---------------------------------------------------------------- triage

func TestSharedCuesCompileAndTriage(t *testing.T) {
	tab, err := loadCues(cuesJSON)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		text    string
		groups  string
		cap     int
		noStore bool
	}{
		{"Bitcoin is trading at $64,000 today.", "market", 0, true},
		{"Satya Nadella is the CEO of Microsoft.", "leadership", 21600, false},
		{"The latest version of Node.js is 22.", "recency,software", 3600, false},
		{"Water boils at 100 degrees Celsius at sea level.", "", -1, false},
		{"The Battle of Hastings took place in 1066.", "", -1, false},
	}
	for _, c := range cases {
		r := tab.triage(c.text)
		if strings.Join(r.Groups, ",") != c.groups || r.TTLCap != c.cap || r.NoStore != c.noStore {
			t.Errorf("triage(%q) = %+v, want groups=%q cap=%d nostore=%v", c.text, r, c.groups, c.cap, c.noStore)
		}
	}
}

// The keyword gate must be a pure optimisation: on any text, gated triage equals running every
// regex. The corpus mixes matches, near-misses and casing variants.
func TestKeywordGateNeverChangesTriage(t *testing.T) {
	tab, err := loadCues(cuesJSON)
	if err != nil {
		t.Fatal(err)
	}
	ungated := func(text string) []string {
		var out []string
		for _, g := range tab.Groups {
			for _, re := range g.compiled {
				if re.MatchString(text) {
					out = append(out, g.ID)
					break
				}
			}
		}
		return out
	}
	corpus := []string{
		"The STOCK PRICE of Apple is $190.", "ETH trades near $3,200 today", "It costs about €20.", "Priced at $999.",
		"Python 3.13 is the latest.", "The most recent stable release is 2.0", "It shipped on March 3.",
		"Satya Nadella, CEO.", "the Secretary-General said", "Chairwoman Lee", "Prime Minister Starmer",
		"India's population is 1.4 billion.", "GDP grew", "Netflix has 300 million subscribers.",
		"As of 2024, yes.", "Nowadays few do.", "The reigning champion won the 2024 final.", "This season was long.",
		"The tallest building", "a world record", "ranked number 1", "Water boils at 100 C.", "The cat sat.",
		"Ceo", "chairs and tables", "Recorded music", "decision", "costume", "shipping", "the currentness of data",
	}
	filler := strings.Repeat("plain words without any cue at all ", 12)
	for _, s := range []string{"Version 2.4.1 of the tool was the latest.", "It costs roughly $12 per month.", "Release notes: v10.2 is the current build"} {
		corpus = append(corpus, filler+s+" "+filler, s+filler, filler+s, strings.Repeat("the latest news. ", 20)+s)
	}
	for _, s := range corpus {
		got := tab.triage(s).Groups
		want := ungated(s)
		sort.Strings(want)
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Errorf("%q: gated %v, ungated %v", s, got, want)
		}
	}
}

func BenchmarkTriage(b *testing.B) {
	tab, _ := loadCues(cuesJSON)
	text := strings.Repeat("Satya Nadella is the CEO of Microsoft. The latest version of Windows is Windows 11. ", 8)
	b.SetBytes(int64(len(text)))
	for i := 0; i < b.N; i++ {
		tab.triage(text)
	}
}

func TestLoadCuesRejectsBadInput(t *testing.T) {
	for _, b := range []string{`{`, `{"groups":[]}`, `{"groups":[{"id":"x","ttl_seconds":1,"keywords":["x"],"patterns":["("]}]}`, `{"groups":[{"id":"x","ttl_seconds":1,"patterns":["x"]}]}`} {
		if _, err := loadCues([]byte(b)); err == nil {
			t.Errorf("accepted %s", b)
		}
	}
}

func TestTruncateUTF8NeverSplitsRunes(t *testing.T) {
	s := "héllo wörld"
	for n := 0; n <= len(s); n++ {
		out := truncateUTF8(s, n)
		if len(out) > n || !strings.HasPrefix(s, out) || !utf8Valid(out) {
			t.Fatalf("n=%d -> %q", n, out)
		}
	}
}

func utf8Valid(s string) bool { return strings.ToValidUTF8(s, "�") == s }

// ---------------------------------------------------------------- state

func TestStateStoreBoundedAndSweeps(t *testing.T) {
	s := newStateStore(2, time.Minute)
	now := time.Now()
	if !s.put(&reqState{ID: "a", Created: now.Add(-2 * time.Minute)}) || !s.put(&reqState{ID: "b", Created: now}) {
		t.Fatal("put failed")
	}
	if s.put(&reqState{ID: "c", Created: now}) {
		t.Fatal("store exceeded bound")
	}
	if n := s.sweep(now); n != 1 || s.size() != 1 {
		t.Fatalf("sweep removed %d, size %d", n, s.size())
	}
}

// ---------------------------------------------------------------- hooks

func TestNonStreamFlowSetsTTLHeadersAndIngests(t *testing.T) {
	fe := setup(t, nil)
	ctx := newCtx()
	req := chatReq(`{"model":"openai/gpt-x","messages":[{"role":"user","content":"Who is the CEO of Twitter?"}]}`, map[string]string{"x-bf-vk": "sk-bf-secret"})
	answer := "As of 2023, Linda Yaccarino is the CEO of Twitter."
	body := `{"choices":[{"message":{"content":"x"}}],"extra_fields":{"cache_debug":{"cache_hit":false,"cache_id":"cid-1"}}}`
	_, md := runNonStream(t, ctx, req, answer, body)

	if ttl, _ := ctx.Value(cacheTTLKey).(time.Duration); ttl != 300*time.Second && ttl != 0 {
		// leadership cap (6h) exceeds the 300s cache default, so the TTL must be left alone
		t.Fatalf("TTL raised above default: %v", ttl)
	}
	if md.Headers["x-halflife-report"] == "" || md.Headers["x-halflife-status"] != "queued" || !strings.Contains(md.Headers["x-halflife-triage"], "leadership") {
		t.Fatalf("headers: %+v", md.Headers)
	}
	waitFor(t, func() bool { return len(fe.payloads()) == 1 })
	p := fe.payloads()[0]
	if p.Text != answer || p.Prompt != "Who is the CEO of Twitter?" || p.Cache.ID != "cid-1" || p.Model != "openai/gpt-x" {
		t.Fatalf("payload: %+v", p)
	}
	if p.VKPrint == "" || strings.Contains(p.VKPrint, "secret") {
		t.Fatalf("vk fingerprint leaks or missing: %q", p.VKPrint)
	}
	if fe.auth[0] != "Bearer ingest-secret" {
		t.Fatalf("ingest auth header %q", fe.auth[0])
	}
	if trackedCount() != 0 {
		t.Fatalf("state not released: %d", trackedCount())
	}
}

func TestVolatileAnswerIsNotStoredAndShortTTLApplied(t *testing.T) {
	setup(t, map[string]any{"cache_ttl_seconds": 86400})
	ctx := newCtx()
	req := chatReq(`{"model":"m","messages":[{"role":"user","content":"price?"}]}`, nil)
	runNonStream(t, ctx, req, "Bitcoin is trading at $64,000.", `{}`)
	if ns, _ := ctx.Value(cacheNoStoreKey).(bool); !ns {
		t.Fatal("no-store not set for market price answer")
	}
	ctx2 := newCtx()
	runNonStream(t, ctx2, chatReq(`{"model":"m","messages":[{"role":"user","content":"x"}]}`, nil), "The latest version of Go is 1.27.", `{}`)
	if ttl, _ := ctx2.Value(cacheTTLKey).(time.Duration); ttl != time.Hour {
		t.Fatalf("software TTL cap = %v, want 1h", ttl)
	}
}

func TestInternalTrafficIsSkippedOnlyWithValidToken(t *testing.T) {
	fe := setup(t, nil)
	ctx := newCtx()
	HTTPTransportPreHook(ctx, chatReq(`{"messages":[]}`, map[string]string{hdrInternal: "internal-secret"}))
	if reportID(ctx) != "" {
		t.Fatal("internal request was tracked")
	}
	forged := newCtx()
	HTTPTransportPreHook(forged, chatReq(`{"messages":[]}`, map[string]string{hdrInternal: "guess"}))
	if reportID(forged) == "" {
		t.Fatal("forged internal header bypassed Halflife")
	}
	_ = fe
}

func TestModeOffHeaderPassesThrough(t *testing.T) {
	setup(t, nil)
	ctx := newCtx()
	HTTPTransportPreHook(ctx, chatReq(`{"messages":[]}`, map[string]string{hdrMode: "off"}))
	if reportID(ctx) != "" {
		t.Fatal("mode off still tracked")
	}
}

func TestNonChatPathsIgnored(t *testing.T) {
	setup(t, nil)
	ctx := newCtx()
	HTTPTransportPreHook(ctx, &schemas.HTTPRequest{Method: "POST", Path: "/v1/embeddings", Headers: map[string]string{}})
	if reportID(ctx) != "" {
		t.Fatal("embeddings request tracked")
	}
}

func TestCacheHitReadsTextFromBodyAndLinks(t *testing.T) {
	fe := setup(t, nil)
	ctx := newCtx()
	req := chatReq(`{"model":"m","messages":[{"role":"user","content":"Who is the CEO of X?"}]}`, nil)
	HTTPTransportPreHook(ctx, req)
	// post_builtin LLM hooks do not run on hits; only transport hooks do.
	body := `{"model":"m","choices":[{"message":{"content":"The CEO of X is Jane."}}],"extra_fields":{"cache_debug":{"cache_hit":true,"cache_id":"cid-9"}}}`
	HTTPTransportPostHook(ctx, req, &schemas.HTTPResponse{StatusCode: 200, Body: []byte(body)})
	md := &schemas.HTTPResponseMetadata{Headers: map[string]string{}}
	HTTPTransportResponseHeadersHook(ctx, req, md)
	if md.Headers["x-halflife-cache"] != "hit" {
		t.Fatalf("headers: %+v", md.Headers)
	}
	waitFor(t, func() bool { return len(fe.payloads()) == 1 })
	p := fe.payloads()[0]
	if p.Cache.Hit == nil || !*p.Cache.Hit || p.Cache.ID != "cid-9" || p.Text != "The CEO of X is Jane." || len(p.Triage.Groups) == 0 {
		t.Fatalf("payload: %+v", p)
	}
}

func TestUpstreamErrorNotEnqueued(t *testing.T) {
	fe := setup(t, nil)
	ctx := newCtx()
	req := chatReq(`{"messages":[]}`, nil)
	HTTPTransportPreHook(ctx, req)
	PostLLMHook(ctx, nil, &schemas.BifrostError{})
	HTTPTransportPostHook(ctx, req, &schemas.HTTPResponse{StatusCode: 502, Body: []byte(`{"error":{}}`)})
	time.Sleep(100 * time.Millisecond)
	if len(fe.payloads()) != 0 {
		t.Fatal("error response was enqueued")
	}
}

func TestStreamFlowAccumulatesAndNotesOnce(t *testing.T) {
	fe := setup(t, map[string]any{"stream_note": true})
	ctx := newCtx()
	req := chatReq(`{"model":"m","stream":true,"messages":[{"role":"user","content":"What is the latest version of Python?"}]}`, nil)
	HTTPTransportPreHook(ctx, req)
	PreLLMHook(ctx, &schemas.BifrostRequest{})
	if ttl, _ := ctx.Value(cacheTTLKey).(time.Duration); ttl != 0 {
		// software cue matches the *prompt* ("latest version"): cap 1h > 300s default -> untouched
		t.Fatalf("unexpected TTL %v", ttl)
	}
	md := &schemas.HTTPResponseMetadata{Headers: map[string]string{}}
	HTTPTransportResponseHeadersHook(ctx, req, md)
	if md.Headers["x-halflife-status"] != "pending" {
		t.Fatalf("stream status header %q", md.Headers["x-halflife-status"])
	}
	stop := "stop"
	mk := func(content *string, finish *string) *schemas.BifrostStreamChunk {
		return &schemas.BifrostStreamChunk{BifrostChatResponse: &schemas.BifrostChatResponse{Model: "m", Choices: []schemas.BifrostResponseChoice{{
			FinishReason:             finish,
			ChatStreamResponseChoice: &schemas.ChatStreamResponseChoice{Delta: &schemas.ChatStreamResponseChoiceDelta{Content: content}},
		}}}}
	}
	a, b := "Python 3.13 ", "is the latest."
	var client strings.Builder
	for _, ch := range []*schemas.BifrostStreamChunk{mk(&a, nil), mk(&b, nil), mk(nil, &stop), mk(nil, &stop)} {
		out, _ := HTTPTransportStreamChunkHook(ctx, req, ch)
		if c := out.BifrostChatResponse.Choices[0].Delta.Content; c != nil {
			client.WriteString(*c)
		}
	}
	if strings.Count(client.String(), "[Halflife:") != 1 {
		t.Fatalf("note count wrong in %q", client.String())
	}
	HTTPTransportPostHook(ctx, req, &schemas.HTTPResponse{StatusCode: 200})
	waitFor(t, func() bool { return len(fe.payloads()) == 1 })
	if p := fe.payloads()[0]; p.Text != a+b || !p.Stream {
		t.Fatalf("stream payload text %q", p.Text)
	}
	if trackedCount() != 0 {
		t.Fatal("stream state not released")
	}
}

func TestVerifyModeNoStoreAndAnnotation(t *testing.T) {
	fe := setup(t, map[string]any{"annotate_verified": true})
	fe.syncResp = &syncResult{Status: "verified", Summary: "1 claim, 1 superseded", Stale: 1, NoStore: true, Annotation: "Halflife: 1 claim may be outdated."}
	ctx := newCtx()
	req := chatReq(`{"model":"m","messages":[{"role":"user","content":"Who is the CEO of Twitter?"}]}`, map[string]string{hdrMode: "verify"})
	resp, md := runNonStream(t, ctx, req, "Jack Dorsey is the CEO of Twitter.", `{}`)
	if ns, _ := ctx.Value(cacheNoStoreKey).(bool); !ns {
		t.Fatal("stale verdict did not set no-store")
	}
	got := *resp.ChatResponse.Choices[0].Message.Content.ContentStr
	if !strings.HasSuffix(got, "Halflife: 1 claim may be outdated.") {
		t.Fatalf("annotation missing: %q", got)
	}
	if md.Headers["x-halflife-status"] != "verified; 1 claim, 1 superseded" {
		t.Fatalf("status header %q", md.Headers["x-halflife-status"])
	}
	waitFor(t, func() bool { return len(fe.payloads()) == 2 })
	if !fe.payloads()[1].LinkOnly {
		t.Fatal("second ingest must be link-only (analysis already done)")
	}
}

func TestVerifyModeTimeoutFailsOpen(t *testing.T) {
	fe := setup(t, map[string]any{"sync_timeout_ms": 500})
	fe.syncResp = &syncResult{Status: "verified"}
	fe.delay = 2 * time.Second
	ctx := newCtx()
	req := chatReq(`{"model":"m","messages":[{"role":"user","content":"q"}]}`, map[string]string{hdrMode: "verify"})
	start := time.Now()
	resp, md := runNonStream(t, ctx, req, "Some answer.", `{}`)
	if time.Since(start) > 1500*time.Millisecond {
		t.Fatalf("sync timeout not enforced: %v", time.Since(start))
	}
	if *resp.ChatResponse.Choices[0].Message.Content.ContentStr != "Some answer." {
		t.Fatal("response altered on engine failure")
	}
	if !strings.HasPrefix(md.Headers["x-halflife-status"], "unverified") {
		t.Fatalf("status %q", md.Headers["x-halflife-status"])
	}
}

func TestEngineDownNeverAffectsResponse(t *testing.T) {
	_ = Cleanup()
	if err := Init(map[string]any{"engine_url": "http://127.0.0.1:1", "ingest_timeout_ms": 200, "heartbeat_seconds": 3600}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = Cleanup() })
	ctx := newCtx()
	resp, md := runNonStream(t, ctx, chatReq(`{"messages":[]}`, nil), "Answer.", `{}`)
	if *resp.ChatResponse.Choices[0].Message.Content.ContentStr != "Answer." || md.Headers["x-halflife-status"] != "queued" {
		t.Fatal("engine outage affected inference")
	}
	waitFor(t, func() bool { return cnt.DeliverFailed.Load() > 0 })
}

func TestQueueFullDropsWithoutBlocking(t *testing.T) {
	setup(t, map[string]any{"queue_size": 1, "workers": 1})
	// Stop the workers so the queue fills deterministically.
	dlv.close()
	dlv.queue = make(chan IngestPayload, 1)
	before := cnt.Dropped.Load()
	for i := 0; i < 3; i++ {
		start := time.Now()
		dlv.enqueue(IngestPayload{ReportID: "x"})
		if time.Since(start) > 50*time.Millisecond {
			t.Fatal("enqueue blocked")
		}
	}
	if cnt.Dropped.Load()-before != 2 {
		t.Fatalf("dropped %d, want 2", cnt.Dropped.Load()-before)
	}
}

func TestHookPanicIsRecoveredAndPassesThrough(t *testing.T) {
	setup(t, nil)
	ctx := newCtx()
	HTTPTransportPreHook(ctx, chatReq(`{"messages":[]}`, nil))
	saved := store
	store = nil // force a nil-pointer panic inside the hook
	defer func() { store = saved }()
	before := cnt.HookPanics.Load()
	orig := chatResp("original")
	out, outErr, err := PostLLMHook(ctx, orig, nil)
	if out != orig || outErr != nil || err != nil {
		t.Fatal("panicking hook did not pass the response through")
	}
	if _, err := HTTPTransportStreamChunkHook(ctx, nil, &schemas.BifrostStreamChunk{BifrostChatResponse: &schemas.BifrostChatResponse{}}); err != nil {
		t.Fatal(err)
	}
	if cnt.HookPanics.Load()-before != 2 {
		t.Fatalf("panics counted %d, want 2", cnt.HookPanics.Load()-before)
	}
}

func TestHooksBeforeInitAreNoOps(t *testing.T) {
	_ = Cleanup()
	ctx := newCtx()
	if r, err := HTTPTransportPreHook(ctx, chatReq(`{}`, nil)); r != nil || err != nil || reportID(ctx) != "" {
		t.Fatal("hook acted before Init")
	}
	orig := chatResp("x")
	if out, _, _ := PostLLMHook(ctx, orig, nil); out != orig {
		t.Fatal("PostLLMHook changed response before Init")
	}
}

func TestConcurrentRequestsRaceFree(t *testing.T) {
	fe := setup(t, map[string]any{"queue_size": 1000})
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx := newCtx()
			runNonStream(t, ctx, chatReq(`{"messages":[{"role":"user","content":"latest version?"}]}`, nil), "The latest version is 2.", `{}`)
		}()
	}
	wg.Wait()
	waitFor(t, func() bool { return len(fe.payloads()) == 50 })
}

func BenchmarkInlineHooks(b *testing.B) {
	_ = Cleanup()
	_ = Init(map[string]any{"queue_size": 100000, "heartbeat_seconds": 3600}) // no engine: delivery fails fast, isolating hook cost
	defer Cleanup()
	req := chatReq(`{"model":"m","messages":[{"role":"user","content":"Who is the current CEO of Microsoft and what is the latest Windows version?"}]}`, nil)
	answer := strings.Repeat("Satya Nadella is the CEO of Microsoft. The latest version of Windows is Windows 11. ", 8)
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		ctx := newCtx()
		HTTPTransportPreHook(ctx, req)
		PreLLMHook(ctx, &schemas.BifrostRequest{})
		PostLLMHook(ctx, chatResp(answer), nil)
		HTTPTransportPostHook(ctx, req, &schemas.HTTPResponse{StatusCode: 200, Body: []byte(`{}`)})
		HTTPTransportResponseHeadersHook(ctx, req, &schemas.HTTPResponseMetadata{Headers: map[string]string{}})
		if len(dlv.queue) > 90000 {
			b.StopTimer()
			for len(dlv.queue) > 0 {
				<-dlv.queue
			}
			b.StartTimer()
		}
	}
}
