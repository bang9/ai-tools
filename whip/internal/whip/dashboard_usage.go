package whip

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

const (
	dashboardUsageRefreshInterval = 15 * time.Minute
	dashboardUsageTimeout         = 15 * time.Second
	dashboardUsageWeekDays        = 7
)

type dashboardUsageState struct {
	UpdatedAt time.Time                     `json:"updated_at"`
	Claude    dashboardUsageProviderSummary `json:"claude"`
	Codex     dashboardUsageProviderSummary `json:"codex"`
}

type dashboardUsageProviderSummary struct {
	Provider  string                `json:"provider"`
	Primary   *dashboardUsageWindow `json:"primary,omitempty"`
	Weekly    *dashboardUsageWindow `json:"weekly,omitempty"`
	TodayCost *float64              `json:"today_cost,omitempty"`
	WeekCost  *float64              `json:"week_cost,omitempty"`
	LastError string                `json:"last_error,omitempty"`
}

type dashboardUsageWindow struct {
	LeftPercent int        `json:"left_percent"`
	ResetAt     *time.Time `json:"reset_at,omitempty"`
}

type dashboardCostSummary struct {
	TodayUSD float64
	WeekUSD  float64
}

type dashboardClaudeCredentials struct {
	AccessToken string
}

type dashboardClaudeUsageResponse struct {
	FiveHour *dashboardClaudeUsageWindow `json:"five_hour"`
	SevenDay *dashboardClaudeUsageWindow `json:"seven_day"`
}

type dashboardClaudeUsageWindow struct {
	Utilization float64 `json:"utilization"`
	ResetsAt    string  `json:"resets_at"`
}

type dashboardCodexCredentials struct {
	AccessToken string
	AccountID   string
}

type dashboardCodexUsageResponse struct {
	PlanType  string                    `json:"plan_type"`
	RateLimit *dashboardCodexRateLimit  `json:"rate_limit"`
	Credits   *dashboardCodexCreditData `json:"credits"`
}

type dashboardCodexRateLimit struct {
	PrimaryWindow   *dashboardCodexRateLimitWindow `json:"primary_window"`
	SecondaryWindow *dashboardCodexRateLimitWindow `json:"secondary_window"`
}

type dashboardCodexRateLimitWindow struct {
	UsedPercent        int `json:"used_percent"`
	ResetAtUnix        int `json:"reset_at"`
	LimitWindowSeconds int `json:"limit_window_seconds"`
}

type dashboardCodexCreditData struct {
	Unlimited bool `json:"unlimited"`
}

type dashboardCodexTokenTotals struct {
	Input  int
	Cached int
	Output int
}

type dashboardCodexPricing struct {
	InputPerToken     float64
	OutputPerToken    float64
	CacheReadPerToken *float64
}

type dashboardClaudePricing struct {
	InputPerToken                float64
	OutputPerToken               float64
	CacheCreationPerToken        float64
	CacheReadPerToken            float64
	ThresholdTokens              *int
	InputPerTokenAboveThreshold  *float64
	OutputPerTokenAboveThreshold *float64
	CacheCreationAboveThreshold  *float64
	CacheReadAboveThreshold      *float64
}

var (
	dashboardCodexDatedSuffixRE  = regexp.MustCompile(`-\d{4}-\d{2}-\d{2}$`)
	dashboardClaudeVersionRE     = regexp.MustCompile(`-v\d+:\d+$`)
	dashboardClaudeDatedSuffixRE = regexp.MustCompile(`-\d{8}$`)
)

