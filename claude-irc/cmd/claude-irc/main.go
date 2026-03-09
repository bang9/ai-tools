package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"text/tabwriter"
	"time"

	"github.com/bang9/ai-tools/claude-irc/internal/irc"
	"github.com/bang9/ai-tools/shared/upgrade"
	"github.com/spf13/cobra"
	"golang.org/x/term"
)

var (
	nameFlag string

	// Set via -ldflags at build time
	version = "dev"

	// detectSession is the function used to detect the current session.
	// Overridable in tests to isolate from the real session environment.
	detectSession = func(pid int) (*irc.Store, string, error) {
		return irc.DetectSession(pid)
	}
)

const dashboardOperatorName = "user"

func main() {
	root := &cobra.Command{
		Use:     "claude-irc",
		Short:   "IRC-inspired inter-session communication for Claude Code",
		Version: version,
	}

	root.PersistentFlags().StringVar(&nameFlag, "name", "", "Override peer name (only 'user' allowed without active session)")

	root.AddCommand(
		joinCmd(),
		whoCmd(),
		msgCmd(),
		inboxCmd(),
		quitCmd(),
		daemonCmd(),
		upgradeCmd(),
		serveCmd(),
	)

	if err := root.Execute(); err != nil {
		os.Exit(1)
	}
}

func joinCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "join <name>",
		Short: "Join the channel with a peer name",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			name := args[0]

			if !irc.IsValidPeerName(name) {
				return fmt.Errorf("invalid peer name '%s': only letters, numbers, hyphens, and underscores allowed (max 32 chars)", name)
			}

			store, err := irc.NewStore()
			if err != nil {
				return err
			}

			sessionPID := irc.FindSessionPID(os.Getppid())

			// Register in registry
			if err := store.Register(name, sessionPID); err != nil {
				if errors.Is(err, irc.ErrAlreadyJoined) {
					fmt.Fprintf(os.Stderr, "Already joined as '%s'\n", name)
					return nil
				}
				return err
			}

			// Spawn daemon for online presence
			daemonPID, err := store.SpawnDaemon(name, sessionPID)
			if err != nil {
				store.Unregister(name)
				return fmt.Errorf("failed to spawn daemon: %w", err)
			}

			// Update daemon PID in registry
			store.SetDaemonPID(name, daemonPID)

			// Write session marker for hook detection (keyed by daemonPID for uniqueness)
			if err := store.WriteSessionMarker(name, daemonPID, sessionPID); err != nil {
				store.KillDaemon(name)
				store.Unregister(name)
				return fmt.Errorf("failed to write session marker: %w", err)
			}

			fmt.Fprintf(os.Stderr, "Joined as '%s' (daemon pid: %d)\n", name, daemonPID)
			return nil
		},
	}
}

func whoCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "who",
		Short: "List peers with online/offline status",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := irc.NewStore()
			if err != nil {
				return err
			}

			statuses, err := store.CheckAllPresence()
			if err != nil {
				return err
			}

			// Clean up orphan inbox directories
			store.CleanOrphanDirs()

			if len(statuses) == 0 {
				fmt.Println("No peers connected.")
				return nil
			}

			w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
			fmt.Fprintln(w, "PEER\tSTATUS\tSINCE\tCWD")
			for _, s := range statuses {
				status := "offline"
				if s.Online {
					status = "online"
				}
				since := timeAgo(s.RegisteredAt)
				fmt.Fprintf(w, "%s\t%s\t%s\t%s\n", s.Name, status, since, s.CWD)
			}
			w.Flush()
			return nil
		},
	}
}

func msgCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "msg <peer> <message>",
		Short: "Send a message to a peer",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			peer, content := args[0], args[1]

			if !irc.IsValidPeerName(peer) {
				return fmt.Errorf("invalid peer name '%s'", peer)
			}
			if strings.TrimSpace(content) == "" {
				return fmt.Errorf("message cannot be empty")
			}
			if len(content) > 10240 {
				return fmt.Errorf("message too large (%d bytes, max 10KB)", len(content))
			}

			store, err := irc.NewStore()
			if err != nil {
				return err
			}

			from, err := resolveMyName(store)
			if err != nil {
				return err
			}

			if peer == from {
				return fmt.Errorf("cannot send message to yourself")
			}

			// `user` is a virtual remote-operator inbox. It does not need a live registry entry.
			if peer != dashboardOperatorName {
				peers, err := store.ListPeers()
				if err != nil {
					return err
				}
				if _, ok := peers[peer]; !ok {
					return fmt.Errorf("peer '%s' not found (use 'who' to list peers)", peer)
				}
			}

			if err := store.SendMessage(peer, from, content); err != nil {
				return err
			}

			fmt.Fprintf(os.Stderr, "Message sent to '%s'\n", peer)
			return nil
		},
	}
}

func inboxCmd() *cobra.Command {
	var all bool
	cmd := &cobra.Command{
		Use:   "inbox [index|clear]",
		Short: "Show unread messages (use index to read full, 'clear' to delete all)",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := irc.NewStore()
			if err != nil {
				return err
			}

			name, err := resolveMyName(store)
			if err != nil {
				return err
			}

			// Handle "inbox clear"
			if len(args) == 1 && args[0] == "clear" {
				if err := store.ClearInbox(name); err != nil {
					return err
				}
				fmt.Fprintln(os.Stderr, "Inbox cleared.")
				return nil
			}

			messages, err := store.ReadInbox(name)
			if err != nil {
				return err
			}

			// Read specific message by index
			if len(args) == 1 {
				index, err := strconv.Atoi(args[0])
				if err != nil || index < 1 || index > len(messages) {
					return fmt.Errorf("invalid index: %s (1-%d)", args[0], len(messages))
				}
				msg := messages[index-1]
				fmt.Printf("[%s] %s\n\n%s\n", msg.From, timeAgo(msg.Timestamp), msg.Content)
				store.MarkAllRead(name)
				return nil
			}

			// Build display list: indices always refer to the full message list
			type indexedMsg struct {
				index int // 1-based position in full message list
				msg   irc.Message
			}
			var display []indexedMsg
			for i, msg := range messages {
				if all || !msg.Read {
					display = append(display, indexedMsg{index: i + 1, msg: msg})
				}
			}

			if len(display) == 0 {
				fmt.Println("No messages.")
				return nil
			}

			w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
			fmt.Fprintln(w, "#\tFROM\tTIME\tMESSAGE")
			for _, d := range display {
				preview := strings.ReplaceAll(d.msg.Content, "\n", " ")
				if len(preview) > 80 {
					preview = preview[:77] + "..."
				}
				fmt.Fprintf(w, "%d\t%s\t%s\t%s\n",
					d.index, d.msg.From, timeAgo(d.msg.Timestamp), preview)
			}
			w.Flush()

			store.MarkAllRead(name)
			return nil
		},
	}
	cmd.Flags().BoolVar(&all, "all", false, "Show all messages including read")
	cmd.Flags().SetInterspersed(false)
	cmd.FParseErrWhitelist = cobra.FParseErrWhitelist{UnknownFlags: true} // Allow "inbox -1"
	return cmd
}

func quitCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "quit",
		Short: "Leave the channel and clean up",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := irc.NewStore()
			if err != nil {
				return nil // No store dir — nothing to quit
			}

			name, err := resolveMyName(store)
			if err != nil {
				return fmt.Errorf("not joined (nothing to quit)")
			}

			// Kill daemon
			store.KillDaemon(name)

			// Remove session markers (clean all markers pointing to this name)
			cleanSessionMarkers(store, name)

			// Unregister from registry
			store.Unregister(name)

			fmt.Fprintf(os.Stderr, "Left as '%s'. Goodbye!\n", name)
			return nil
		},
	}
}

