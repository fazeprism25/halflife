package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

// IngestPayload is what the plugin hands to the engine. It contains no credentials: the
// virtual key is reduced to a short SHA-256 fingerprint.
type IngestPayload struct {
	ReportID     string       `json:"report_id"`
	ObservedAt   time.Time    `json:"observed_at"`
	Mode         string       `json:"mode"`
	Stream       bool         `json:"stream"`
	Prompt       string       `json:"prompt,omitempty"`
	Text         string       `json:"text"`
	Truncated    bool         `json:"truncated,omitempty"`
	Model        string       `json:"model,omitempty"`
	VKPrint      string       `json:"vk_fingerprint,omitempty"`
	Cache        IngestCache  `json:"cache"`
	Triage       IngestTriage `json:"triage"`
	Sync         bool         `json:"sync,omitempty"`
	PluginVer    string       `json:"plugin_version"`
	LinkOnly     bool         `json:"link_only,omitempty"` // verify mode: analysis already ran, this only attaches cache info
}

type IngestCache struct {
	ID      string `json:"id,omitempty"`
	Hit     *bool  `json:"hit,omitempty"`
	TTLSet  string `json:"ttl_set,omitempty"`
}

type IngestTriage struct {
	Groups []string `json:"groups"`
	TTLCap int      `json:"ttl_cap_seconds"`
}

// syncResult is the engine's synchronous answer in verify mode.
type syncResult struct {
	Status     string `json:"status"`      // verified | partial | unverified | failed
	Summary    string `json:"summary"`     // short header-safe summary, e.g. "3 claims, 1 superseded"
	Stale      int    `json:"stale"`       // claims judged superseded/contradicted with >= moderate evidence
	NoStore    bool   `json:"no_store"`    // engine recommends not caching this answer
	Annotation string `json:"annotation"`  // optional plain-text note to append
}

type counters struct {
	Observed      atomic.Int64
	Skipped       atomic.Int64
	Enqueued      atomic.Int64
	Dropped       atomic.Int64
	Untracked     atomic.Int64
	Delivered     atomic.Int64
	DeliverFailed atomic.Int64
	HookPanics    atomic.Int64
	SyncCalls     atomic.Int64
	SyncFailed    atomic.Int64
	TTLApplied    atomic.Int64
	NoStore       atomic.Int64
	Swept         atomic.Int64
}

func (c *counters) snapshot() map[string]int64 {
	return map[string]int64{
		"observed": c.Observed.Load(), "skipped": c.Skipped.Load(), "enqueued": c.Enqueued.Load(),
		"dropped": c.Dropped.Load(), "untracked": c.Untracked.Load(), "delivered": c.Delivered.Load(),
		"deliver_failed": c.DeliverFailed.Load(), "hook_panics": c.HookPanics.Load(),
		"sync_calls": c.SyncCalls.Load(), "sync_failed": c.SyncFailed.Load(),
		"ttl_applied": c.TTLApplied.Load(), "no_store": c.NoStore.Load(), "swept": c.Swept.Load(),
	}
}

// deliverer owns the bounded queue and worker pool. Enqueue never blocks: when the queue is
// full the job is dropped and counted (load shedding proven in the feasibility sprint).
type deliverer struct {
	cfg     Config
	client     *http.Client
	syncClient *http.Client
	queue   chan IngestPayload
	stop    chan struct{}
	wg      sync.WaitGroup
	cnt     *counters
	started time.Time
	once    sync.Once
}

func newDeliverer(cfg Config, cnt *counters) *deliverer {
	return &deliverer{
		cfg:     cfg,
		client:     &http.Client{Timeout: cfg.ingestTimeout()},
		syncClient: &http.Client{Timeout: cfg.syncTimeout()},
		queue:   make(chan IngestPayload, cfg.QueueSize),
		stop:    make(chan struct{}),
		cnt:     cnt,
		started: time.Now(),
	}
}

