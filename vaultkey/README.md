# vaultkey

Encrypted secrets manager backed by a private Git repo. Store secrets locally with AES-256-GCM encryption and sync across machines via git.

## Install

### CLI

```bash
curl -fsSL https://raw.githubusercontent.com/bang9/ai-tools/main/vaultkey/install.sh | bash
```

Or build from source:

```bash
make build
```

### Plugin

Installs the `vaultkey` CLI automatically in Claude Code sessions:

```bash
/plugin marketplace add bang9/ai-tools
/plugin install vaultkey
```

## Quick Start

```bash
# 1. Initialize with a private repo
vaultkey init git@github.com:yourname/secrets.git

# 2. Store secrets
vaultkey set menulens/prod JWT_SECRET "my-jwt-secret"
vaultkey set menulens/dev JWT_SECRET "dev-secret"

# 3. Retrieve
vaultkey get menulens/prod JWT_SECRET

# 4. Sync
vaultkey push   # commit + push to remote
vaultkey pull   # pull from remote
```

## Commands

| Command | Description |
|---------|-------------|
| `init <repo-url>` | Clone repo and create vault (name with `--vault`) |
| `set <scope> <key> <value>` | Store encrypted secret |
| `get <scope> <key>` | Decrypt and print secret |
| `list [prefix]` | List scopes/keys (no values) |
| `delete <scope> <key>` | Remove a secret |
| `push` | Commit and push changes |
| `pull` | Pull latest from remote |
| `use <vault-name>` | Set the default vault |
| `vaults` | List configured vaults (`*` marks default) |

## Multiple Vaults

Each vault is a separate git repo with its own password. Vaults are named; the first
`init` creates a vault called `default`.

```bash
# Add a second vault named "work"
vaultkey --vault work init git@github.com:your-org/work-secrets.git

# One-off: target a specific vault
vaultkey --vault work get acme/prod API_KEY
VAULTKEY_VAULT=work vaultkey get acme/prod API_KEY

# Switch the default vault
vaultkey use work
vaultkey vaults
```

Vault selection priority: `--vault` flag → `VAULTKEY_VAULT` env → default set via `use`.

Pre-multi-vault configs (single `repo_path`) are migrated automatically: the existing
vault becomes `default` and keeps working unchanged.

## Password

Password is required for all encrypt/decrypt operations. Provided via (in priority order):

1. `--password` flag
2. `VAULTKEY_PASSWORD_<VAULT_NAME>` environment variable (uppercased, `-` → `_`, e.g. `VAULTKEY_PASSWORD_WORK`)
3. `VAULTKEY_PASSWORD` environment variable
4. Interactive prompt

## Scope Convention

Scopes are free-form strings. Use `/` to organize by project and environment:

```
menulens/dev
menulens/prod
ponte
shared/global
```

`vaultkey list menulens` matches all scopes starting with `menulens`.

## Security

- **Encryption**: AES-256-GCM (authenticated encryption)
- **Key derivation**: PBKDF2-SHA256 with 600,000 iterations
- **Per-value nonce**: Each secret gets a unique 12-byte nonce
- **File permissions**: vault.json is written with `0600`
- **Password never stored**: Only the PBKDF2 salt is persisted

Even if `vault.json` is exposed, secrets cannot be decrypted without the password.

## GitHub Actions

Use [`vaultkey-action`](../vaultkey-action) to install vaultkey and load secrets in CI workflows:

```yaml
- uses: bang9/ai-tools/vaultkey-action@v2
  with:
    gh-pat: ${{ secrets.VAULT_GH_PAT }}
    vault-repo: your-org/your-secrets-repo
    password: ${{ secrets.VAULTKEY_PASSWORD }}
    secrets: |
      CLOUDFLARE_API_TOKEN=cloudflare CLOUDFLARE_API_TOKEN
      DB_PASSWORD=myapp/prod DB_PASSWORD
```
