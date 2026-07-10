package whip

import (
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/x/ansi"
)

func TestRenderUsageStripShowsClaudeAndCodexSummaries(t *testing.T) {
	store := tempStore(t)
	model := NewDashboardModel(store, "test")

	sessionReset := time.Date(2026, time.March, 17, 13, 0, 0, 0, time.Local)
	weeklyReset := time.Date(2026, time.March, 20, 13, 0, 0, 0, time.Local)
	claudeToday := 92.95
	claudeWeek := 418.20
	codexToday := 52.96
	codexWeek := 203.44

	model.usageState = dashboardUsageState{
		Claude: dashboardUsageProviderSummary{
			Provider:  "Claude",
			Primary:   &dashboardUsageWindow{LeftPercent: 36, ResetAt: &sessionReset},
			Weekly:    &dashboardUsageWindow{LeftPercent: 60, ResetAt: &weeklyReset},
			TodayCost: &claudeToday,
			WeekCost:  &claudeWeek,
		},
		Codex: dashboardUsageProviderSummary{
			Provider:  "Codex",
			Primary:   &dashboardUsageWindow{LeftPercent: 100},
			TodayCost: &codexToday,
			WeekCost:  &codexWeek,
		},
	}

	got := model.renderUsageStrip(200)

	for _, want := range []string{
		"Claude",
		"36%",
		"(1:00 PM)",
		"W 60%",
		"(3/20 1:00 PM)",
		"today $92.95 / week $418.20",
		"Codex",
		"100%",
		"(-)",
		"today $52.96 / week $203.44",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("usage strip missing %q in:\n%s", want, got)
		}
	}
	if plain := ansi.Strip(got); regexp.MustCompile(`Codex\s+M\s+`).MatchString(plain) {
		t.Fatalf("Codex primary usage should not include an M label:\n%s", plain)
	}
}

func TestRenderListViewPlacesUsageStripAboveFooter(t *testing.T) {
	store := tempStore(t)
	model := NewDashboardModel(store, "test")
	model.view = viewList
	model.width = 140
	model.height = 40

	today := 12.34
	week := 56.78
	model.usageState = dashboardUsageState{
		Codex: dashboardUsageProviderSummary{
			Provider:  "Codex",
			Primary:   &dashboardUsageWindow{LeftPercent: 100},
			TodayCost: &today,
			WeekCost:  &week,
		},
	}

	got := model.renderListView(140)
	usageIdx := strings.Index(got, "today $12.34 / week $56.78")
	footerIdx := strings.Index(got, "navigate")
	if usageIdx == -1 {
		t.Fatalf("list view missing usage strip:\n%s", got)
	}
	if footerIdx == -1 {
		t.Fatalf("list view missing footer:\n%s", got)
	}
	if usageIdx > footerIdx {
		t.Fatalf("usage strip should render above footer:\n%s", got)
	}
}

func TestFormatDashboardPrimaryResetIncludesDateAtTwentyFourHours(t *testing.T) {
	now := time.Date(2026, time.July, 10, 9, 0, 0, 0, time.Local)

	tests := []struct {
		name    string
		resetAt *time.Time
		want    string
	}{
		{name: "missing", resetAt: nil, want: "-"},
		{name: "just under 24 hours", resetAt: timePtr(now.Add(24*time.Hour - time.Nanosecond)), want: "8:59 AM"},
		{name: "exactly 24 hours", resetAt: timePtr(now.Add(24 * time.Hour)), want: "7/11 9:00 AM"},
		{name: "just over 24 hours", resetAt: timePtr(now.Add(24*time.Hour + time.Nanosecond)), want: "7/11 9:00 AM"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := formatDashboardPrimaryResetAt(tt.resetAt, now); got != tt.want {
				t.Fatalf("formatDashboardPrimaryResetAt() = %q, want %q", got, tt.want)
			}
		})
	}
}

func timePtr(value time.Time) *time.Time {
	return &value
}