var dashboardCodexPricingTable = map[string]dashboardCodexPricing{
	"gpt-5":               {InputPerToken: 1.25e-6, OutputPerToken: 1e-5, CacheReadPerToken: float64Ptr(1.25e-7)},
	"gpt-5-codex":         {InputPerToken: 1.25e-6, OutputPerToken: 1e-5, CacheReadPerToken: float64Ptr(1.25e-7)},
	"gpt-5-mini":          {InputPerToken: 2.5e-7, OutputPerToken: 2e-6, CacheReadPerToken: float64Ptr(2.5e-8)},
	"gpt-5-nano":          {InputPerToken: 5e-8, OutputPerToken: 4e-7, CacheReadPerToken: float64Ptr(5e-9)},
	"gpt-5-pro":           {InputPerToken: 1.5e-5, OutputPerToken: 1.2e-4},
	"gpt-5.1":             {InputPerToken: 1.25e-6, OutputPerToken: 1e-5, CacheReadPerToken: float64Ptr(1.25e-7)},
	"gpt-5.1-codex":       {InputPerToken: 1.25e-6, OutputPerToken: 1e-5, CacheReadPerToken: float64Ptr(1.25e-7)},
	"gpt-5.1-codex-max":   {InputPerToken: 1.25e-6, OutputPerToken: 1e-5, CacheReadPerToken: float64Ptr(1.25e-7)},
	"gpt-5.1-codex-mini":  {InputPerToken: 2.5e-7, OutputPerToken: 2e-6, CacheReadPerToken: float64Ptr(2.5e-8)},
	"gpt-5.2":             {InputPerToken: 1.75e-6, OutputPerToken: 1.4e-5, CacheReadPerToken: float64Ptr(1.75e-7)},
	"gpt-5.2-codex":       {InputPerToken: 1.75e-6, OutputPerToken: 1.4e-5, CacheReadPerToken: float64Ptr(1.75e-7)},
	"gpt-5.2-pro":         {InputPerToken: 2.1e-5, OutputPerToken: 1.68e-4},
	"gpt-5.3-codex":       {InputPerToken: 1.75e-6, OutputPerToken: 1.4e-5, CacheReadPerToken: float64Ptr(1.75e-7)},
	"gpt-5.3-codex-spark": {InputPerToken: 0, OutputPerToken: 0, CacheReadPerToken: float64Ptr(0)},
	"gpt-5.4":             {InputPerToken: 2.5e-6, OutputPerToken: 1.5e-5, CacheReadPerToken: float64Ptr(2.5e-7)},
	"gpt-5.4-pro":         {InputPerToken: 3e-5, OutputPerToken: 1.8e-4},
	"gpt-5.5":             {InputPerToken: 5e-6, OutputPerToken: 3e-5, CacheReadPerToken: float64Ptr(5e-7)},
	"gpt-5.5-pro":         {InputPerToken: 3e-5, OutputPerToken: 1.8e-4},
}

var dashboardClaudePricingTable = map[string]dashboardClaudePricing{
	"claude-haiku-4-5":           {InputPerToken: 1e-6, OutputPerToken: 5e-6, CacheCreationPerToken: 1.25e-6, CacheReadPerToken: 1e-7},
	"claude-haiku-4-5-20251001":  {InputPerToken: 1e-6, OutputPerToken: 5e-6, CacheCreationPerToken: 1.25e-6, CacheReadPerToken: 1e-7},
	"claude-opus-4-5":            {InputPerToken: 5e-6, OutputPerToken: 2.5e-5, CacheCreationPerToken: 6.25e-6, CacheReadPerToken: 5e-7},
	"claude-opus-4-5-20251101":   {InputPerToken: 5e-6, OutputPerToken: 2.5e-5, CacheCreationPerToken: 6.25e-6, CacheReadPerToken: 5e-7},
	"claude-opus-4-6":            {InputPerToken: 5e-6, OutputPerToken: 2.5e-5, CacheCreationPerToken: 6.25e-6, CacheReadPerToken: 5e-7},
	"claude-opus-4-6-20260205":   {InputPerToken: 5e-6, OutputPerToken: 2.5e-5, CacheCreationPerToken: 6.25e-6, CacheReadPerToken: 5e-7},
	"claude-opus-4-8":            {InputPerToken: 5e-6, OutputPerToken: 2.5e-5, CacheCreationPerToken: 6.25e-6, CacheReadPerToken: 5e-7},
	"claude-opus-4-8-20260528":   {InputPerToken: 5e-6, OutputPerToken: 2.5e-5, CacheCreationPerToken: 6.25e-6, CacheReadPerToken: 5e-7},
	"claude-opus-4-20250514":     {InputPerToken: 1.5e-5, OutputPerToken: 7.5e-5, CacheCreationPerToken: 1.875e-5, CacheReadPerToken: 1.5e-6},
	"claude-opus-4-1":            {InputPerToken: 1.5e-5, OutputPerToken: 7.5e-5, CacheCreationPerToken: 1.875e-5, CacheReadPerToken: 1.5e-6},
	"claude-sonnet-4-5":          makeTieredClaudePricing(3e-6, 1.5e-5, 3.75e-6, 3e-7, 200_000, 6e-6, 2.25e-5, 7.5e-6, 6e-7),
	"claude-sonnet-4-5-20250929": makeTieredClaudePricing(3e-6, 1.5e-5, 3.75e-6, 3e-7, 200_000, 6e-6, 2.25e-5, 7.5e-6, 6e-7),
	"claude-sonnet-4-20250514":   makeTieredClaudePricing(3e-6, 1.5e-5, 3.75e-6, 3e-7, 200_000, 6e-6, 2.25e-5, 7.5e-6, 6e-7),
}