// cleanSessionMarkers removes all session marker files that point to the given name.
func cleanSessionMarkers(store *irc.Store, name string) {
	entries, err := os.ReadDir(store.BaseDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !strings.HasPrefix(e.Name(), ".session_") {
			continue
		}
		path := filepath.Join(store.BaseDir, e.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		// Extract peer name from marker (first line; new format has "name\nsessionPID")
		content := strings.TrimSpace(string(data))
		peerName := strings.SplitN(content, "\n", 2)[0]
		if strings.TrimSpace(peerName) == name {
			os.Remove(path)
		}
	}
}

func daemonCmd() *cobra.Command {
	var name string
	var sessionPID int

	cmd := &cobra.Command{
		Use:    "__daemon",
		Hidden: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := irc.NewStore()
			if err != nil {
				return err
			}
			return store.RunDaemon(name, sessionPID)
		},
	}

	cmd.Flags().StringVar(&name, "name", "", "Peer name")
	cmd.Flags().IntVar(&sessionPID, "session-pid", 0, "Parent session PID to monitor")
	cmd.MarkFlagRequired("name")

	return cmd
}

// resolveMyName determines the current peer's name.
// Priority: session marker > --name fallback > single registered peer.
// --name is only allowed when session detection fails (prevents impersonation).
func resolveMyName(store *irc.Store) (string, error) {
	// Try session detection first
	_, detected, detectErr := detectSession(os.Getppid())

	if nameFlag != "" {
		// --name provided: only allow if session detection fails or matches
		if detectErr == nil && detected != "" && detected != nameFlag {
			return "", fmt.Errorf("--name '%s' does not match your session '%s'", nameFlag, detected)
		}
		if detectErr != nil || detected == "" {
			// No active session: only allow reserved observer name
			if nameFlag != "user" {
				return "", fmt.Errorf("--name '%s' not allowed without an active session (only 'user' is permitted)", nameFlag)
			}
		}
		return nameFlag, nil
	}

	if detectErr == nil && detected != "" {
		return detected, nil
	}

	return "", fmt.Errorf("not joined (run 'claude-irc join <name>' first, or use --name)")
}

func serveCmd() *cobra.Command {
	var port int
	var bindHost string
	var tunnel string
	var masterTmux string
	var token string

	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Start HTTP API server for external access",
		Long:  "Starts an HTTP API server that wraps the local claude-irc store, with optional cloudflared tunnel for remote access.",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			store, err := irc.NewStore()
			if err != nil {
				return err
			}

			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()

			// Signal handling
			sigCh := make(chan os.Signal, 1)
			signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
			go func() { <-sigCh; cancel() }()

			// Optional tunnel
			var tunnelMgr *irc.TunnelManager
			var publicURL string
			if cmd.Flags().Changed("tunnel") {
				tunnelMgr = irc.NewTunnelManager(tunnel, port)
				var err error
				publicURL, err = tunnelMgr.Start(ctx)
				if err != nil {
					return fmt.Errorf("tunnel: %w", err)
				}
				defer tunnelMgr.Stop()
			}

			return irc.RunServer(ctx, irc.ServerConfig{
				Port:       port,
				BindHost:   bindHost,
				Store:      store,
				MasterTmux: masterTmux,
				Token:      token,
				OnReady: func(info irc.ServerInfo) {
					connectURL, shortURL, webURL := serveURLs(info, publicURL)
					fmt.Fprintf(os.Stderr, "claude-irc serve started.\n")
					fmt.Fprintf(os.Stderr, "Connect URL: %s\n", connectURL)
					fmt.Fprintf(os.Stderr, "Short URL: %s\n", shortURL)
					if keyboardShortcutsAvailable() {
						fmt.Fprintf(os.Stderr, "\nShortcuts: [o] open in browser  [c] copy URL  [q] quit\n")
						go serveKeyboardLoop(ctx, webURL, connectURL, cancel)
					}
				},
			})
		},
	}

	cmd.Flags().IntVar(&port, "port", 8585, "HTTP server port")
	cmd.Flags().StringVar(&bindHost, "bind", "", "Host/address to bind the HTTP server to (default 127.0.0.1; set explicitly for non-local access)")
	cmd.Flags().StringVar(&tunnel, "tunnel", "", "Cloudflare Tunnel hostname (empty for quick tunnel, or domain like irc.bang9.dev)")
	cmd.Flags().StringVar(&masterTmux, "master-tmux", "", "Master tmux session name for capture/input endpoints")
	cmd.Flags().StringVar(&token, "token", "", "Pre-set auth token (reuse across restarts); if empty, a new one is generated")
	return cmd
}

