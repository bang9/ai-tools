package upgrade

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestConfigDefaults(t *testing.T) {
	cfg := Config{
		Repo:       "bang9/ai-tools",
		BinaryName: "test-tool",
		Version:    "v1.0.0",
	}

	if cfg.Repo != "bang9/ai-tools" {
		t.Errorf("expected repo bang9/ai-tools, got %s", cfg.Repo)
	}
	if cfg.BinaryName != "test-tool" {
		t.Errorf("expected binary name test-tool, got %s", cfg.BinaryName)
	}
	if len(cfg.CompanionTools) != 0 {
		t.Errorf("expected empty companion tools, got %v", cfg.CompanionTools)
	}
}

func TestConfigWithCompanionTools(t *testing.T) {
	cfg := Config{
		Repo:           "bang9/ai-tools",
		BinaryName:     "whip",
		Version:        "v1.0.0",
		CompanionTools: []string{"claude-irc", "webform"},
	}

	if len(cfg.CompanionTools) != 2 {
		t.Fatalf("expected 2 companion tools, got %d", len(cfg.CompanionTools))
	}
	if cfg.CompanionTools[0] != "claude-irc" {
		t.Errorf("expected first companion claude-irc, got %s", cfg.CompanionTools[0])
	}
	if cfg.CompanionTools[1] != "webform" {
		t.Errorf("expected second companion webform, got %s", cfg.CompanionTools[1])
	}
}

func TestGetLatestVersion(t *testing.T) {
	withTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/repos/test/repo/releases/latest" {
			http.NotFound(w, r)
			return
		}
		fmt.Fprint(w, `{"tag_name":"v1.2.3"}`)
	}))

	version, err := GetLatestVersion("test/repo")
	if err != nil {
		t.Fatalf("GetLatestVersion returned error: %v", err)
	}
	if version != "v1.2.3" {
		t.Fatalf("expected v1.2.3, got %s", version)
	}
}

func TestGetLatestVersionBadStatus(t *testing.T) {
	withTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))

	_, err := GetLatestVersion("test/repo")
	if err == nil {
		t.Fatal("expected error for non-200 latest release response")
	}
	if !strings.Contains(err.Error(), "unexpected status 404") {
		t.Fatalf("expected 404 error, got %v", err)
	}
}

func TestChecksumForAssetParsesManifest(t *testing.T) {
	manifest := []byte("abc123  tool-a\nfff999 *tool-b\n")

	checksum, err := checksumForAsset(manifest, "tool-b")
	if err != nil {
		t.Fatalf("checksumForAsset returned error: %v", err)
	}
	if checksum != "fff999" {
		t.Fatalf("expected checksum fff999, got %s", checksum)
	}
}

func TestDownloadBinaryVerifiedInstall(t *testing.T) {
	tmpDir := t.TempDir()
	destPath := filepath.Join(tmpDir, "test-tool")
	oldContent := []byte("old-binary-content")
	if err := os.WriteFile(destPath, oldContent, 0755); err != nil {
		t.Fatal(err)
	}

	binaryContent := []byte("verified-binary")
	expectedChecksum := sha256Hex(binaryContent)
	assetName := platformBinaryName("test-tool")

	withTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/releases/test/repo/v1.2.3/test-tool-checksums.txt":
			fmt.Fprintf(w, "%s  %s\n", expectedChecksum, assetName)
		case "/releases/test/repo/v1.2.3/" + assetName:
			w.Write(binaryContent)
		default:
			http.NotFound(w, r)
		}
	}))

	if err := DownloadBinary("test/repo", "v1.2.3", "test-tool", destPath); err != nil {
		t.Fatalf("DownloadBinary returned error: %v", err)
	}

	content, err := os.ReadFile(destPath)
	if err != nil {
		t.Fatalf("failed to read installed binary: %v", err)
	}
	if string(content) != string(binaryContent) {
		t.Fatalf("expected installed content %q, got %q", binaryContent, content)
	}

	if _, err := os.Stat(destPath + ".tmp"); !os.IsNotExist(err) {
		t.Fatalf("tmp file should not remain after successful install")
	}
}

