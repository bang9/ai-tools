# vaultkey - Claude Usage Guide

## When to Use

Use `vaultkey` when you need to read or update secrets without storing them in plain text.

- API keys, webhook secrets, tokens, or passwords
- Secrets shared across machines through a private Git repo
- Cases where the value should stay encrypted at rest

## Typical Workflow

```bash
# 1. Initialize once
vaultkey init git@github.com:your-org/secrets.git

# 2. Read a secret
vaultkey get menulens/prod JWT_SECRET

# 3. Update a secret
vaultkey set menulens/prod JWT_SECRET "new-secret"

# 4. Inspect available keys
vaultkey list menulens
```

## Help

Run `vaultkey --help` for the full command list.

## Multiple Vaults

Vaults are named; each is a separate git repo with its own password. Commands operate
on the default vault unless overridden.

```bash
vaultkey --vault work init git@github.com:org/work-secrets.git  # add a named vault
vaultkey --vault work get acme/prod API_KEY                     # one-off override
vaultkey use work                                               # switch default
vaultkey vaults                                                 # list (* = default)
```

## Notes

- Password priority: `--password` flag → `VAULTKEY_PASSWORD_<VAULT_NAME>` env (e.g. `VAULTKEY_PASSWORD_WORK`) → `VAULTKEY_PASSWORD` env → interactive prompt.
- Vault selection priority: `--vault` flag → `VAULTKEY_VAULT` env → default set via `use`.
- Use scope names like `project/env`, for example `menulens/prod`.
- `set` and `delete` already sync changes; `push` and `pull` are for explicit repository sync.
- If a command fails with "sync conflict", run `vaultkey repair --take-remote` (keep remote) or `vaultkey repair --keep-local` (keep local) — the error message includes the repo path and manual steps.
