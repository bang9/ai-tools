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

	"golang.org/x/crypto/pbkdf2"
)

const (
	pbkdf2Iterations = 600_000
	saltSize         = 32
	nonceSize        = 12 // AES-GCM standard
	keySize          = 32 // AES-256
	vaultVersion     = 1
	vaultFileName    = "vault.json"
)

type EncryptedValue struct {
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
}

type VaultFile struct {
	Version int                                  `json:"version"`
	Salt    string                               `json:"salt"`
	Scopes  map[string]map[string]EncryptedValue `json:"scopes"`
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

	if err := json.Unmarshal(raw, &v.data); err != nil {
		return nil, fmt.Errorf("parsing vault.json: %w", err)
	}

	if v.data.Version != vaultVersion {
		return nil, fmt.Errorf("unsupported vault version: %d", v.data.Version)
	}

	salt, err := base64.StdEncoding.DecodeString(v.data.Salt)
	if err != nil {
		return nil, fmt.Errorf("decoding salt: %w", err)
	}

	v.key = deriveKey(password, salt)
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

	v := &Vault{
		path: vaultPath,
		key:  deriveKey(password, salt),
		data: VaultFile{
			Version: vaultVersion,
			Salt:    base64.StdEncoding.EncodeToString(salt),
			Scopes:  make(map[string]map[string]EncryptedValue),
		},
	}

	if err := v.save(); err != nil {
		return nil, err
	}
	return v, nil
}

func (v *Vault) Set(scope, key, value string) error {
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

	ciphertext := gcm.Seal(nil, nonce, []byte(value), nil)

	if v.data.Scopes[scope] == nil {
		v.data.Scopes[scope] = make(map[string]EncryptedValue)
	}

	v.data.Scopes[scope][key] = EncryptedValue{
		Nonce:      base64.StdEncoding.EncodeToString(nonce),
		Ciphertext: base64.StdEncoding.EncodeToString(ciphertext),
	}

	return v.save()
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

	plaintext, err := gcm.Open(nil, nonce, ciphertext, nil)
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

func deriveKey(password string, salt []byte) []byte {
	return pbkdf2.Key([]byte(password), salt, pbkdf2Iterations, keySize, sha256.New)
}
