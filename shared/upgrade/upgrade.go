package upgrade

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Config holds the upgrade configuration for a tool.
type Config struct {
	Repo           string   // GitHub repo (e.g., "bang9/ai-tools")
	BinaryName     string   // Tool binary name (e.g., "claude-irc")
	Version        string   // Current version (set via -ldflags)
	CompanionTools []string // Additional tools to upgrade alongside self
}

var (
	httpClient = &http.Client{Timeout: 30 * time.Second}

	latestReleaseURL = func(repo string) string {
		return fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", repo)
	}

	releaseAssetURL = func(repo, version, asset string) string {
		return fmt.Sprintf("https://github.com/%s/releases/download/%s/%s", repo, version, asset)
	}

	osExecutable = os.Executable
)

type httpStatusError struct {
	statusCode int
	status     string
	url        string
}

func (e *httpStatusError) Error() string {
	return fmt.Sprintf("unexpected status %s for %s", e.status, e.url)
}

// GetLatestVersion fetches the latest release tag from the GitHub API.
func GetLatestVersion(repo string) (string, error) {
	resp, err := httpClient.Get(latestReleaseURL(repo))
	if err != nil {
		return "", fmt.Errorf("failed to check latest version: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("failed to check latest version: unexpected status %s", resp.Status)
	}

	var payload struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", fmt.Errorf("failed to parse latest version from GitHub: %w", err)
	}
	if payload.TagName == "" {
		return "", fmt.Errorf("failed to parse latest version from GitHub")
	}

	return payload.TagName, nil
}

// DownloadBinary downloads a release binary to destPath using the safe download
// pattern: require a published checksum, verify the download, then move it into place.
func DownloadBinary(repo, version, binaryName, destPath string) error {
	platformBinary := platformBinaryName(binaryName)
	expectedChecksum, err := fetchExpectedChecksum(repo, version, binaryName, platformBinary)
	if err != nil {
		return err
	}

	downloadURL := releaseAssetURL(repo, version, platformBinary)
	tmpPath, err := createTempDownloadPath(destPath)
	if err != nil {
		return fmt.Errorf("failed to create temp download path for %s: %w", binaryName, err)
	}
	defer os.Remove(tmpPath)

	// Download to temporary file
	if err := downloadToFile(downloadURL, tmpPath); err != nil {
		return fmt.Errorf("download failed for %s: %w", binaryName, err)
	}

	actualChecksum, err := sha256File(tmpPath)
	if err != nil {
		return fmt.Errorf("checksum calculation failed for %s: %w", binaryName, err)
	}
	if !strings.EqualFold(actualChecksum, expectedChecksum) {
		return fmt.Errorf(
			"checksum mismatch for %s: expected %s, got %s",
			binaryName,
			expectedChecksum,
			actualChecksum,
		)
	}

	if err := os.Chmod(tmpPath, 0755); err != nil {
		return fmt.Errorf("chmod failed for %s: %w", binaryName, err)
	}

	// Remove old binary
	os.Remove(destPath)

	// Move new binary into place
	if err := os.Rename(tmpPath, destPath); err != nil {
		return fmt.Errorf("failed to install %s: %w", binaryName, err)
	}

	return nil
}

func platformBinaryName(binaryName string) string {
	return platformBinaryNameFor(binaryName, runtime.GOOS, runtime.GOARCH)
}

func platformBinaryNameFor(binaryName, goos, goarch string) string {
	platformBinary := fmt.Sprintf("%s-%s-%s", binaryName, goos, goarch)
	if goos == "windows" {
		return platformBinary + ".exe"
	}
	return platformBinary
}

func installedBinaryName(binaryName string) string {
	return installedBinaryNameFor(binaryName, runtime.GOOS)
}

func installedBinaryNameFor(binaryName, goos string) string {
	if goos == "windows" {
		return binaryName + ".exe"
	}
	return binaryName
}

func checksumManifestName(binaryName string) string {
	return binaryName + "-checksums.txt"
}

