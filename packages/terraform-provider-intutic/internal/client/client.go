// Package client is a minimal HTTP client for the Intutic control plane's
// public REST API, scoped to the routes the Terraform provider manages.
package client

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Client calls the control plane as one workspace member, identified by an
// API key. Every route resolves the workspace from that key, so the client
// never names a workspace itself.
type Client struct {
	baseURL    string
	apiKey     string
	userAgent  string
	httpClient *http.Client
	// maxRetries bounds retries of a 429 or a gateway error. A test sets it to
	// zero; the provider keeps the default.
	maxRetries int
	sleep      func(time.Duration)
}

// New returns a client for baseURL (no trailing slash needed).
func New(baseURL, apiKey, userAgent string) *Client {
	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		apiKey:     apiKey,
		userAgent:  userAgent,
		httpClient: &http.Client{Timeout: 60 * time.Second},
		maxRetries: 3,
		sleep:      time.Sleep,
	}
}

// APIError is a non-2xx response. Message is the server's `error` (and
// `message`, when present) so a plan failure says what the API refused.
type APIError struct {
	Method  string
	Path    string
	Status  int
	Message string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("%s %s: HTTP %d: %s", e.Method, e.Path, e.Status, e.Message)
}

// IsNotFound reports whether err is a 404 from the API.
func IsNotFound(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound
}

// Get, Post, Put, Patch and Delete send body (when non-nil) as JSON and decode
// a 2xx response into out (when non-nil).
func (c *Client) Get(ctx context.Context, path string, out any) error {
	return c.do(ctx, http.MethodGet, path, nil, out)
}

func (c *Client) Post(ctx context.Context, path string, body, out any) error {
	return c.do(ctx, http.MethodPost, path, body, out)
}

func (c *Client) Put(ctx context.Context, path string, body, out any) error {
	return c.do(ctx, http.MethodPut, path, body, out)
}

func (c *Client) Patch(ctx context.Context, path string, body, out any) error {
	return c.do(ctx, http.MethodPatch, path, body, out)
}

func (c *Client) Delete(ctx context.Context, path string, out any) error {
	return c.do(ctx, http.MethodDelete, path, nil, out)
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return fmt.Errorf("encode %s %s body: %w", method, path, err)
		}
	}

	for attempt := 0; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bytes.NewReader(payload))
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+c.apiKey)
		req.Header.Set("Accept", "application/json")
		req.Header.Set("User-Agent", c.userAgent)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}

		resp, err := c.httpClient.Do(req)
		if err != nil {
			return fmt.Errorf("%s %s: %w", method, path, err)
		}
		raw, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if readErr != nil {
			return fmt.Errorf("%s %s: read response: %w", method, path, readErr)
		}

		// A 429 was refused before the handler ran, and a gateway error never
		// reached the control plane, so retrying either cannot apply a write twice.
		if retryable(resp.StatusCode) && attempt < c.maxRetries {
			c.sleep(retryDelay(resp.Header.Get("Retry-After"), attempt))
			continue
		}

		if resp.StatusCode < 200 || resp.StatusCode > 299 {
			return &APIError{Method: method, Path: path, Status: resp.StatusCode, Message: errorMessage(raw)}
		}
		if out == nil || len(raw) == 0 {
			return nil
		}
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("%s %s: decode response: %w", method, path, err)
		}
		return nil
	}
}

func retryable(status int) bool {
	return status == http.StatusTooManyRequests ||
		status == http.StatusBadGateway ||
		status == http.StatusServiceUnavailable ||
		status == http.StatusGatewayTimeout
}

func retryDelay(retryAfter string, attempt int) time.Duration {
	if secs, err := strconv.Atoi(retryAfter); err == nil && secs >= 0 && secs <= 60 {
		return time.Duration(secs) * time.Second
	}
	return time.Duration(1<<attempt) * time.Second
}

// errorMessage pulls the human part out of the control plane's error body:
// `{"error": "...", "message": "...", "details": {...}}`. Validation details
// are kept, because they name the field the API refused.
func errorMessage(raw []byte) string {
	var body struct {
		Error   string          `json:"error"`
		Message string          `json:"message"`
		Details json.RawMessage `json:"details"`
	}
	if err := json.Unmarshal(raw, &body); err != nil || (body.Error == "" && body.Message == "") {
		text := strings.TrimSpace(string(raw))
		if len(text) > 500 {
			text = text[:500]
		}
		return text
	}
	parts := []string{}
	for _, p := range []string{body.Error, body.Message} {
		if p != "" {
			parts = append(parts, p)
		}
	}
	msg := strings.Join(parts, ": ")
	if len(body.Details) > 0 && string(body.Details) != "null" && string(body.Details) != "{}" {
		msg += " " + string(body.Details)
	}
	return msg
}
