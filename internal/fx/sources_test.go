package fx

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

// fakeDoer is a test-only HTTPDoer returning a canned response or error. No
// network is involved.
type fakeDoer struct {
	status int
	body   string
	err    error
	gotURL string
	gotUA  string
}

func (d *fakeDoer) Do(req *http.Request) (*http.Response, error) {
	d.gotURL = req.URL.String()
	d.gotUA = req.Header.Get("User-Agent")
	if d.err != nil {
		return nil, d.err
	}
	status := d.status
	if status == 0 {
		status = http.StatusOK
	}
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(strings.NewReader(d.body)),
		Header:     make(http.Header),
	}, nil
}

func TestERAPISource_Fetch(t *testing.T) {
	tests := []struct {
		name     string
		doer     *fakeDoer
		wantErr  bool
		wantUSD  float64
		wantDate string
	}{
		{
			name: "success normalizes date and upper-cases keys",
			doer: &fakeDoer{body: `{
				"result":"success","base_code":"EUR",
				"time_last_update_utc":"Fri, 30 May 2026 00:00:01 +0000",
				"rates":{"usd":1.0850,"gbp":0.8550}
			}`},
			wantUSD:  1.0850,
			wantDate: "2026-05-30",
		},
		{
			name:    "non-success result is rejected",
			doer:    &fakeDoer{body: `{"result":"error","base_code":"EUR","rates":{"USD":1.08}}`},
			wantErr: true,
		},
		{
			name:    "wrong base is rejected",
			doer:    &fakeDoer{body: `{"result":"success","base_code":"USD","rates":{"EUR":0.92}}`},
			wantErr: true,
		},
		{
			name:    "empty rate table is rejected",
			doer:    &fakeDoer{body: `{"result":"success","base_code":"EUR","rates":{}}`},
			wantErr: true,
		},
		{
			name:    "non-2xx status is rejected",
			doer:    &fakeDoer{status: http.StatusBadGateway, body: `{}`},
			wantErr: true,
		},
		{
			name:    "transport error is surfaced",
			doer:    &fakeDoer{err: errors.New("dial tcp: timeout")},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			src := NewERAPISource(tt.doer)
			snap, err := src.Fetch(context.Background())
			if tt.wantErr {
				if err == nil {
					t.Fatalf("expected error, got snap %+v", snap)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if snap.Source != "er-api" {
				t.Fatalf("snap.Source = %q, want er-api", snap.Source)
			}
			if snap.Date != tt.wantDate {
				t.Fatalf("snap.Date = %q, want %q", snap.Date, tt.wantDate)
			}
			if got := snap.Rates["USD"]; got != tt.wantUSD {
				t.Fatalf("snap.Rates[USD] = %v, want %v", got, tt.wantUSD)
			}
			if tt.doer.gotUA == "" {
				t.Fatalf("User-Agent header was not set")
			}
		})
	}
}

func TestFrankfurterSource_Fetch(t *testing.T) {
	t.Run("success injects EUR identity and upper-cases keys", func(t *testing.T) {
		doer := &fakeDoer{body: `{"base":"EUR","date":"2026-05-30","rates":{"usd":1.0850,"gbp":0.8550}}`}
		src := NewFrankfurterSource(doer)

		snap, err := src.Fetch(context.Background())
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if snap.Source != "frankfurter" {
			t.Fatalf("snap.Source = %q, want frankfurter", snap.Source)
		}
		if snap.Date != "2026-05-30" {
			t.Fatalf("snap.Date = %q", snap.Date)
		}
		if got := snap.Rates["EUR"]; got != 1.0 {
			t.Fatalf("EUR identity not injected: %v", got)
		}
		if got := snap.Rates["USD"]; got != 1.0850 {
			t.Fatalf("snap.Rates[USD] = %v, want 1.0850", got)
		}
	})

	t.Run("wrong base is rejected", func(t *testing.T) {
		doer := &fakeDoer{body: `{"base":"USD","date":"2026-05-30","rates":{"EUR":0.92}}`}
		if _, err := NewFrankfurterSource(doer).Fetch(context.Background()); err == nil {
			t.Fatalf("expected base rejection")
		}
	})

	t.Run("empty rates rejected", func(t *testing.T) {
		doer := &fakeDoer{body: `{"base":"EUR","date":"2026-05-30","rates":{}}`}
		if _, err := NewFrankfurterSource(doer).Fetch(context.Background()); err == nil {
			t.Fatalf("expected empty-rates rejection")
		}
	})
}

// TestSources_FeedReconcile is the integration-shaped test: two fake-doer-backed
// sources that agree should reconcile cleanly through the real Reconcile.
func TestSources_FeedReconcile(t *testing.T) {
	er := NewERAPISource(&fakeDoer{body: `{
		"result":"success","base_code":"EUR","time_last_update_utc":"Fri, 30 May 2026 00:00:01 +0000",
		"rates":{"EUR":1,"USD":1.0850,"GBP":0.8550}
	}`})
	fr := NewFrankfurterSource(&fakeDoer{body: `{"base":"EUR","date":"2026-05-30","rates":{"USD":1.0853,"GBP":0.8548}}`})

	var snaps []SourceSnapshot
	for _, s := range []Source{er, fr} {
		snap, err := s.Fetch(context.Background())
		if err != nil {
			t.Fatalf("fetch: %v", err)
		}
		snaps = append(snaps, snap)
	}

	rates, failed, err := Reconcile(snaps, 2)
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if len(failed) != 0 {
		t.Fatalf("unexpected quorum failures: %v", failed)
	}
	if _, ok := rates["USD"]; !ok {
		t.Fatalf("USD missing from reconciled rates")
	}
	if _, ok := rates["GBP"]; !ok {
		t.Fatalf("GBP missing from reconciled rates")
	}
}