func serveURLs(info irc.ServerInfo, publicURL string) (connectURL string, shortURL string, webURL string) {
	baseURL := info.LocalURL
	if publicURL != "" {
		baseURL = publicURL
	}
	connectURL = irc.ConnectURL(baseURL, info.Token)
	shortURL = fmt.Sprintf("%s/s/%s", strings.TrimRight(baseURL, "/"), info.ShortCode)
	webURL = irc.DashboardURL(connectURL)
	return connectURL, shortURL, webURL
}

type keyboardLoopDeps struct {
	stdin    io.Reader
	stderr   io.Writer
	makeRaw  func() (func(), error)
	openURL  func(string) error
	copyText func(string) error
}

func upgradeCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "upgrade",
		Short: "Upgrade claude-irc to the latest version",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return upgrade.Run(upgrade.Config{
				Repo:       "bang9/ai-tools",
				BinaryName: "claude-irc",
				Version:    version,
			})
		},
	}
}

func keyboardShortcutsAvailable() bool {
	return term.IsTerminal(int(os.Stdin.Fd()))
}

func serveKeyboardLoop(ctx context.Context, webURL, connectURL string, cancel context.CancelFunc) {
	fd := int(os.Stdin.Fd())
	if !term.IsTerminal(fd) {
		return
	}
	serveKeyboardLoopWithDeps(ctx, webURL, connectURL, cancel, keyboardLoopDeps{
		stdin:  os.Stdin,
		stderr: os.Stderr,
		makeRaw: func() (func(), error) {
			state, err := term.MakeRaw(fd)
			if err != nil {
				return nil, err
			}
			return func() {
				_ = term.Restore(fd, state)
			}, nil
		},
		openURL: func(url string) error {
			return exec.Command("open", url).Run()
		},
		copyText: func(text string) error {
			cmd := exec.Command("pbcopy")
			cmd.Stdin = strings.NewReader(text)
			return cmd.Run()
		},
	})
}

func serveKeyboardLoopWithDeps(ctx context.Context, webURL, connectURL string, cancel context.CancelFunc, deps keyboardLoopDeps) {
	restore, err := deps.makeRaw()
	if err != nil {
		fmt.Fprintf(deps.stderr, "\nShortcuts unavailable: %v\n", err)
		return
	}
	var restoreOnce sync.Once
	restoreTerminal := func() {
		restoreOnce.Do(func() {
			if restore != nil {
				restore()
			}
		})
	}
	defer restoreTerminal()
	go func() {
		<-ctx.Done()
		restoreTerminal()
	}()

	buf := make([]byte, 1)
	for {
		n, err := deps.stdin.Read(buf)
		if err != nil || n == 0 {
			return
		}
		switch buf[0] {
		case 'o', 'O':
			if err := deps.openURL(webURL); err != nil {
				fmt.Fprintf(deps.stderr, "\rFailed to open browser: %v\n", err)
				continue
			}
			fmt.Fprintf(deps.stderr, "\rOpened in browser\n")
		case 'c', 'C':
			if err := deps.copyText(connectURL); err != nil {
				fmt.Fprintf(deps.stderr, "\rFailed to copy URL: %v\n", err)
				continue
			}
			fmt.Fprintf(deps.stderr, "\rCopied to clipboard\n")
		case 'q', 'Q', 3: // 3 = Ctrl+C
			fmt.Fprintf(deps.stderr, "\r\n")
			cancel()
			return
		}
	}
}

// timeAgo returns a human-readable relative time string.
func timeAgo(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		m := int(d.Minutes())
		return fmt.Sprintf("%dm ago", m)
	case d < 24*time.Hour:
		h := int(d.Hours())
		return fmt.Sprintf("%dh ago", h)
	default:
		days := int(d.Hours() / 24)
		return fmt.Sprintf("%dd ago", days)
	}
}
