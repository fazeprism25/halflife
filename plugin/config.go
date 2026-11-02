package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"
)

// Mode controls what Halflife does with a request.
//
//	off     pass through untouched (no capture, no TTL change)
//	async   default: inline TTL triage + background verification
//	verify  synchronous verification before the response is returned (non-stream only;
//	        streams fall back to async because headers commit before the body)
const (
	ModeOff    = "off"
	ModeAsync  = "async"
	ModeVerify = "verify"
)

// Config is the plugin's config.json block. Secrets are never placed here: the plugin
// reads them from the environment variables named by the *_env fields.
type Config struct {
	EngineURL        string `json:"engine_url"`         // e.g. http://engine:8090 (internal network, not via the gateway)
	IngestTokenEnv   string `json:"ingest_token_env"`   // env var holding the plugin->engine bearer token
	InternalTokenEnv string `json:"internal_token_env"` // env var holding the token the engine sends on its own LLM calls
	DefaultMode      string `json:"default_mode"`       // off | async | verify
	QueueSize        int    `json:"queue_size"`
	Workers          int    `json:"workers"`
	IngestTimeoutMS  int    `json:"ingest_timeout_ms"`
	SyncTimeoutMS    int    `json:"sync_timeout_ms"`
	MaxTextBytes     int    `json:"max_text_bytes"`
	MaxTrackedReqs   int    `json:"max_tracked_requests"`
	ApplyTTL         *bool  `json:"apply_ttl"`         // default true
	StreamNote       bool   `json:"stream_note"`       // append a one-line report pointer to the final streamed chunk
	AnnotateVerified bool   `json:"annotate_verified"` // verify mode: append a freshness note to the answer text
	HeartbeatSeconds int    `json:"heartbeat_seconds"`
	CacheTTLSeconds  int    `json:"cache_ttl_seconds"` // the semantic cache's configured TTL; Halflife only ever lowers it

	// resolved at Init
	ingestToken   string
	internalToken string
}

func defaultConfig() Config {
	t := true
	return Config{
		DefaultMode:      ModeAsync,
		QueueSize:        256,
		Workers:          4,
		IngestTimeoutMS:  3000,
		SyncTimeoutMS:    25000,
		MaxTextBytes:     32 * 1024,
		MaxTrackedReqs:   10000,
		ApplyTTL:         &t,
		HeartbeatSeconds: 10,
		CacheTTLSeconds:  300,
	}
}

// parseConfig converts the raw value Bifrost passes to Init into a validated Config.
func parseConfig(raw any) (Config, error) {
	c := defaultConfig()
	if raw != nil {
		b, err := json.Marshal(raw)
		if err != nil {
			return c, fmt.Errorf("config: %w", err)
		}
		if err := json.Unmarshal(b, &c); err != nil {
			return c, fmt.Errorf("config: %w", err)
		}
	}
	if c.ApplyTTL == nil {
		t := true
		c.ApplyTTL = &t
	}
	c.DefaultMode = strings.ToLower(strings.TrimSpace(c.DefaultMode))
	if c.DefaultMode == "" {
		c.DefaultMode = ModeAsync
	}
	if !validMode(c.DefaultMode) {
		return c, fmt.Errorf("config: default_mode %q must be off, async or verify", c.DefaultMode)
	}
	if c.EngineURL != "" {
		u, err := url.Parse(c.EngineURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return c, fmt.Errorf("config: engine_url %q must be an absolute http(s) URL", c.EngineURL)
		}
		c.EngineURL = strings.TrimRight(c.EngineURL, "/")
	}
	clamp := func(v *int, lo, hi, def int) {
		if *v <= 0 {
			*v = def
		}
		if *v < lo {
			*v = lo
		}
		if *v > hi {
			*v = hi
		}
	}
	d := defaultConfig()
	clamp(&c.QueueSize, 1, 100000, d.QueueSize)
	clamp(&c.Workers, 1, 64, d.Workers)
	clamp(&c.IngestTimeoutMS, 100, 60000, d.IngestTimeoutMS)
	clamp(&c.SyncTimeoutMS, 500, 120000, d.SyncTimeoutMS)
	clamp(&c.MaxTextBytes, 256, 1<<20, d.MaxTextBytes)
	clamp(&c.MaxTrackedReqs, 16, 1000000, d.MaxTrackedReqs)
	clamp(&c.HeartbeatSeconds, 2, 3600, d.HeartbeatSeconds)
	clamp(&c.CacheTTLSeconds, 1, 30*24*3600, d.CacheTTLSeconds)
	if c.IngestTokenEnv != "" {
		c.ingestToken = os.Getenv(c.IngestTokenEnv)
	}
	if c.InternalTokenEnv != "" {
		c.internalToken = os.Getenv(c.InternalTokenEnv)
	}
	return c, nil
}

func validMode(m string) bool { return m == ModeOff || m == ModeAsync || m == ModeVerify }

func (c Config) ingestTimeout() time.Duration { return time.Duration(c.IngestTimeoutMS) * time.Millisecond }
func (c Config) syncTimeout() time.Duration   { return time.Duration(c.SyncTimeoutMS) * time.Millisecond }