func fetchExpectedChecksum(repo, version, binaryName, assetName string) (string, error) {
	manifestURL := releaseAssetURL(repo, version, checksumManifestName(binaryName))
	manifest, err := downloadBytes(manifestURL)
	if err != nil {
		if isHTTPStatus(err, http.StatusNotFound) {
			return "", fmt.Errorf(
				"checksum manifest missing for %s %s: %w",
				binaryName,
				version,
				err,
			)
		}
		return "", fmt.Errorf("failed to fetch checksum manifest for %s: %w", binaryName, err)
	}

	checksum, err := checksumForAsset(manifest, assetName)
	if err != nil {
		return "", fmt.Errorf("failed to read checksum for %s: %w", assetName, err)
	}

	return checksum, nil
}

func checksumForAsset(manifest []byte, assetName string) (string, error) {
	scanner := bufio.NewScanner(bytes.NewReader(manifest))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 2 {
			continue
		}

		fileName := strings.TrimPrefix(fields[1], "*")
		if fileName == assetName {
			return fields[0], nil
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}

	return "", fmt.Errorf("asset %s not found in checksum manifest", assetName)
}

func downloadBytes(url string) ([]byte, error) {
	resp, err := httpClient.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, &httpStatusError{
			statusCode: resp.StatusCode,
			status:     resp.Status,
			url:        url,
		}
	}

	return io.ReadAll(resp.Body)
}

func downloadToFile(url, destPath string) error {
	resp, err := httpClient.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return &httpStatusError{
			statusCode: resp.StatusCode,
			status:     resp.Status,
			url:        url,
		}
	}

	file, err := os.Create(destPath)
	if err != nil {
		return err
	}

	if _, err := io.Copy(file, resp.Body); err != nil {
		file.Close()
		return err
	}

	return file.Close()
}

func createTempDownloadPath(destPath string) (string, error) {
	tmpFile, err := os.CreateTemp(filepath.Dir(destPath), filepath.Base(destPath)+".tmp-*")
	if err != nil {
		return "", err
	}

	tmpPath := tmpFile.Name()
	if err := tmpFile.Close(); err != nil {
		os.Remove(tmpPath)
		return "", err
	}

	return tmpPath, nil
}

func isHTTPStatus(err error, statusCode int) bool {
	var statusErr *httpStatusError
	return errors.As(err, &statusErr) && statusErr.statusCode == statusCode
}

func sha256File(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()

	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}

	return hex.EncodeToString(hash.Sum(nil)), nil
}

// Run performs the full upgrade flow: check version, download self, download companions.
func Run(cfg Config) error {
	fmt.Fprintln(os.Stderr, "Checking for updates...")

	latestVersion, err := GetLatestVersion(cfg.Repo)
	if err != nil {
		return err
	}

	if cfg.Version != "dev" && latestVersion == cfg.Version {
		fmt.Fprintf(os.Stderr, "Already up to date (%s)\n", cfg.Version)
		return nil
	}

	// Resolve current binary path
	binPath, err := osExecutable()
	if err != nil {
		binPath = filepath.Join(os.Getenv("HOME"), ".local", "bin", installedBinaryName(cfg.BinaryName))
	}
	if resolved, err := filepath.EvalSymlinks(binPath); err == nil {
		binPath = resolved
	}

	installDir := filepath.Dir(binPath)

	// Build list: self first, then companions
	tools := []string{cfg.BinaryName}
	tools = append(tools, cfg.CompanionTools...)
	var failures []error
	updatedCount := 0

	for idx, tool := range tools {
		destPath := filepath.Join(installDir, installedBinaryName(tool))
		if idx == 0 {
			destPath = binPath
		}
		fmt.Fprintf(os.Stderr, "Downloading %s %s...\n", tool, latestVersion)
		if err := DownloadBinary(cfg.Repo, latestVersion, tool, destPath); err != nil {
			fmt.Fprintf(os.Stderr, "Warning: %v\n", err)
			failures = append(failures, fmt.Errorf("%s: %w", tool, err))
			continue
		}
		updatedCount++
		fmt.Fprintf(os.Stderr, "  %s updated\n", tool)
	}

	if len(failures) > 0 {
		if updatedCount > 0 {
			fmt.Fprintf(os.Stderr, "Updated %d/%d tools before failure\n", updatedCount, len(tools))
		}
		return fmt.Errorf("upgrade incomplete: %w", errors.Join(failures...))
	}

	fmt.Fprintf(os.Stderr, "Updated to %s\n", latestVersion)
	return nil
}