func (d *deliverer) start() {
	for i := 0; i < d.cfg.Workers; i++ {
		d.wg.Add(1)
		go d.worker()
	}
	d.wg.Add(1)
	go d.heartbeat()
}

func (d *deliverer) close() {
	d.once.Do(func() { close(d.stop) })
	done := make(chan struct{})
	go func() { d.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
	}
}

func (d *deliverer) enqueue(p IngestPayload) bool {
	select {
	case d.queue <- p:
		d.cnt.Enqueued.Add(1)
		return true
	default:
		d.cnt.Dropped.Add(1)
		return false
	}
}

func (d *deliverer) depth() int { return len(d.queue) }

func (d *deliverer) worker() {
	defer d.wg.Done()
	for {
		select {
		case <-d.stop:
			return
		case p := <-d.queue:
			d.safeDeliver(p)
		}
	}
}

func (d *deliverer) safeDeliver(p IngestPayload) {
	defer func() {
		if r := recover(); r != nil {
			d.cnt.HookPanics.Add(1)
			d.cnt.DeliverFailed.Add(1)
		}
	}()
	// One retry on transport errors / 5xx, with a short backoff. 4xx is not retried.
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		if attempt > 0 {
			select {
			case <-d.stop:
				return
			case <-time.After(400 * time.Millisecond):
			}
		}
		var retry bool
		retry, err = d.post(context.Background(), d.client, "/v1/ingest", p, nil, d.cfg.ingestTimeout())
		if err == nil {
			d.cnt.Delivered.Add(1)
			return
		}
		if !retry {
			break
		}
	}
	d.cnt.DeliverFailed.Add(1)
}

// post sends JSON to the engine. It returns whether a failure is worth retrying.
func (d *deliverer) post(ctx context.Context, client *http.Client, path string, body any, out any, timeout time.Duration) (bool, error) {
	if d.cfg.EngineURL == "" {
		return false, errors.New("engine_url not configured")
	}
	b, err := json.Marshal(body)
	if err != nil {
		return false, err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, d.cfg.EngineURL+path, bytes.NewReader(b))
	if err != nil {
		return false, err
	}
	req.Header.Set("content-type", "application/json")
	if d.cfg.ingestToken != "" {
		req.Header.Set("authorization", "Bearer "+d.cfg.ingestToken)
	}
	resp, err := client.Do(req)
	if err != nil {
		return true, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode >= 500 {
		return true, fmt.Errorf("engine %s: %d", path, resp.StatusCode)
	}
	if resp.StatusCode >= 300 {
		return false, fmt.Errorf("engine %s: %d", path, resp.StatusCode)
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			return false, fmt.Errorf("engine %s: bad json: %w", path, err)
		}
	}
	return false, nil
}

// verifySync asks the engine to analyse the text now (verify mode). Bounded by
// sync_timeout_ms; on any failure the caller serves the original response unchanged.
func (d *deliverer) verifySync(p IngestPayload) (*syncResult, error) {
	d.cnt.SyncCalls.Add(1)
	p.Sync = true
	var out syncResult
	if _, err := d.post(context.Background(), d.syncClient, "/v1/ingest", p, &out, d.cfg.syncTimeout()); err != nil {
		d.cnt.SyncFailed.Add(1)
		return nil, err
	}
	return &out, nil
}

func (d *deliverer) heartbeat() {
	defer d.wg.Done()
	t := time.NewTicker(time.Duration(d.cfg.HeartbeatSeconds) * time.Second)
	defer t.Stop()
	send := func() {
		defer func() { _ = recover() }()
		_, _ = d.post(context.Background(), d.client, "/v1/plugin/heartbeat", map[string]any{
			"plugin_version": pluginVersion,
			"started_at":     d.started,
			"queue_depth":    d.depth(),
			"queue_size":     d.cfg.QueueSize,
			"tracked":        trackedCount(),
			"counters":       d.cnt.snapshot(),
		}, nil, d.cfg.ingestTimeout())
	}
	send()
	for {
		select {
		case <-d.stop:
			return
		case <-t.C:
			send()
		}
	}
}