func makeTieredClaudePricing(
	input float64,
	output float64,
	cacheCreate float64,
	cacheRead float64,
	threshold int,
	inputAbove float64,
	outputAbove float64,
	cacheCreateAbove float64,
	cacheReadAbove float64,
) dashboardClaudePricing {
	return dashboardClaudePricing{
		InputPerToken:                input,
		OutputPerToken:               output,
		CacheCreationPerToken:        cacheCreate,
		CacheReadPerToken:            cacheRead,
		ThresholdTokens:              intPtr(threshold),
		InputPerTokenAboveThreshold:  float64Ptr(inputAbove),
		OutputPerTokenAboveThreshold: float64Ptr(outputAbove),
		CacheCreationAboveThreshold:  float64Ptr(cacheCreateAbove),
		CacheReadAboveThreshold:      float64Ptr(cacheReadAbove),
	}
}

func (s dashboardUsageState) visibleProviders() []dashboardUsageProviderSummary {
	providers := make([]dashboardUsageProviderSummary, 0, 2)
	if s.Claude.hasDisplayData() {
		providers = append(providers, s.Claude)
	}
	if s.Codex.hasDisplayData() {
		providers = append(providers, s.Codex)
	}
	return providers
}

func (s dashboardUsageState) needsRefresh(now time.Time) bool {
	if s.UpdatedAt.IsZero() {
		return true
	}
	return now.Sub(s.UpdatedAt) >= dashboardUsageRefreshInterval
}

func (s dashboardUsageProviderSummary) hasDisplayData() bool {
	return s.Primary != nil || s.Weekly != nil || s.TodayCost != nil || s.WeekCost != nil
}

func loadDashboardUsageCmd() tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), dashboardUsageTimeout)
		defer cancel()
		return dashboardUsageLoadedMsg{state: collectDashboardUsage(ctx, time.Now())}
	}
}

func (m *DashboardModel) maybeLoadDashboardUsage(now time.Time) tea.Cmd {
	if m.usageLoading {
		return nil
	}
	if !m.usageState.needsRefresh(now) {
		return nil
	}
	m.usageLoading = true
	return loadDashboardUsageCmd()
}

func (m *DashboardModel) forceLoadDashboardUsage() tea.Cmd {
	if m.usageLoading {
		return nil
	}
	m.usageLoading = true
	return loadDashboardUsageCmd()
}

func collectDashboardUsage(ctx context.Context, now time.Time) dashboardUsageState {
	var (
		wg     sync.WaitGroup
		claude dashboardUsageProviderSummary
		codex  dashboardUsageProviderSummary
	)

	wg.Add(2)
	go func() {
		defer wg.Done()
		claude = collectClaudeDashboardUsage(ctx, now)
	}()
	go func() {
		defer wg.Done()
		codex = collectCodexDashboardUsage(ctx, now)
	}()
	wg.Wait()

	return dashboardUsageState{
		UpdatedAt: now,
		Claude:    claude,
		Codex:     codex,
	}
}

func collectClaudeDashboardUsage(ctx context.Context, now time.Time) dashboardUsageProviderSummary {
	summary := dashboardUsageProviderSummary{Provider: "Claude"}

	if usage, err := fetchClaudeUsage(ctx); err == nil {
		summary.Primary = usage.Primary
		summary.Weekly = usage.Weekly
	} else {
		summary.LastError = err.Error()
	}

	if cost, err := collectClaudeCostSummary(now); err == nil {
		summary.TodayCost = float64Ptr(cost.TodayUSD)
		summary.WeekCost = float64Ptr(cost.WeekUSD)
	} else if summary.LastError == "" {
		summary.LastError = err.Error()
	}

	return summary
}

func collectCodexDashboardUsage(ctx context.Context, now time.Time) dashboardUsageProviderSummary {
	summary := dashboardUsageProviderSummary{Provider: "Codex"}

	if usage, err := fetchCodexUsage(ctx); err == nil {
		summary.Primary = usage.Primary
	} else {
		summary.LastError = err.Error()
	}

	if cost, err := collectCodexCostSummary(now); err == nil {
		summary.TodayCost = float64Ptr(cost.TodayUSD)
		summary.WeekCost = float64Ptr(cost.WeekUSD)
	} else if summary.LastError == "" {
		summary.LastError = err.Error()
	}

	return summary
}

