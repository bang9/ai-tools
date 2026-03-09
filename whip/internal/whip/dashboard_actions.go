package whip

import (
	"context"
	"fmt"
	"net/url"
	"os/exec"
	"strings"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

func (m DashboardModel) cleanTasks() tea.Cmd {
	return func() tea.Msg {
		count, _ := m.store.CleanTerminal()
		exec.Command("claude-irc", "clean").Run()
		return cleanedMsg(count)
	}
}

func (m DashboardModel) loadTasks() tea.Cmd {
	return func() tea.Msg {
		tasks, err := m.store.ListTasks()
		if err != nil {
			return err
		}
		return tasks
	}
}

func loadPeers() tea.Cmd {
	return func() tea.Msg {
		out, err := exec.Command("claude-irc", "who").Output()
		if err != nil {
			return peersMsg(nil)
		}
		var peers []peerInfo
		for _, line := range strings.Split(string(out), "\n") {
			fields := strings.Fields(line)
			if len(fields) < 2 || fields[0] == "PEER" {
				continue
			}
			peers = append(peers, peerInfo{
				Name:   fields[0],
				Online: fields[1] == "online",
			})
		}
		return peersMsg(peers)
	}
}

func (m DashboardModel) retryTask(taskID string) tea.Cmd {
	return func() tea.Msg {
		cfg, err := m.store.LoadConfig()
		if err != nil {
			return retryResultMsg{err: err}
		}
		task, err := m.store.LoadTask(taskID)
		if err != nil {
			return retryResultMsg{err: err}
		}
		masterIRC := WorkspaceMasterIRCName(task.WorkspaceName())
		if task.WorkspaceName() == GlobalWorkspaceName {
			masterIRC = DefaultMasterIRCName(cfg)
		}
		if _, err := RetryTaskRun(m.store, taskID, LaunchSource{Actor: "dashboard", Command: "retry"}, masterIRC); err != nil {
			return retryResultMsg{err: err}
		}
		return retryResultMsg{}
	}
}

type resumeResultMsg struct {
	err         error
	sessionName string
}

func (m DashboardModel) resumeTask(task *Task) tea.Cmd {
	return func() tea.Msg {
		backend, err := GetBackend(task.Backend)
		if err != nil {
			return resumeResultMsg{err: err}
		}

		sessionName := tmuxResumeSessionName(task.ID)
		if IsTmuxSessionName(sessionName) {
			return resumeResultMsg{sessionName: sessionName}
		}

		shellCmd := fmt.Sprintf(
			`cd %s && WHIP_SHELL_PID=$$ WHIP_TASK_ID=%s whip task heartbeat %s >/dev/null 2>&1; WHIP_SHELL_PID=$$ WHIP_TASK_ID=%s %s ; exit`,
			shellEscape(task.CWD),
			shellEscape(task.ID),
			shellEscape(task.ID),
			shellEscape(task.ID),
			backend.BuildResumeCmd(task),
		)
		if err := SpawnTmuxSession(sessionName, shellCmd); err != nil {
			return resumeResultMsg{err: fmt.Errorf("failed to spawn resume session: %w", err)}
		}
		return resumeResultMsg{sessionName: sessionName}
	}
}

func (m DashboardModel) sendIRCMsg(target, message string) tea.Cmd {
	return func() tea.Msg {
		fullMsg := message + "\n\n---\n[Sent from dashboard operator via TUI]"
		err := exec.Command("claude-irc", "--name", "user", "msg", target, fullMsg).Run()
		return ircSendResultMsg{err: err}
	}
}

type remoteStartedMsg struct {
	cmd      *exec.Cmd
	url      string
	shortURL string
	err      error
}

type remoteStoppedMsg struct{}

func (m DashboardModel) startRemote(cfg RemoteConfig) tea.Cmd {
	return func() tea.Msg {
		if !IsMasterSessionAlive(cfg.Workspace) {
			if err := SpawnMasterSession(cfg); err != nil {
				return remoteStartedMsg{err: fmt.Errorf("spawn master: %w", err)}
			}
		}

		storeCfg, _ := m.store.LoadConfig()
		token := storeCfg.ServeToken

		cmd, result, err := StartServe(context.Background(), cfg, token, true)
		if err != nil {
			return remoteStartedMsg{err: fmt.Errorf("start serve: %w", err)}
		}

		if t := connectURLToken(result.ConnectURL); t != "" {
			_, _ = m.store.UpdateConfig(func(storeCfg *Config) error {
				storeCfg.ServeToken = t
				return nil
			})
		}

		return remoteStartedMsg{cmd: cmd, url: result.ConnectURL, shortURL: result.ShortURL}
	}
}

func (m DashboardModel) stopRemote() tea.Cmd {
	return func() tea.Msg {
		if m.serveProcess != nil && m.serveProcess.Process != nil {
			m.serveProcess.Process.Signal(syscall.SIGTERM)
			done := make(chan error, 1)
			go func() { done <- m.serveProcess.Wait() }()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				m.serveProcess.Process.Kill()
				<-done
			}
		}
		StopMasterSession(m.remoteWorkspace)
		return remoteStoppedMsg{}
	}
}

func connectURLToken(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	if t := u.Query().Get("token"); t != "" {
		return t
	}
	fragment, err := url.ParseQuery(u.Fragment)
	if err != nil {
		return ""
	}
	return fragment.Get("token")
}