func TestUsageCacheRoundTrip(t *testing.T) {
	tmpDir := t.TempDir()
	now := time.Now().UTC()
	claudeToday := 50.0
	claudeWeek := 200.0

	state := dashboardUsageState{
		UpdatedAt: now,
		Claude: dashboardUsageProviderSummary{
			Provider:  "Claude",
			Primary:   &dashboardUsageWindow{LeftPercent: 36, ResetAt: &now},
			TodayCost: &claudeToday,
			WeekCost:  &claudeWeek,
		},
	}

	if err := writeUsageCache(tmpDir, state); err != nil {
		t.Fatalf("write: %v", err)
	}

	loaded, err := readUsageCache(tmpDir)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if loaded.UpdatedAt.Unix() != now.Unix() {
		t.Fatalf("UpdatedAt mismatch: got %v, want %v", loaded.UpdatedAt, now)
	}
	if loaded.Claude.Provider != "Claude" {
		t.Fatalf("Claude provider mismatch: got %q", loaded.Claude.Provider)
	}
	if *loaded.Claude.TodayCost != 50.0 {
		t.Fatalf("TodayCost mismatch: got %v", *loaded.Claude.TodayCost)
	}
}

func TestUsageCacheReturnsErrWhenStale(t *testing.T) {
	tmpDir := t.TempDir()
	staleTime := time.Now().Add(-(dashboardUsageRefreshInterval + time.Minute))

	state := dashboardUsageState{UpdatedAt: staleTime}
	if err := writeUsageCache(tmpDir, state); err != nil {
		t.Fatalf("write: %v", err)
	}

	_, err := readUsageCache(tmpDir)
	if err == nil {
		t.Fatal("expected error for stale cache, got nil")
	}
}

func TestUsageCacheReturnsErrWhenMissing(t *testing.T) {
	tmpDir := t.TempDir()
	_, err := readUsageCache(tmpDir)
	if err == nil {
		t.Fatal("expected error for missing cache, got nil")
	}
}

func TestDashboardWritesCacheAfterFetch(t *testing.T) {
	store := tempStore(t)
	now := time.Now()
	todayCost := 77.0

	state := dashboardUsageState{
		UpdatedAt: now,
		Claude: dashboardUsageProviderSummary{
			Provider:  "Claude",
			TodayCost: &todayCost,
		},
	}

	model := NewDashboardModel(store, "test")
	msg := dashboardUsageLoadedMsg{state: state}
	updated, _ := model.Update(msg)
	m := updated.(DashboardModel)

	if m.usageLoading {
		t.Fatal("expected usageLoading=false after load")
	}

	cached, err := readUsageCache(store.BaseDir)
	if err != nil {
		t.Fatalf("expected cache to be written: %v", err)
	}
	if *cached.Claude.TodayCost != 77.0 {
		t.Fatalf("cached TodayCost mismatch: got %v", *cached.Claude.TodayCost)
	}
}

func TestDashboardInitUsesCachedUsage(t *testing.T) {
	store := tempStore(t)
	now := time.Now()
	todayCost := 10.0

	state := dashboardUsageState{
		UpdatedAt: now,
		Claude: dashboardUsageProviderSummary{
			Provider:  "Claude",
			TodayCost: &todayCost,
		},
	}
	if err := writeUsageCache(store.BaseDir, state); err != nil {
		t.Fatalf("write cache: %v", err)
	}

	model := NewDashboardModel(store, "test")
	if model.usageLoading {
		t.Fatal("expected usageLoading=false when cache is fresh")
	}
	if model.usageState.UpdatedAt.IsZero() {
		t.Fatal("expected usageState to be populated from cache")
	}
	if *model.usageState.Claude.TodayCost != 10.0 {
		t.Fatalf("cached TodayCost mismatch: got %v", *model.usageState.Claude.TodayCost)
	}
}

func TestRenderHeaderIncludesInlineSummaryForListView(t *testing.T) {
	store := tempStore(t)
	model := NewDashboardModel(store, "test")
	model.view = viewList
	model.tasks = []*Task{
		{Status: StatusInProgress},
		{Status: StatusCompleted},
		{Status: StatusCompleted},
	}

	got := model.renderHeader(160)

	for _, want := range []string{"Task Orchestrator", "3 active", "▶ 1 active", "✓ 2 done"} {
		if !strings.Contains(got, want) {
			t.Fatalf("header missing %q in:\n%s", want, got)
		}
	}
}
