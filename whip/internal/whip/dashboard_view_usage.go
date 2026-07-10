package whip

import (
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

func (m DashboardModel) renderUsageStrip(width int) string {
	providers := m.usageState.visibleProviders()
	if len(providers) == 0 {
		if m.usageLoading {
			return m.renderUsageLoadingStrip()
		}
		return ""
	}

	lines := make([]string, 0, len(providers))
	for _, provider := range providers {
		line := m.renderUsageLine(provider, width)
		if line != "" {
			lines = append(lines, line)
		}
	}

	return strings.Join(lines, "\n")
}

func (m DashboardModel) renderUsageLoadingStrip() string {
	spinner := spinnerFrames[m.spinnerIndex]
	claudeName := padRight(lipgloss.NewStyle().Bold(true).Foreground(colorClaude).Render("Claude"), 8)
	codexName := padRight(lipgloss.NewStyle().Bold(true).Foreground(colorCodex).Render("Codex"), 8)
	claudeSpinner := lipgloss.NewStyle().Foreground(colorClaude).Render(spinner)
	codexSpinner := lipgloss.NewStyle().Foreground(colorCodex).Render(spinner)
	return "  " + claudeName + " " + claudeSpinner + "\n" +
		"  " + codexName + " " + codexSpinner
}

func (m DashboardModel) usageStripLineCount() int {
	n := len(m.usageState.visibleProviders())
	if n == 0 && m.usageLoading {
		return 2
	}
	return n
}

func (m DashboardModel) renderUsageLine(provider dashboardUsageProviderSummary, width int) string {
	if provider.Primary == nil && provider.Weekly == nil && provider.TodayCost == nil && provider.WeekCost == nil {
		return ""
	}

	nameStyle := lipgloss.NewStyle().Bold(true).Foreground(colorClaude)
	barStyle := lipgloss.NewStyle().Foreground(colorClaude)
	if provider.Provider == "Codex" {
		nameStyle = lipgloss.NewStyle().Bold(true).Foreground(colorCodex)
		barStyle = lipgloss.NewStyle().Foreground(colorCodex)
	}

	name := padRight(nameStyle.Render(provider.Provider), 8)
	segments := []string{m.renderUsagePrimary(provider.Primary, barStyle)}
	if provider.Weekly != nil {
		segments = append(segments, m.renderUsageWeekly(provider.Weekly))
	}
	if provider.TodayCost != nil || provider.WeekCost != nil {
		segments = append(segments, m.renderUsageCost(provider.TodayCost, provider.WeekCost))
	}

	separator := lipgloss.NewStyle().Foreground(colorDim).Render(" | ")
	line := "  " + name + " " + strings.Join(filterNonEmptySegments(segments), separator)
	if width > 0 && lipgloss.Width(line) > width-2 {
		line = ansi.Truncate(line, max(0, width-2), "")
	}
	return line
}

func (m DashboardModel) renderUsagePrimary(window *dashboardUsageWindow, barStyle lipgloss.Style) string {
	if window == nil {
		return lipgloss.NewStyle().Foreground(colorSubtle).Render("-")
	}

	bar := renderUsageBar(window.LeftPercent, 10)
	percent := lipgloss.NewStyle().Foreground(colorText).Render(fmt.Sprintf("%d%%", window.LeftPercent))
	reset := lipgloss.NewStyle().Foreground(colorSubtle).Render("(" + formatDashboardPrimaryReset(window.ResetAt) + ")")
	return barStyle.Render(bar) + " " + percent + " " + reset
}

func (m DashboardModel) renderUsageWeekly(window *dashboardUsageWindow) string {
	if window == nil {
		return ""
	}
	label := lipgloss.NewStyle().Foreground(colorMuted).Render("W")
	percent := lipgloss.NewStyle().Foreground(colorText).Render(fmt.Sprintf("%d%%", window.LeftPercent))
	reset := lipgloss.NewStyle().Foreground(colorSubtle).Render("(" + formatDashboardWeeklyReset(window.ResetAt) + ")")
	return label + " " + percent + " " + reset
}

func (m DashboardModel) renderUsageCost(today *float64, week *float64) string {
	labelStyle := lipgloss.NewStyle().Foreground(colorMuted)
	valueStyle := lipgloss.NewStyle().Foreground(colorMoney)

	var parts []string
	if today != nil {
		parts = append(parts, labelStyle.Render("today")+" "+valueStyle.Render(formatDashboardUSD(*today)))
	}
	if week != nil {
		parts = append(parts, labelStyle.Render("week")+" "+valueStyle.Render(formatDashboardUSD(*week)))
	}
	return strings.Join(parts, labelStyle.Render(" / "))
}

func renderUsageBar(leftPercent int, width int) string {
	if width <= 0 {
		return ""
	}
	filled := int(math.Round(float64(clampPercent(leftPercent)) * float64(width) / 100.0))
	if filled < 0 {
		filled = 0
	}
	if filled > width {
		filled = width
	}
	return strings.Repeat("█", filled) + strings.Repeat("░", width-filled)
}

func formatDashboardPrimaryReset(resetAt *time.Time) string {
	return formatDashboardPrimaryResetAt(resetAt, time.Now())
}

func formatDashboardPrimaryResetAt(resetAt *time.Time, now time.Time) string {
	if resetAt == nil {
		return "-"
	}
	layout := "3:04 PM"
	if resetAt.Sub(now) >= 24*time.Hour {
		layout = "1/2 3:04 PM"
	}
	return resetAt.In(time.Local).Format(layout)
}

func formatDashboardWeeklyReset(resetAt *time.Time) string {
	if resetAt == nil {
		return "-"
	}
	return resetAt.In(time.Local).Format("1/2 3:04 PM")
}

func formatDashboardUSD(amount float64) string {
	return fmt.Sprintf("$%.2f", amount)
}

func filterNonEmptySegments(segments []string) []string {
	out := make([]string, 0, len(segments))
	for _, segment := range segments {
		if strings.TrimSpace(segment) != "" {
			out = append(out, segment)
		}
	}
	return out
}
