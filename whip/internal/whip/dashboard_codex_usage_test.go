package whip

import (
	"context"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type dashboardCodexUsageRoundTripper func(*http.Request) (*http.Response, error)

func (f dashboardCodexUsageRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func fetchDashboardCodexUsageFromPayload(t *testing.T, payload string) (dashboardUsageProviderSummary, error) {
	t.Helper()

	codexHome := t.TempDir()
	auth := `{"tokens":{"access_token":"test-token","account_id":"test-account"}}`
	if err := os.WriteFile(filepath.Join(codexHome, "auth.json"), []byte(auth), 0o600); err != nil {
		t.Fatalf("write auth.json: %v", err)
	}
	t.Setenv("CODEX_HOME", codexHome)

	originalClient := http.DefaultClient
	http.DefaultClient = &http.Client{Transport: dashboardCodexUsageRoundTripper(func(req *http.Request) (*http.Response, error) {
		if got, want := req.URL.String(), "https://chatgpt.com/backend-api/wham/usage"; got != want {
			t.Errorf("request URL = %q, want %q", got, want)
		}
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(payload)),
			Request:    req,
		}, nil
	})}
	t.Cleanup(func() { http.DefaultClient = originalClient })

	return fetchCodexUsage(context.Background())
}

func TestFetchDashboardCodexUsageUsesPrimaryRateLimit(t *testing.T) {
	summary, err := fetchDashboardCodexUsageFromPayload(t, `{
		"plan_type":"plus",
		"rate_limit":{"primary_window":{"used_percent":37,"reset_at":1785542400,"limit_window_seconds":18000}},
		"credits":null
	}`)
	if err != nil {
		t.Fatalf("fetchCodexUsage: %v", err)
	}
	if summary.Primary == nil {
		t.Fatal("expected primary usage window")
	}
	if got, want := summary.Primary.LeftPercent, 63; got != want {
		t.Fatalf("LeftPercent = %d, want %d", got, want)
	}
	if summary.Primary.ResetAt == nil || summary.Primary.ResetAt.Unix() != 1785542400 {
		t.Fatalf("ResetAt = %v, want Unix 1785542400", summary.Primary.ResetAt)
	}
}

func TestFetchDashboardCodexUsageUsesUnlimitedCredits(t *testing.T) {
	summary, err := fetchDashboardCodexUsageFromPayload(t, `{
		"plan_type":"business",
		"rate_limit":null,
		"credits":{"has_credits":true,"unlimited":true,"balance":null}
	}`)
	if err != nil {
		t.Fatalf("fetchCodexUsage: %v", err)
	}
	if summary.Primary == nil {
		t.Fatal("expected primary usage window")
	}
	if got, want := summary.Primary.LeftPercent, 100; got != want {
		t.Fatalf("LeftPercent = %d, want %d", got, want)
	}
	if summary.Primary.ResetAt != nil {
		t.Fatalf("ResetAt = %v, want nil", summary.Primary.ResetAt)
	}
}

func TestFetchDashboardCodexUsageUsesIndividualCreditLimit(t *testing.T) {
	summary, err := fetchDashboardCodexUsageFromPayload(t, `{
		"plan_type":"business",
		"rate_limit":null,
		"credits":{"has_credits":true,"unlimited":false,"balance":"99999"},
		"spend_control":{"reached":false,"individual_limit":{
			"limit":"25000",
			"used":"1234",
			"remaining":"5678",
			"used_percent":91,
			"remaining_percent":83,
			"reset_at":1785542400
		}}
	}`)
	if err != nil {
		t.Fatalf("fetchCodexUsage: %v", err)
	}
	if summary.Primary == nil {
		t.Fatal("expected primary usage window")
	}
	if got, want := summary.Primary.LeftPercent, 83; got != want {
		t.Fatalf("LeftPercent = %d, want %d", got, want)
	}
	if summary.Primary.ResetAt == nil || summary.Primary.ResetAt.Unix() != 1785542400 {
		t.Fatalf("ResetAt = %v, want Unix 1785542400", summary.Primary.ResetAt)
	}
}

func TestFetchDashboardCodexUsageKeepsPrimaryRateLimitPrecedence(t *testing.T) {
	summary, err := fetchDashboardCodexUsageFromPayload(t, `{
		"plan_type":"business",
		"rate_limit":{"primary_window":{"used_percent":37,"reset_at":1785542400}},
		"credits":{"has_credits":true,"unlimited":false,"balance":"100"},
		"spend_control":{"reached":false,"individual_limit":{
			"remaining_percent":12,
			"reset_at":1788220800
		}}
	}`)
	if err != nil {
		t.Fatalf("fetchCodexUsage: %v", err)
	}
	if summary.Primary == nil || summary.Primary.LeftPercent != 63 {
		t.Fatalf("Primary = %+v, want rate-limit window with 63%% left", summary.Primary)
	}
	if summary.Primary.ResetAt == nil || summary.Primary.ResetAt.Unix() != 1785542400 {
		t.Fatalf("ResetAt = %v, want rate-limit reset Unix 1785542400", summary.Primary.ResetAt)
	}
}

