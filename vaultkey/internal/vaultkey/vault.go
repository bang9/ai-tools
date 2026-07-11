package vaultkey

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/pbkdf2"
)

const (
	pbkdf2Iterations    = 600_000
	saltSize            = 32
	nonceSize           = 12 // AES-GCM standard
	keySize             = 32 // AES-256
	currentVaultVersion = 2
	vaultFileName       = "vault.json"
	kdfArgon2id         = "argon2id"
)

type KDFParams struct {
	Memory      uint32 `json:"memory"`
	Iterations  uint32 `json:"iterations"`
	Parallelism uint8  `json:"parallelism"`
}

var defaultKDFParams = KDFParams{
	Memory:      65536, // 64 MB
	Iterations:  3,
	Parallelism: 4,
}

type EncryptedValue struct {
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

type VaultFile struct {
	Version   int                                  `json:"version"`
	Salt      string                               `json:"salt"`
	KDF       string                               `json:"kdf,omitempty"`
	KDFParams *KDFParams                           `json:"kdf_params,omitempty"`
	Scopes    map[string]map[string]EncryptedValue `json:"scopes"`
}

type Vault struct {
	path string
	data VaultFile
	key  []byte
}

func LoadVault(repoPath, password string) (*Vault, error) {
	vaultPath := filepath.Join(repoPath, vaultFileName)

	if err := EnsurePathNotSymlink(repoPath); err != nil {
		return nil, fmt.Errorf("checking repo path: %w", err)
	}
	if err := EnsurePathNotSymlink(vaultPath); err != nil {
		return nil, fmt.Errorf("checking vault path: %w", err)
	}

	v := &Vault{path: vaultPath}

	raw, err := os.ReadFile(vaultPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("vault not found at %s (run 'vaultkey init' first)", vaultPath)
		}
		return nil, fmt.Errorf("reading vault: %w", err)
	}

	if hasConflictMarkers(raw) {
		return nil, &SyncConflictError{RepoPath: repoPath, Detail: "vault.json contains unresolved merge conflict markers"}
	}

	if err := json.Unmarshal(raw, &v.data); err != nil {
		return nil, fmt.Errorf("parsing vault.json: %w", err)
	}

	if v.data.Version < 1 || v.data.Version > currentVaultVersion {
		return nil, fmt.Errorf("unsupported vault version: %d", v.data.Version)
	}

	salt, err := base64.StdEncoding.DecodeString(v.data.Salt)
	if err != nil {
		return nil, fmt.Errorf("decoding salt: %w", err)
	}

	v.key = deriveKey(password, salt, v.data.Version, v.data.KDFParams)
	return v, nil
}

func CreateVault(repoPath, password string) (*Vault, error) {
	vaultPath := filepath.Join(repoPath, vaultFileName)
	if err := EnsurePathNotSymlink(repoPath); err != nil {
		return nil, fmt.Errorf("checking repo path: %w", err)
	}
	if err := EnsurePathNotSymlink(vaultPath); err != nil {
		return nil, fmt.Errorf("checking vault path: %w", err)
	}

	if _, err := os.Lstat(vaultPath); err == nil {
		return nil, fmt.Errorf("vault already exists at %s", vaultPath)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("checking vault path: %w", err)
	}

	salt := make([]byte, saltSize)
	if _, err := rand.Read(salt); err != nil {
		return nil, fmt.Errorf("generating salt: %w", err)
	}

	params := defaultKDFParams
	v := &Vault{
		path: vaultPath,
		key:  deriveKey(password, salt, currentVaultVersion, &params),
		data: VaultFile{
			Version:   currentVaultVersion,
			Salt:      base64.StdEncoding.EncodeToString(salt),
			KDF:       kdfArgon2id,
			KDFParams: &params,
			Scopes:    make(map[string]map[string]EncryptedValue),
		},
	}

	if err := v.save(); err != nil {
		return nil, err
	}
	return v, nil
}

func (v *Vault) Set(scope, key, value string) error {
	if err := v.setWithoutSave(scope, key, value); err != nil {
		return err
	}
	return v.save()
}

