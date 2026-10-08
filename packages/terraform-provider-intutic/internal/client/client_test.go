package client

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestSendsBearerKeyAndDecodes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer test-key" {
			t.Errorf("Authorization = %q", got)
		}
		if r.Method == http.MethodPost {
			if ct := r.Header.Get("Content-Type"); ct != "application/json" {
				t.Errorf("Content-Type = %q", ct)
			}
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["name"] != "x" {
				t.Errorf("body = %v", body)
			}
		}
		_, _ = w.Write([]byte(`{"id":"abc"}`))
	}))
	defer srv.Close()

	c := New(srv.URL+"/", "test-key", "test")
	var out struct{ ID string }
	if err := c.Post(context.Background(), "/api/v1/things", map[string]string{"name": "x"}, &out); err != nil {
		t.Fatal(err)
	}
	if out.ID != "abc" {
		t.Fatalf("ID = %q", out.ID)
	}
}

func TestErrorCarriesServerMessageAndDetails(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"Validation failed","details":{"title":["Required"]}}`))
	}))
	defer srv.Close()

	err := New(srv.URL, "k", "test").Get(context.Background(), "/x", nil)
	if err == nil || !strings.Contains(err.Error(), "Validation failed") || !strings.Contains(err.Error(), "title") {
		t.Fatalf("err = %v", err)
	}
	if IsNotFound(err) {
		t.Fatal("a 400 is not a 404")
	}
}

func TestIsNotFound(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"SOP not found"}`))
	}))
	defer srv.Close()

	if err := New(srv.URL, "k", "test").Get(context.Background(), "/x", nil); !IsNotFound(err) {
		t.Fatalf("err = %v", err)
	}
}

func TestRetriesRateLimitedThenSucceeds(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls < 3 {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "k", "test")
	var slept []time.Duration
	c.sleep = func(d time.Duration) { slept = append(slept, d) }
	if err := c.Put(context.Background(), "/x", map[string]int{"a": 1}, nil); err != nil {
		t.Fatal(err)
	}
	if calls != 3 || len(slept) != 2 || slept[0] != time.Second {
		t.Fatalf("calls=%d slept=%v", calls, slept)
	}
}

func TestDoesNotRetryAServerError(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"Internal server error"}`))
	}))
	defer srv.Close()

	c := New(srv.URL, "k", "test")
	c.sleep = func(time.Duration) {}
	if err := c.Post(context.Background(), "/x", nil, nil); err == nil {
		t.Fatal("expected an error")
	}
	if calls != 1 {
		t.Fatalf("a 500 may have applied the write; it must not be retried (calls=%d)", calls)
	}
}