func TestFetchDashboardCodexUsageIndividualLimitCapsUnlimitedCredits(t *testing.T) {
	summary, err := fetchDashboardCodexUsageFromPayload(t, `{
		"plan_type":"business",
		"rate_limit":null,
		"credits":{"has_credits":true,"unlimited":true,"balance":null},
		"spend_control":{"reached":false,"individual_limit":{
			"remaining_percent":42,
			"reset_at":1785542400
		}}
	}`)
	if err != nil {
		t.Fatalf("fetchCodexUsage: %v", err)
	}
	if summary.Primary == nil || summary.Primary.LeftPercent != 42 {
		t.Fatalf("Primary = %+v, want individual limit with 42%% left", summary.Primary)
	}
	if summary.Primary.ResetAt == nil || summary.Primary.ResetAt.Unix() != 1785542400 {
		t.Fatalf("ResetAt = %v, want individual-limit reset Unix 1785542400", summary.Primary.ResetAt)
	}
}

func TestFetchDashboardCodexUsageUsesDepletedIndividualLimit(t *testing.T) {
	summary, err := fetchDashboardCodexUsageFromPayload(t, `{
		"plan_type":"business",
		"rate_limit":null,
		"credits":{"has_credits":true,"unlimited":false,"balance":"9999"},
		"spend_control":{"reached":true,"individual_limit":{
			"remaining_percent":0,
			"reset_at":1785542400
		}}
	}`)
	if err != nil {
		t.Fatalf("fetchCodexUsage: %v", err)
	}
	if summary.Primary == nil || summary.Primary.LeftPercent != 0 {
		t.Fatalf("Primary = %+v, want depleted individual limit with 0%% left", summary.Primary)
	}
	if summary.Primary.ResetAt == nil || summary.Primary.ResetAt.Unix() != 1785542400 {
		t.Fatalf("ResetAt = %v, want individual-limit reset Unix 1785542400", summary.Primary.ResetAt)
	}
}

func TestFetchDashboardCodexUsageUsesFullIndividualLimitBoundary(t *testing.T) {
	summary, err := fetchDashboardCodexUsageFromPayload(t, `{
		"plan_type":"business",
		"rate_limit":null,
		"credits":{"has_credits":true,"unlimited":false,"balance":"25000"},
		"spend_control":{"reached":false,"individual_limit":{
			"remaining_percent":100,
			"reset_at":1785542400
		}}
	}`)
	if err != nil {
		t.Fatalf("fetchCodexUsage: %v", err)
	}
	if summary.Primary == nil || summary.Primary.LeftPercent != 100 {
		t.Fatalf("Primary = %+v, want full individual limit with 100%% left", summary.Primary)
	}
	if summary.Primary.ResetAt == nil || summary.Primary.ResetAt.Unix() != 1785542400 {
		t.Fatalf("ResetAt = %v, want individual-limit reset Unix 1785542400", summary.Primary.ResetAt)
	}
}

func TestFetchDashboardCodexUsageRejectsPartialIndividualLimit(t *testing.T) {
	_, err := fetchDashboardCodexUsageFromPayload(t, `{
		"plan_type":"business",
		"rate_limit":null,
		"credits":{"has_credits":true,"unlimited":false,"balance":"100"},
		"spend_control":{"reached":false,"individual_limit":{"reset_at":1785542400}}
	}`)
	if err == nil {
		t.Fatal("expected missing-data error for individual limit without remaining_percent")
	}
}

func TestFetchDashboardCodexUsageRejectsPartialIndividualLimitBeforeUnlimitedFallback(t *testing.T) {
	_, err := fetchDashboardCodexUsageFromPayload(t, `{
		"plan_type":"business",
		"rate_limit":null,
		"credits":{"has_credits":true,"unlimited":true,"balance":null},
		"spend_control":{"reached":false,"individual_limit":{"reset_at":1785542400}}
	}`)
	if err == nil {
		t.Fatal("expected missing-data error instead of unlimited fallback for a partial individual limit")
	}
}

func TestFetchDashboardCodexUsageRejectsMissingIndividualLimit(t *testing.T) {
	_, err := fetchDashboardCodexUsageFromPayload(t, `{
		"plan_type":"business",
		"rate_limit":null,
		"credits":{"has_credits":true,"unlimited":false,"balance":"100"},
		"spend_control":{"reached":false,"individual_limit":null}
	}`)
	if err == nil {
		t.Fatal("expected missing-data error when finite credits have no individual limit")
	}
}
