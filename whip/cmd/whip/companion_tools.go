package main

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

var (
	whipCompanionToolsHTTPClient = &http.Client{Timeout: 30 * time.Second}
	whipCompanionToolsURL        = func(repo, version string) string {
		return fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/whip/scripts/companion-tools.txt", repo, version)
	}
	whipEnsureBinaryConfURL = func(repo, version string) string {
		return fmt.Sprintf("https://raw.githubusercontent.com/%s/%s/whip/scripts/ensure-binary.conf", repo, version)
	}
	companionToolNamePattern       = regexp.MustCompile(`^[a-z0-9][a-z0-9-]*$`)
	legacyCompanionToolsForPattern = regexp.MustCompile(`^\s*for\s+tool\s+in\s+(.+?)\s*;\s*do\s*$`)
)

func fetchWhipCompanionTools(repo, version string) ([]string, error) {
	tools, err := fetchCompanionToolsURL(whipCompanionToolsURL(repo, version), parseCompanionTools)
	if err == nil {
		return tools, nil
	}

	var statusErr *httpStatusError
	if !errors.As(err, &statusErr) || statusErr.StatusCode != http.StatusNotFound {
		return nil, err
	}

	return fetchCompanionToolsURL(whipEnsureBinaryConfURL(repo, version), parseLegacyCompanionTools)
}

type httpStatusError struct {
	URL        string
	StatusCode int
	Status     string
}

func (e *httpStatusError) Error() string {
	return fmt.Sprintf("failed to fetch whip companion tools from %s: unexpected status %s", e.URL, e.Status)
}

func fetchCompanionToolsURL(url string, parse func([]byte) ([]string, error)) ([]string, error) {
	resp, err := whipCompanionToolsHTTPClient.Get(url)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch whip companion tools from %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, &httpStatusError{
			URL:        url,
			StatusCode: resp.StatusCode,
			Status:     resp.Status,
		}
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read whip companion tools from %s: %w", url, err)
	}

	tools, err := parse(body)
	if err != nil {
		return nil, fmt.Errorf("failed to parse whip companion tools from %s: %w", url, err)
	}

	return tools, nil
}

func parseCompanionTools(body []byte) ([]string, error) {
	scanner := bufio.NewScanner(bytes.NewReader(body))
	var rawTools []string

	for scanner.Scan() {
		line := scanner.Text()
		if idx := strings.Index(line, "#"); idx >= 0 {
			line = line[:idx]
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		rawTools = append(rawTools, line)
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}

	return validateCompanionTools(rawTools)
}

func parseLegacyCompanionTools(body []byte) ([]string, error) {
	scanner := bufio.NewScanner(bytes.NewReader(body))
	for scanner.Scan() {
		match := legacyCompanionToolsForPattern.FindStringSubmatch(scanner.Text())
		if len(match) != 2 {
			continue
		}
		return validateCompanionTools(strings.Fields(match[1]))
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return nil, fmt.Errorf("no legacy companion tool loop found")
}

func validateCompanionTools(rawTools []string) ([]string, error) {
	if len(rawTools) == 0 {
		return nil, fmt.Errorf("no companion tools defined")
	}

	tools := make([]string, 0, len(rawTools))
	seen := make(map[string]struct{}, len(rawTools))
	for _, tool := range rawTools {
		if !companionToolNamePattern.MatchString(tool) {
			return nil, fmt.Errorf("invalid companion tool %q", tool)
		}
		if _, exists := seen[tool]; exists {
			return nil, fmt.Errorf("duplicate companion tool %q", tool)
		}
		seen[tool] = struct{}{}
		tools = append(tools, tool)
	}

	return tools, nil
}
