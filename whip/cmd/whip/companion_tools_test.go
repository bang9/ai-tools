package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestParseCompanionToolsIgnoresCommentsAndBlankLines(t *testing.T) {
	got, err := parseCompanionTools([]byte(`
# Required companion tools for whip.
claude-irc

webform   # keep installed with whip
rewind
`))
	if err != nil {
		t.Fatalf("parseCompanionTools returned error: %v", err)
	}

	want := []string{"claude-irc", "webform", "rewind"}
	if !slices.Equal(got, want) {
		t.Fatalf("expected %v, got %v", want, got)
	}
}

func TestParseCompanionToolsRejectsDuplicates(t *testing.T) {
	_, err := parseCompanionTools([]byte("claude-irc\nwebform\nclaude-irc\n"))
	if err == nil {
		t.Fatal("expected duplicate companion tool error")
	}
}

func TestParseLegacyCompanionTools(t *testing.T) {
	got, err := parseLegacyCompanionTools([]byte(`
post_install_hook() {
    for tool in claude-irc webform rewind; do
        echo "$tool"
    done
}
`))
	if err != nil {
		t.Fatalf("parseLegacyCompanionTools returned error: %v", err)
	}

	want := []string{"claude-irc", "webform", "rewind"}
	if !slices.Equal(got, want) {
		t.Fatalf("expected %v, got %v", want, got)
	}
}

func TestFetchWhipCompanionTools(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/whip/scripts/companion-tools.txt" {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte("claude-irc\nwebform\nrewind\n"))
	}))
	t.Cleanup(server.Close)

	oldClient := whipCompanionToolsHTTPClient
	oldURL := whipCompanionToolsURL
	oldFallbackURL := whipEnsureBinaryConfURL
	whipCompanionToolsHTTPClient = server.Client()
	whipCompanionToolsURL = func(repo, version string) string {
		if repo != "bang9/ai-tools" {
			t.Fatalf("expected repo bang9/ai-tools, got %s", repo)
		}
		if version != "v1.2.3" {
			t.Fatalf("expected version v1.2.3, got %s", version)
		}
		return server.URL + "/whip/scripts/companion-tools.txt"
	}
	t.Cleanup(func() {
		whipCompanionToolsHTTPClient = oldClient
		whipCompanionToolsURL = oldURL
		whipEnsureBinaryConfURL = oldFallbackURL
	})

	got, err := fetchWhipCompanionTools("bang9/ai-tools", "v1.2.3")
	if err != nil {
		t.Fatalf("fetchWhipCompanionTools returned error: %v", err)
	}

	want := []string{"claude-irc", "webform", "rewind"}
	if !slices.Equal(got, want) {
		t.Fatalf("expected %v, got %v", want, got)
	}
}

func TestFetchWhipCompanionToolsFallsBackToEnsureBinaryConf(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/whip/scripts/companion-tools.txt":
			http.NotFound(w, r)
		case "/whip/scripts/ensure-binary.conf":
			w.Write([]byte(`
post_install_hook() {
    for tool in claude-irc webform rewind; do
        echo "$tool"
    done
}
`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	oldClient := whipCompanionToolsHTTPClient
	oldURL := whipCompanionToolsURL
	oldFallbackURL := whipEnsureBinaryConfURL
	whipCompanionToolsHTTPClient = server.Client()
	whipCompanionToolsURL = func(repo, version string) string {
		return server.URL + "/whip/scripts/companion-tools.txt"
	}
	whipEnsureBinaryConfURL = func(repo, version string) string {
		return server.URL + "/whip/scripts/ensure-binary.conf"
	}
	t.Cleanup(func() {
		whipCompanionToolsHTTPClient = oldClient
		whipCompanionToolsURL = oldURL
		whipEnsureBinaryConfURL = oldFallbackURL
	})

	got, err := fetchWhipCompanionTools("bang9/ai-tools", "v1.2.3")
	if err != nil {
		t.Fatalf("fetchWhipCompanionTools returned error: %v", err)
	}

	want := []string{"claude-irc", "webform", "rewind"}
	if !slices.Equal(got, want) {
		t.Fatalf("expected %v, got %v", want, got)
	}
}

func TestCompanionToolsFileMatchesCurrentSet(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("..", "..", "scripts", "companion-tools.txt"))
	if err != nil {
		t.Fatalf("failed to read canonical companion tool file: %v", err)
	}

	got, err := parseCompanionTools(body)
	if err != nil {
		t.Fatalf("parseCompanionTools returned error: %v", err)
	}

	want := []string{"claude-irc", "webform", "rewind"}
	if !slices.Equal(got, want) {
		t.Fatalf("expected %v, got %v", want, got)
	}
}
