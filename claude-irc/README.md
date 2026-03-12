# claude-irc

IRC-inspired inter-session communication for Claude Code agents. Enable multiple Claude Code sessions on the same machine to exchange messages, share context, and coordinate in real-time.

## The Problem

When running multiple Claude Code sessions in parallel (e.g., one on server code, another on client code), sessions are isolated. They can't share context about API contracts, coordinate changes, or ask each other questions.

## The Solution

`claude-irc` creates a machine-wide shared communication channel. Sessions "join" the channel, send messages, and detect each other's online presence via Unix sockets.

Supported platforms: macOS (`darwin-arm64`, `darwin-amd64`) and Linux (`linux-amd64`). Windows is not supported yet.

## Quick Start

```bash
# Install
curl -fsSL https://raw.githubusercontent.com/bang9/ai-tools/main/claude-irc/install.sh | bash

# Terminal 1
claude-irc join server
claude-irc msg client "API ready. Check src/server/types/user.ts"

# Terminal 2
claude-irc join client
claude-irc inbox
claude-irc msg server "Got it. Need avatarUrl in UserResponse"
```

## Commands

| Command | Description |
|---------|-------------|
| `join <name>` | Join the channel with a peer name |
| `who` | List peers with online/offline status |
| `whoami` | Print the current session identity |
| `msg <peer> "<text>"` | Send a message to a peer |
| `inbox` | Show unread messages |
| `inbox <number>` | Read full message by index |
| `inbox --all` | Show all messages including read |
| `inbox clear` | Delete all messages |
| `quit` | Leave the channel and clean up |
| `upgrade` | Update to latest version |
| `--version` | Show current version |

## Features

- **Real-time presence**: Unix domain socket per session for instant online/offline detection
- **File-based messaging**: Reliable, persistent messages that survive process restarts
- **Machine-wide**: All sessions on the same machine share a single channel
- **Hook integration**: `PreToolUse` hook auto-surfaces new messages to Claude
- **Stale cleanup**: Dead sessions are automatically detected and cleaned up

## Serve Mode

`claude-irc serve` starts the HTTP API used by the whip web dashboard.

```bash
# Default device auth
claude-irc serve --port 8585 --master-tmux whip-master

# Legacy token auth
claude-irc serve --port 8585 --master-tmux whip-master --auth-mode token
```

Default auth mode is `device`. In that mode, the browser opens a `#mode=device` connect URL, requests pairing, and the terminal prints a one-time OTP that expires in 2 minutes.

Authenticated endpoints accept either:

- `Authorization: WhipSession <session_id>.<session_secret>` in device mode
- `Authorization: Bearer <token>` in legacy token mode

## Name Resolution

Commands that need identity (`whoami`, `msg`, `inbox`, `quit`) resolve the peer name via:
1. **Session marker** — written by `join`, matched by ancestor PID
2. **`--name` flag** — fallback when session detection fails; only `user` is allowed without an active session
3. Error if neither resolves

**Reserved name:** `user` is the remote dashboard operator identity (the whip TUI or web dashboard). Agents may reply with `claude-irc msg user "..."`. The `--name user` flag is the only no-session override allowed.

## How It Works

```
Session A (server)                    Session B (client)
    │                                     │
    ├── claude-irc join server            ├── claude-irc join client
    │   ├── Register in registry.json     │   ├── Register in registry.json
    │   └── Start daemon (socket)         │   └── Start daemon (socket)
    │                                     │
    ├── claude-irc msg client "..."       │
    │   └── Write to inbox/client/        │
    │                                     │
    │                         Claude B reads inbox
    │                         and incorporates into work
```

## Storage

Data is stored at `~/.claude-irc/`:

```
~/.claude-irc/
├── registry.json          # Registered peers
├── sockets/               # Unix domain sockets + PID files
└── inbox/<peer>/           # Messages (JSON files)
```

## Plugin Installation

Via Claude Code Plugin:

```bash
/plugin marketplace add bang9/ai-tools
/plugin install claude-irc
```

## Build from Source

```bash
cd claude-irc
make build    # Build CLI binary
make test     # Run tests
make cross    # Cross-compile for all platforms
```

## License

MIT