func fetchClaudeUsage(ctx context.Context) (dashboardUsageProviderSummary, error) {
	creds, err := loadClaudeCredentials(ctx)
	if err != nil {
		return dashboardUsageProviderSummary{}, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://api.anthropic.com/api/oauth/usage", nil)
	if err != nil {
		return dashboardUsageProviderSummary{}, err
	}
	req.Header.Set("Authorization", "Bearer "+creds.AccessToken)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("anthropic-beta", "oauth-2025-04-20")
	req.Header.Set("User-Agent", "claude-code/2.1.0")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return dashboardUsageProviderSummary{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return dashboardUsageProviderSummary{}, fmt.Errorf("claude usage API returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var payload dashboardClaudeUsageResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return dashboardUsageProviderSummary{}, err
	}

	result := dashboardUsageProviderSummary{Provider: "Claude"}
	if payload.FiveHour != nil {
		result.Primary = dashboardWindowFromUtilization(payload.FiveHour.Utilization, payload.FiveHour.ResetsAt)
	}
	if payload.SevenDay != nil {
		result.Weekly = dashboardWindowFromUtilization(payload.SevenDay.Utilization, payload.SevenDay.ResetsAt)
	}
	if result.Primary == nil {
		return dashboardUsageProviderSummary{}, fmt.Errorf("claude usage payload missing five_hour window")
	}

	return result, nil
}

func fetchCodexUsage(ctx context.Context) (dashboardUsageProviderSummary, error) {
	creds, err := loadCodexCredentials()
	if err != nil {
		return dashboardUsageProviderSummary{}, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://chatgpt.com/backend-api/wham/usage", nil)
	if err != nil {
		return dashboardUsageProviderSummary{}, err
	}
	req.Header.Set("Authorization", "Bearer "+creds.AccessToken)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "whip")
	if creds.AccountID != "" {
		req.Header.Set("ChatGPT-Account-Id", creds.AccountID)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return dashboardUsageProviderSummary{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return dashboardUsageProviderSummary{}, fmt.Errorf("codex usage API returned %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var payload dashboardCodexUsageResponse
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return dashboardUsageProviderSummary{}, err
	}

	result := dashboardUsageProviderSummary{Provider: "Codex"}
	if payload.RateLimit != nil && payload.RateLimit.PrimaryWindow != nil {
		window := payload.RateLimit.PrimaryWindow
		var resetAt *time.Time
		if window.ResetAtUnix > 0 {
			t := time.Unix(int64(window.ResetAtUnix), 0).In(time.Local)
			resetAt = &t
		}
		result.Primary = &dashboardUsageWindow{
			LeftPercent: clampPercent(100 - window.UsedPercent),
			ResetAt:     resetAt,
		}
	} else if payload.Credits != nil && payload.Credits.Unlimited || payload.PlanType != "" {
		// Business and unlimited plans often omit an explicit rate_limit window in the OAuth response.
		// The Codex CLI still surfaces these as "100% left", so mirror that behavior here.
		result.Primary = &dashboardUsageWindow{LeftPercent: 100}
	}

	if result.Primary == nil {
		return dashboardUsageProviderSummary{}, fmt.Errorf("codex usage payload missing primary window")
	}

	return result, nil
}

func loadClaudeCredentials(ctx context.Context) (dashboardClaudeCredentials, error) {
	if runtime.GOOS != "darwin" {
		return dashboardClaudeCredentials{}, fmt.Errorf("claude usage requires macOS keychain access")
	}

	out, err := exec.CommandContext(ctx, "security", "find-generic-password", "-s", "Claude Code-credentials", "-g").CombinedOutput()
	if err != nil {
		return dashboardClaudeCredentials{}, fmt.Errorf("failed to read Claude credentials from keychain: %w", err)
	}

	raw := string(out)
	start := strings.Index(raw, `password: "`)
	if start < 0 {
		return dashboardClaudeCredentials{}, fmt.Errorf("could not find Claude keychain payload")
	}
	start += len(`password: "`)
	end := strings.Index(raw[start:], "\"\nkeychain:")
	if end < 0 {
		return dashboardClaudeCredentials{}, fmt.Errorf("could not parse Claude keychain payload")
	}
	payload := raw[start : start+end]

	var parsed struct {
		ClaudeAiOauth struct {
			AccessToken string `json:"accessToken"`
		} `json:"claudeAiOauth"`
	}
	if err := json.Unmarshal([]byte(payload), &parsed); err != nil {
		return dashboardClaudeCredentials{}, err
	}
	if strings.TrimSpace(parsed.ClaudeAiOauth.AccessToken) == "" {
		return dashboardClaudeCredentials{}, fmt.Errorf("Claude access token missing from keychain payload")
	}

	return dashboardClaudeCredentials{AccessToken: parsed.ClaudeAiOauth.AccessToken}, nil
}

func loadCodexCredentials() (dashboardCodexCredentials, error) {
	authPath := codexAuthFilePath()
	data, err := os.ReadFile(authPath)
	if err != nil {
		return dashboardCodexCredentials{}, fmt.Errorf("failed to read Codex auth.json: %w", err)
	}

	var parsed struct {
		Tokens struct {
			AccessToken string `json:"access_token"`
			AccountID   string `json:"account_id"`
		} `json:"tokens"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return dashboardCodexCredentials{}, err
	}
	if strings.TrimSpace(parsed.Tokens.AccessToken) == "" {
		return dashboardCodexCredentials{}, fmt.Errorf("Codex access token missing from auth.json")
	}

	return dashboardCodexCredentials{
		AccessToken: parsed.Tokens.AccessToken,
		AccountID:   parsed.Tokens.AccountID,
	}, nil
}

func codexAuthFilePath() string {
	if home := strings.TrimSpace(os.Getenv("CODEX_HOME")); home != "" {
		return filepath.Join(home, "auth.json")
	}
	userHome, err := os.UserHomeDir()
	if err != nil {
		return ".codex/auth.json"
	}
	return filepath.Join(userHome, ".codex", "auth.json")
}

func dashboardWindowFromUtilization(utilization float64, resetRaw string) *dashboardUsageWindow {
	left := clampPercent(100 - int(math.Round(utilization)))
	var resetAt *time.Time
	if parsed, ok := parseDashboardTime(resetRaw); ok {
		resetAt = &parsed
	}
	return &dashboardUsageWindow{
		LeftPercent: left,
		ResetAt:     resetAt,
	}
}

func collectClaudeCostSummary(now time.Time) (dashboardCostSummary, error) {
	files, err := listRecentJSONLFiles(claudeProjectsRoots(), dashboardRecentWindowStart(now))
	if err != nil {
		return dashboardCostSummary{}, err
	}

	dayCosts := make(map[string]float64)
	for _, path := range files {
		fileCosts, err := parseClaudeCostFile(path)
		if err != nil {
			continue
		}
		for dayKey, cost := range fileCosts {
			dayCosts[dayKey] += cost
		}
	}

	return buildDashboardCostSummary(dayCosts, now), nil
}

func collectCodexCostSummary(now time.Time) (dashboardCostSummary, error) {
	files, err := listRecentJSONLFiles(codexSessionRoots(), dashboardRecentWindowStart(now))
	if err != nil {
		return dashboardCostSummary{}, err
	}

	dayCosts := make(map[string]float64)
	seenSessionIDs := make(map[string]struct{})
	for _, path := range files {
		fileCosts, sessionID, err := parseCodexCostFile(path)
		if err != nil {
			continue
		}
		if sessionID != "" {
			if _, exists := seenSessionIDs[sessionID]; exists {
				continue
			}
			seenSessionIDs[sessionID] = struct{}{}
		}
		for dayKey, cost := range fileCosts {
			dayCosts[dayKey] += cost
		}
	}

	return buildDashboardCostSummary(dayCosts, now), nil
}

func buildDashboardCostSummary(dayCosts map[string]float64, now time.Time) dashboardCostSummary {
	todayKey := dashboardDayKey(now)
	sinceKey := dashboardDayKey(dashboardRecentWindowStart(now))

	var summary dashboardCostSummary
	for dayKey, cost := range dayCosts {
		if dayKey < sinceKey || dayKey > todayKey {
			continue
		}
		summary.WeekUSD += cost
		if dayKey == todayKey {
			summary.TodayUSD += cost
		}
	}
	return summary
}

func claudeProjectsRoots() []string {
	var roots []string
	if env := strings.TrimSpace(os.Getenv("CLAUDE_CONFIG_DIR")); env != "" {
		for _, part := range strings.Split(env, ",") {
			root := strings.TrimSpace(part)
			if root == "" {
				continue
			}
			if filepath.Base(root) != "projects" {
				root = filepath.Join(root, "projects")
			}
			roots = append(roots, root)
		}
	}

	if len(roots) == 0 {
		userHome, err := os.UserHomeDir()
		if err == nil {
			roots = append(roots,
				filepath.Join(userHome, ".config", "claude", "projects"),
				filepath.Join(userHome, ".claude", "projects"),
			)
		}
	}

	return uniqueStrings(roots)
}

func codexSessionRoots() []string {
	base := strings.TrimSpace(os.Getenv("CODEX_HOME"))
	if base == "" {
		if userHome, err := os.UserHomeDir(); err == nil {
			base = filepath.Join(userHome, ".codex")
		}
	}
	if base == "" {
		return nil
	}

	sessionsRoot := filepath.Join(base, "sessions")
	roots := []string{sessionsRoot}
	if filepath.Base(sessionsRoot) == "sessions" {
		roots = append(roots, filepath.Join(filepath.Dir(sessionsRoot), "archived_sessions"))
	}
	return uniqueStrings(roots)
}

func listRecentJSONLFiles(roots []string, cutoff time.Time) ([]string, error) {
	seen := make(map[string]struct{})
	var files []string

	for _, root := range roots {
		root = strings.TrimSpace(root)
		if root == "" {
			continue
		}
		info, err := os.Stat(root)
		if err != nil || !info.IsDir() {
			continue
		}

		if err := filepath.WalkDir(root, func(path string, d os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return nil
			}
			if d.IsDir() {
				if path != root && strings.HasPrefix(d.Name(), ".") {
					return filepath.SkipDir
				}
				return nil
			}
			if filepath.Ext(d.Name()) != ".jsonl" {
				return nil
			}
			info, err := d.Info()
			if err != nil || info.ModTime().Before(cutoff) {
				return nil
			}
			if _, exists := seen[path]; exists {
				return nil
			}
			seen[path] = struct{}{}
			files = append(files, path)
			return nil
		}); err != nil {
			return nil, err
		}
	}

	sort.Strings(files)
	return files, nil
}

func parseClaudeCostFile(path string) (map[string]float64, error) {
	dayCosts := make(map[string]float64)
	seenMessageKeys := make(map[string]struct{})

	err := forEachJSONLLine(path, func(line []byte) {
		if !bytes.Contains(line, []byte(`"type":"assistant"`)) || !bytes.Contains(line, []byte(`"usage"`)) {
			return
		}

		var obj map[string]any
		if err := json.Unmarshal(line, &obj); err != nil {
			return
		}
		if dashboardStringFromMap(obj, "type") != "assistant" || dashboardIsVertexAIUsageEntry(obj) {
			return
		}

		dayKey, ok := dashboardDayKeyFromRaw(dashboardStringFromMap(obj, "timestamp"))
		if !ok {
			return
		}

		message := dashboardMap(obj["message"])
		if message == nil {
			return
		}

		messageID := dashboardStringFromMap(message, "id")
		requestID := dashboardStringFromMap(obj, "requestId")
		if messageID != "" && requestID != "" {
			key := messageID + ":" + requestID
			if _, exists := seenMessageKeys[key]; exists {
				return
			}
			seenMessageKeys[key] = struct{}{}
		}

		model := dashboardStringFromMap(message, "model")
		usage := dashboardMap(message["usage"])
		if model == "" || usage == nil {
			return
		}

		input := dashboardInt(usage["input_tokens"])
		cacheCreate := dashboardInt(usage["cache_creation_input_tokens"])
		cacheRead := dashboardInt(usage["cache_read_input_tokens"])
		output := dashboardInt(usage["output_tokens"])
		cost, ok := dashboardClaudeCostUSD(model, input, cacheRead, cacheCreate, output)
		if !ok {
			return
		}

		dayCosts[dayKey] += cost
	})

	return dayCosts, err
}

func parseCodexCostFile(path string) (map[string]float64, string, error) {
	dayCosts := make(map[string]float64)

	var (
		currentModel string
		previous     *dashboardCodexTokenTotals
		sessionID    string
	)

	err := forEachJSONLLine(path, func(line []byte) {
		if !bytes.Contains(line, []byte(`"type":"`)) {
			return
		}
		if !bytes.Contains(line, []byte(`"type":"event_msg"`)) &&
			!bytes.Contains(line, []byte(`"type":"turn_context"`)) &&
			!bytes.Contains(line, []byte(`"type":"session_meta"`)) {
			return
		}
		if bytes.Contains(line, []byte(`"type":"event_msg"`)) && !bytes.Contains(line, []byte(`"token_count"`)) {
			return
		}

		var obj map[string]any
		if err := json.Unmarshal(line, &obj); err != nil {
			return
		}

		switch dashboardStringFromMap(obj, "type") {
		case "session_meta":
			if sessionID == "" {
				sessionID = dashboardStringFromMap(dashboardMap(obj["payload"]), "session_id", "sessionId", "id")
				if sessionID == "" {
					sessionID = dashboardStringFromMap(obj, "session_id", "sessionId", "id")
				}
			}

		case "turn_context":
			payload := dashboardMap(obj["payload"])
			if payload == nil {
				return
			}
			currentModel = dashboardStringFromMap(payload, "model")
			if currentModel == "" {
				currentModel = dashboardStringFromMap(dashboardMap(payload["info"]), "model")
			}

		case "event_msg":
			payload := dashboardMap(obj["payload"])
			if payload == nil || dashboardStringFromMap(payload, "type") != "token_count" {
				return
			}

			dayKey, ok := dashboardDayKeyFromRaw(dashboardStringFromMap(obj, "timestamp"))
			if !ok {
				return
			}

			info := dashboardMap(payload["info"])
			if info == nil {
				return
			}
			model := dashboardStringFromMap(info, "model", "model_name")
			if model == "" {
				model = dashboardStringFromMap(payload, "model")
			}
			if model == "" {
				model = currentModel
			}
			if model == "" {
				model = "gpt-5"
			}

			var delta dashboardCodexTokenTotals
			if total := dashboardMap(info["total_token_usage"]); total != nil {
				next := dashboardCodexTokenTotals{
					Input:  dashboardInt(total["input_tokens"]),
					Cached: dashboardInt(firstNonNil(total["cached_input_tokens"], total["cache_read_input_tokens"])),
					Output: dashboardInt(total["output_tokens"]),
				}
				delta = dashboardCodexTokenTotals{
					Input:  max(0, next.Input-previousValue(previous, "input")),
					Cached: max(0, next.Cached-previousValue(previous, "cached")),
					Output: max(0, next.Output-previousValue(previous, "output")),
				}
				previous = &next
			} else if last := dashboardMap(info["last_token_usage"]); last != nil {
				delta = dashboardCodexTokenTotals{
					Input:  max(0, dashboardInt(last["input_tokens"])),
					Cached: max(0, dashboardInt(firstNonNil(last["cached_input_tokens"], last["cache_read_input_tokens"]))),
					Output: max(0, dashboardInt(last["output_tokens"])),
				}
			} else {
				return
			}

			if delta.Input == 0 && delta.Cached == 0 && delta.Output == 0 {
				return
			}

			cached := min(delta.Cached, delta.Input)
			cost, ok := dashboardCodexCostUSD(model, delta.Input, cached, delta.Output)
			if !ok {
				return
			}

			dayCosts[dayKey] += cost
		}
	})

	return dayCosts, sessionID, err
}

func forEachJSONLLine(path string, fn func([]byte)) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()

	reader := bufio.NewReaderSize(file, 64*1024)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			line = bytes.TrimSpace(line)
			if len(line) > 0 {
				fn(line)
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

func dashboardIsVertexAIUsageEntry(obj map[string]any) bool {
	if requestID := dashboardStringFromMap(obj, "requestId"); strings.Contains(requestID, "_vrtx_") {
		return true
	}
	message := dashboardMap(obj["message"])
	if message == nil {
		return false
	}
	if messageID := dashboardStringFromMap(message, "id"); strings.Contains(messageID, "_vrtx_") {
		return true
	}
	model := dashboardStringFromMap(message, "model")
	return strings.HasPrefix(model, "claude-") && strings.Contains(model, "@")
}

func dashboardCodexCostUSD(model string, inputTokens int, cachedInputTokens int, outputTokens int) (float64, bool) {
	key := normalizeDashboardCodexModel(model)
	pricing, ok := dashboardCodexPricingTable[key]
	if !ok {
		return 0, false
	}

	cached := min(max(0, cachedInputTokens), max(0, inputTokens))
	nonCached := max(0, inputTokens-cached)
	cacheRate := pricing.InputPerToken
	if pricing.CacheReadPerToken != nil {
		cacheRate = *pricing.CacheReadPerToken
	}

	cost := float64(nonCached)*pricing.InputPerToken +
		float64(cached)*cacheRate +
		float64(max(0, outputTokens))*pricing.OutputPerToken
	return cost, true
}

func dashboardClaudeCostUSD(model string, inputTokens int, cacheReadInputTokens int, cacheCreationInputTokens int, outputTokens int) (float64, bool) {
	key := normalizeDashboardClaudeModel(model)
	pricing, ok := dashboardClaudePricingTable[key]
	if !ok {
		return 0, false
	}

	tieredCost := func(tokens int, base float64, above *float64, threshold *int) float64 {
		if threshold == nil || above == nil {
			return float64(tokens) * base
		}
		below := min(tokens, *threshold)
		over := max(tokens-*threshold, 0)
		return float64(below)*base + float64(over)*(*above)
	}

	cost := tieredCost(max(0, inputTokens), pricing.InputPerToken, pricing.InputPerTokenAboveThreshold, pricing.ThresholdTokens) +
		tieredCost(max(0, cacheReadInputTokens), pricing.CacheReadPerToken, pricing.CacheReadAboveThreshold, pricing.ThresholdTokens) +
		tieredCost(max(0, cacheCreationInputTokens), pricing.CacheCreationPerToken, pricing.CacheCreationAboveThreshold, pricing.ThresholdTokens) +
		tieredCost(max(0, outputTokens), pricing.OutputPerToken, pricing.OutputPerTokenAboveThreshold, pricing.ThresholdTokens)

	return cost, true
}

func normalizeDashboardCodexModel(raw string) string {
	model := strings.TrimSpace(raw)
	model = strings.TrimPrefix(model, "openai/")
	if _, ok := dashboardCodexPricingTable[model]; ok {
		return model
	}
	base := dashboardCodexDatedSuffixRE.ReplaceAllString(model, "")
	if _, ok := dashboardCodexPricingTable[base]; ok {
		return base
	}
	return model
}

func normalizeDashboardClaudeModel(raw string) string {
	model := strings.TrimSpace(raw)
	model = strings.TrimPrefix(model, "anthropic.")

	if lastDot := strings.LastIndex(model, "."); lastDot >= 0 && strings.Contains(model, "claude-") {
		tail := model[lastDot+1:]
		if strings.HasPrefix(tail, "claude-") {
			model = tail
		}
	}

	model = dashboardClaudeVersionRE.ReplaceAllString(model, "")
	base := dashboardClaudeDatedSuffixRE.ReplaceAllString(model, "")
	if _, ok := dashboardClaudePricingTable[base]; ok {
		return base
	}
	return model
}

func dashboardDayKeyFromRaw(value string) (string, bool) {
	if value == "" {
		return "", false
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		parsed, err = time.Parse(time.RFC3339, value)
		if err != nil {
			return "", false
		}
	}
	return dashboardDayKey(parsed), true
}

func parseDashboardTime(value string) (time.Time, bool) {
	if strings.TrimSpace(value) == "" {
		return time.Time{}, false
	}
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		parsed, err = time.Parse(time.RFC3339, value)
		if err != nil {
			return time.Time{}, false
		}
	}
	return parsed.In(time.Local), true
}

func dashboardRecentWindowStart(now time.Time) time.Time {
	localNow := now.In(time.Local)
	startOfToday := time.Date(localNow.Year(), localNow.Month(), localNow.Day(), 0, 0, 0, 0, time.Local)
	return startOfToday.AddDate(0, 0, -(dashboardUsageWeekDays - 1))
}

func dashboardDayKey(t time.Time) string {
	return t.In(time.Local).Format("2006-01-02")
}

func dashboardMap(value any) map[string]any {
	m, _ := value.(map[string]any)
	return m
}

func dashboardStringFromMap(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := m[key]; ok {
			switch v := value.(type) {
			case string:
				trimmed := strings.TrimSpace(v)
				if trimmed != "" {
					return trimmed
				}
			}
		}
	}
	return ""
}

func dashboardInt(value any) int {
	switch v := value.(type) {
	case int:
		return v
	case int64:
		return int(v)
	case float64:
		return int(v)
	case json.Number:
		i, err := v.Int64()
		if err == nil {
			return int(i)
		}
	case string:
		var parsed int
		_, err := fmt.Sscanf(strings.TrimSpace(v), "%d", &parsed)
		if err == nil {
			return parsed
		}
	}
	return 0
}

func previousValue(previous *dashboardCodexTokenTotals, field string) int {
	if previous == nil {
		return 0
	}
	switch field {
	case "input":
		return previous.Input
	case "cached":
		return previous.Cached
	case "output":
		return previous.Output
	default:
		return 0
	}
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		out = append(out, value)
	}
	return out
}

func firstNonNil(values ...any) any {
	for _, value := range values {
		if value != nil {
			return value
		}
	}
	return nil
}

func clampPercent(value int) int {
	if value < 0 {
		return 0
	}
	if value > 100 {
		return 100
	}
	return value
}

func float64Ptr(value float64) *float64 {
	v := value
	return &v
}

func intPtr(value int) *int {
	v := value
	return &v
}

const usageCacheFile = "usage-cache.json"

func usageCachePath(baseDir string) string {
	return filepath.Join(baseDir, "cache", usageCacheFile)
}

func writeUsageCache(baseDir string, state dashboardUsageState) error {
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	return atomicWriteFile(usageCachePath(baseDir), data, privateFilePerm)
}

func readUsageCache(baseDir string) (dashboardUsageState, error) {
	data, err := os.ReadFile(usageCachePath(baseDir))
	if err != nil {
		return dashboardUsageState{}, err
	}
	var state dashboardUsageState
	if err := json.Unmarshal(data, &state); err != nil {
		return dashboardUsageState{}, err
	}
	if state.needsRefresh(time.Now()) {
		return dashboardUsageState{}, fmt.Errorf("cache stale")
	}
	return state, nil
}