func (v *Vault) setWithoutSave(scope, key, value string) error {
	nonce := make([]byte, nonceSize)
	if _, err := rand.Read(nonce); err != nil {
		return fmt.Errorf("generating nonce: %w", err)
	}

	block, err := aes.NewCipher(v.key)
	if err != nil {
		return fmt.Errorf("creating cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return fmt.Errorf("creating GCM: %w", err)
	}

	var aad []byte
	if v.data.Version >= 2 {
		aad = buildAAD(scope, key)
	}

	ciphertext := gcm.Seal(nil, nonce, []byte(value), aad)

	if v.data.Scopes[scope] == nil {
		v.data.Scopes[scope] = make(map[string]EncryptedValue)
	}

	v.data.Scopes[scope][key] = EncryptedValue{
		Nonce:      base64.StdEncoding.EncodeToString(nonce),
		Ciphertext: base64.StdEncoding.EncodeToString(ciphertext),
	}

	return nil
}

func (v *Vault) Get(scope, key string) (string, error) {
	scopeData, ok := v.data.Scopes[scope]
	if !ok {
		return "", fmt.Errorf("scope not found: %s", scope)
	}

	entry, ok := scopeData[key]
	if !ok {
		return "", fmt.Errorf("key not found: %s/%s", scope, key)
	}

	nonce, err := base64.StdEncoding.DecodeString(entry.Nonce)
	if err != nil {
		return "", fmt.Errorf("decoding nonce: %w", err)
	}

	ciphertext, err := base64.StdEncoding.DecodeString(entry.Ciphertext)
	if err != nil {
		return "", fmt.Errorf("decoding ciphertext: %w", err)
	}

	block, err := aes.NewCipher(v.key)
	if err != nil {
		return "", fmt.Errorf("creating cipher: %w", err)
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("creating GCM: %w", err)
	}

	var aad []byte
	if v.data.Version >= 2 {
		aad = buildAAD(scope, key)
	}

	plaintext, err := gcm.Open(nil, nonce, ciphertext, aad)
	if err != nil {
		return "", fmt.Errorf("decryption failed (wrong password?): %w", err)
	}

	return string(plaintext), nil
}

func (v *Vault) Delete(scope, key string) error {
	scopeData, ok := v.data.Scopes[scope]
	if !ok {
		return fmt.Errorf("scope not found: %s", scope)
	}

	if _, ok := scopeData[key]; !ok {
		return fmt.Errorf("key not found: %s/%s", scope, key)
	}

	delete(scopeData, key)
	if len(scopeData) == 0 {
		delete(v.data.Scopes, scope)
	}

	return v.save()
}

func (v *Vault) List(prefix string) []string {
	var results []string

	for scope, keys := range v.data.Scopes {
		if prefix != "" && !strings.HasPrefix(scope, prefix) {
			continue
		}
		for key := range keys {
			results = append(results, scope+"/"+key)
		}
	}

	sort.Strings(results)
	return results
}

func (v *Vault) save() error {
	raw, err := json.MarshalIndent(v.data, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling vault: %w", err)
	}
	raw = append(raw, '\n')

	if err := writeFileAtomically(v.path, raw, 0600); err != nil {
		return fmt.Errorf("writing vault: %w", err)
	}
	return nil
}

func deriveKey(password string, salt []byte, version int, params *KDFParams) []byte {
	if version >= 2 && params != nil {
		return argon2.IDKey([]byte(password), salt, params.Iterations, params.Memory, params.Parallelism, keySize)
	}
	return pbkdf2.Key([]byte(password), salt, pbkdf2Iterations, keySize, sha256.New)
}

func buildAAD(scope, key string) []byte {
	return []byte(scope + "/" + key)
}

func hasConflictMarkers(raw []byte) bool {
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(line, "<<<<<<< ") {
			return true
		}
	}
	return false
}

// VaultFileHasConflictMarkers reports whether the on-disk vault.json carries
// unresolved merge conflict markers.
func VaultFileHasConflictMarkers(repoPath string) bool {
	raw, err := os.ReadFile(filepath.Join(repoPath, vaultFileName))
	if err != nil {
		return false
	}
	return hasConflictMarkers(raw)
}

// RestoreVaultFile discards the working-tree vault.json in favor of the last
// committed version.
func RestoreVaultFile(repoPath string) error {
	if out, err := git(repoPath, "checkout", "HEAD", "--", vaultFileName); err != nil {
		return gitCommandError("git checkout", out, err)
	}
	return nil
}

// Version returns the vault format version.
func (v *Vault) Version() int {
	return v.data.Version
}

// IsLegacy returns true if the vault uses the v1 format.
func (v *Vault) IsLegacy() bool {
	return v.data.Version < 2
}

// Migrate re-encrypts a v1 vault to v2 (Argon2id KDF + GCM AAD).
// Returns the number of secrets migrated. If already v2, returns (0, nil).
func (v *Vault) Migrate(password string) (int, error) {
	if v.data.Version >= 2 {
		return 0, nil
	}

	// Phase 1: Decrypt all secrets with v1 key
	type entry struct {
		scope, key, value string
	}
	var entries []entry
	for scope, keys := range v.data.Scopes {
		for key := range keys {
			val, err := v.Get(scope, key)
			if err != nil {
				return 0, fmt.Errorf("decrypting %s/%s during migration: %w", scope, key, err)
			}
			entries = append(entries, entry{scope, key, val})
		}
	}

	// Phase 2: Generate new salt and derive new key with Argon2id
	newSalt := make([]byte, saltSize)
	if _, err := rand.Read(newSalt); err != nil {
		return 0, fmt.Errorf("generating new salt: %w", err)
	}

	params := defaultKDFParams
	v.data.Version = currentVaultVersion
	v.data.Salt = base64.StdEncoding.EncodeToString(newSalt)
	v.data.KDF = kdfArgon2id
	v.data.KDFParams = &params
	v.key = deriveKey(password, newSalt, currentVaultVersion, &params)

	// Phase 3: Re-encrypt all secrets with new key + AAD
	v.data.Scopes = make(map[string]map[string]EncryptedValue)
	for _, e := range entries {
		if err := v.setWithoutSave(e.scope, e.key, e.value); err != nil {
			return 0, fmt.Errorf("re-encrypting %s/%s during migration: %w", e.scope, e.key, err)
		}
	}

	// Phase 4: Save once
	if err := v.save(); err != nil {
		return 0, fmt.Errorf("saving migrated vault: %w", err)
	}

	return len(entries), nil
}