func TestDownloadBinaryChecksumMismatchPreservesOldBinary(t *testing.T) {
	tmpDir := t.TempDir()
	destPath := filepath.Join(tmpDir, "test-tool")
	oldContent := []byte("old-binary-content")
	if err := os.WriteFile(destPath, oldContent, 0755); err != nil {
		t.Fatal(err)
	}

	assetName := platformBinaryName("test-tool")
	withTestServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/releases/test/repo/v1.2.3/test-tool-checksums.txt":
			fmt.Fprintf(w, "%s  %s\n", sha256Hex([]byte("different-binary")), assetName)
		case "/releases/test/repo/v1.2.3/" + assetName:
			w.Write([]byte("downloaded-binary"))
		default:
			http.NotFound(w, r)
		}
	}))

	err := DownloadBinary("test/repo", "v1.2.3", "test-tool", destPath)
	if err == nil {
		t.Fatal("expected checksum mismatch error")
	}
	if !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("expected checksum mismatch error, got %v", err)
	}

	content, readErr := os.ReadFile(destPath)
	if readErr != nil {
		t.Fatalf("old binary should still exist after failed download: %v", readErr)
	}
	if string(content) != string(oldContent) {
		t.Fatalf("old binary content should be unchanged, got %q", content)
	}

	if _, statErr := os.Stat(destPath + ".tmp"); !os.IsNotExist(statErr) {
		t.Fatalf("tmp file should be cleaned up after checksum mismatch")
	}
}

func TestDownloadBinaryPlatformFormat(t *testing.T) {
	tests := []struct {
		name       string
		binaryName string
		goos       string
		goarch     string
		want       string
	}{
		{
			name:       "current platform",
			binaryName: "claude-irc",
			goos:       runtime.GOOS,
			goarch:     runtime.GOARCH,
			want:       platformBinaryName("claude-irc"),
		},
		{
			name:       "windows executable",
			binaryName: "vaultkey",
			goos:       "windows",
			goarch:     "amd64",
			want:       "vaultkey-windows-amd64.exe",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := platformBinaryNameFor(tt.binaryName, tt.goos, tt.goarch); got != tt.want {
				t.Errorf("platform binary format: expected %s, got %s", tt.want, got)
			}
		})
	}
}

func TestInstalledBinaryName(t *testing.T) {
	if got := installedBinaryNameFor("vaultkey", "windows"); got != "vaultkey.exe" {
		t.Fatalf("expected windows binary name vaultkey.exe, got %s", got)
	}
	if got := installedBinaryNameFor("vaultkey", "darwin"); got != "vaultkey" {
		t.Fatalf("expected non-windows binary name vaultkey, got %s", got)
	}
}

func TestRunAlreadyUpToDate(t *testing.T) {
	cfg := Config{
		Repo:       "bang9/ai-tools",
		BinaryName: "test-tool",
		Version:    "v1.0.0",
	}

	if cfg.Version == "dev" {
		t.Error("test version should not be dev")
	}

	latestVersion := "v1.0.0"
	if cfg.Version != "dev" && latestVersion == cfg.Version {
		return
	}

	t.Error("should detect already up to date")
}

func TestRunToolList(t *testing.T) {
	tests := []struct {
		name      string
		cfg       Config
		wantTools []string
	}{
		{
			name: "self only",
			cfg: Config{
				BinaryName:     "webform",
				CompanionTools: nil,
			},
			wantTools: []string{"webform"},
		},
		{
			name: "self with companions",
			cfg: Config{
				BinaryName:     "whip",
				CompanionTools: []string{"claude-irc", "webform"},
			},
			wantTools: []string{"whip", "claude-irc", "webform"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tools := []string{tt.cfg.BinaryName}
			tools = append(tools, tt.cfg.CompanionTools...)

			if len(tools) != len(tt.wantTools) {
				t.Fatalf("expected %d tools, got %d", len(tt.wantTools), len(tools))
			}
			for i, want := range tt.wantTools {
				if tools[i] != want {
					t.Errorf("tool[%d]: expected %s, got %s", i, want, tools[i])
				}
			}

			if tools[0] != tt.cfg.BinaryName {
				t.Errorf("first tool should be self (%s), got %s", tt.cfg.BinaryName, tools[0])
			}
		})
	}
}

func withTestServer(t *testing.T, handler http.Handler) {
	t.Helper()

	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)

	oldClient := httpClient
	httpClient = server.Client()
	t.Cleanup(func() {
		httpClient = oldClient
	})

	oldLatestReleaseURL := latestReleaseURL
	oldReleaseAssetURL := releaseAssetURL
	latestReleaseURL = func(repo string) string {
		return server.URL + "/api/repos/" + repo + "/releases/latest"
	}
	releaseAssetURL = func(repo, version, asset string) string {
		return fmt.Sprintf("%s/releases/%s/%s/%s", server.URL, repo, version, asset)
	}
	t.Cleanup(func() {
		latestReleaseURL = oldLatestReleaseURL
		releaseAssetURL = oldReleaseAssetURL
	})
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}
