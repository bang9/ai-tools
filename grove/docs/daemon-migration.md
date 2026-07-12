# Terminal daemon migration

Grove's terminals used to run inside **tmux**: every pane was a `grove-*` tmux
session, and grove drove it by shelling out (`new-session`, `capture-pane`,
`set-option`, `display-message`, …).

They now run inside **grove-daemon** — a small, private, grove-owned process that
holds the PTYs. tmux is gone from the terminal path entirely; grove no longer
requires tmux to be installed.

This is a real behavior change. Read the two lists below.

---

## What you gain

### Shells survive an app quit — and a machine reboot

Closing Grove no longer kills your shells. The daemon keeps them running, and
reopening Grove **reattaches** to the exact live session: same process, same
scrollback, same cursor, same running command.

That much tmux already did. What is new is **cold restore**. The daemon
continuously checkpoints each session's screen and scrollback to disk, so after a
reboot — or a daemon crash, or a `kill -9` — Grove brings the pane back with its
content intact, restores its working directory, and starts a fresh shell in it.
You lose the running *process* (nothing can survive a reboot), but you no longer
lose the *pane*: its history and its cwd come back.

Cold restore is deliberately skipped when you closed the pane **on purpose** — a
deliberate close is a clean end, not something to resurrect.

### Faster, quieter output

The daemon batches PTY output on an 8 ms window before it crosses to the UI, and
a resize is now answered from the daemon's own terminal emulator instead of a
`tmux display-message` shell-out. A busy pane no longer forks a subprocess for
every status poll.

---

## What you lose

### `tmux attach` recovery is gone

**This is the big one.** Previously, if Grove itself broke — crashed, hung, or
failed to launch — you could still reach your work from any terminal:

```sh
tmux ls
tmux attach -t grove-<...>
```

**That escape hatch no longer exists.** The daemon is not tmux and speaks no tmux
protocol; its control socket is a private Unix socket, `0600`, readable only by
your user and only by Grove. There is no supported way to attach to a Grove pane
from outside Grove.

If you depend on out-of-band recovery, run your long-lived work under your **own**
tmux/screen/zellij session *inside* a Grove pane. Grove no longer manages tmux, so
a tmux you start yourself is entirely yours and behaves normally.

### `~/.tmux.conf` no longer applies

Grove panes were tmux clients, so your tmux config leaked into them — sometimes
usefully, sometimes not. It does not any more. **None** of the following affect
Grove terminals now:

| What you had in `~/.tmux.conf` | Status in Grove |
| --- | --- |
| Prefix key (`C-b` / `C-a`) and all key bindings | **Gone.** Keys go straight to your shell. |
| Copy mode — `prefix [`, vi/emacs selection, **search (`/`, `?`)** | **Gone.** Use Grove's own scrollback: mouse/trackpad scroll, drag-select, and ⌘F to find. |
| `set -g mouse on` | **Not needed.** Mouse and selection are handled by Grove. |
| Status line / theme | **Gone** (Grove already hid it, so nothing visibly changes). |
| Pane/window splits and navigation | **Not applicable.** Grove's own splits and tabs replace them; each pane is its own session. |
| `history-limit` | **Replaced** — see below. |

Note that copy-mode **search** is the loss most people notice. Grove's find (⌘F)
covers the same need against the pane's scrollback, but the keystrokes are
different.

### Scrollback depth is now a Grove preference

`history-limit` is replaced by **`daemonScrollbackBytes`**, in
`~/.grove/config.json` under `preferences`:

```jsonc
{
  "preferences": {
    // Bytes of raw scrollback the daemon keeps per pane.
    // Default: 2097152 (2 MiB) — roughly a generous tmux history-limit.
    "daemonScrollbackBytes": 2097152
  }
}
```

It is a **byte** budget, not a line count (the daemon keeps a byte-exact ring so
cold restore can replay it faithfully). There is **no settings-UI control for it in
this release** — edit the config file and restart Grove.

Raising it costs memory per pane; the caps are what keep the daemon's footprint
flat (see the benchmark below).

---

## One-time cleanup on first launch

The first time you launch this build, Grove kills every leftover **grove-managed**
tmux session from your previous build — sessions whose name starts with `grove-`
**and** that carry Grove's own `@grove_managed` marker. Nothing else is touched:
your own tmux sessions are matched by neither condition and are left completely
alone.

Why: those sessions are now unreachable orphans. Nothing in Grove attaches to them
any more, and no code path would ever reap them, so they would sit there holding
shells (and memory) forever, invisible.

The sweep runs **once, ever** — it drops a marker in `~/.grove/daemon/` and never
re-runs. If tmux is not installed, it does nothing and succeeds.

> Anything you were running in a Grove pane before you upgrade will be **stopped**
> by this sweep. Finish or detach long-running work before you upgrade.

---

## Known gap: sleep/wake on Tauri

On the Electron build, Grove checkpoints every session the moment macOS reports
`suspend`, so the on-disk state matches the screen exactly at the instant the lid
closes.

The Tauri build has **no suspend hook** yet. Its exposure is bounded instead by the
daemon's regular 5-second checkpoint tick, so a sleep can lose at most the last few
seconds of output — and if a child dies while the machine is asleep, the wake-side
**cold restore** rebuilds the pane from the last checkpoint anyway. The result is a
narrower guarantee, not a broken one; the suspend hook is deferred, not dropped.

---

## Cost: measured, not estimated

From the pre-cutover benchmark gate — **12 sessions (6 idle + 6 busy)**:

| | grove-daemon | tmux server |
| --- | --- | --- |
| RSS, 12 sessions (6 idle + 6 busy) | **48.2 MB** | 8.5 MB |
| CPU, 12 sessions (6 idle + 6 busy) | **5.8 %** | 3.4 % |
| RSS, 12 idle sessions | **10.2 MB** | 4.4 MB |

RSS **plateaus** — the per-session ring and scrollback caps bound it — with no leak
across the run and no checkpoint stalls.

The daemon costs more than tmux, and we are not going to pretend otherwise. Two
things put the gap in perspective:

1. **tmux's number understates its true cost.** The tmux server offloads work into
   external helper processes, so its own RSS is not the whole bill; the daemon does
   that work in-process and pays for it visibly, in one number.
2. **It buys the emulator.** The daemon keeps a real terminal emulator and a
   byte-exact scrollback ring per session. That is precisely what makes cold
   restore, instant reattach, and shell-out-free resize/status possible — none of
   which tmux gave us.

A few tens of MB, once, for terminals that survive a reboot.
