package main

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	whiplib "github.com/bang9/ai-tools/whip/internal/whip"
)

func TestWhipStartSoloFlowRegression(t *testing.T) {
	h := newSkillFlowHarness(t)
	const workspace = "skills-solo"

	normalID := createWhipTask(t,
		"task", "create", "Normal task",
		"--workspace", workspace,
		"--cwd", h.workspaceDir,
		"--backend", "claude",
		"--difficulty", "easy",
		"--desc", "Normal lifecycle flow",
	)
	failingID := createWhipTask(t,
		"task", "create", "Failing task",
		"--workspace", workspace,
		"--cwd", h.workspaceDir,
		"--backend", "claude",
		"--difficulty", "medium",
		"--desc", "Failure and reassignment flow",
	)

	assertWorkspaceView(t, workspace, "direct-cwd")

	createdSnapshot := readLifecycleSnapshot(t, normalID)
	assertActionSet(t, createdSnapshot.Task.AvailableActions, "assign", "cancel")

	runWhipCLI(t, "task", "assign", normalID)
	runWhipCLI(t, "task", "start", normalID, "--note", "Started from integration test")
	runWhipCLI(t, "task", "note", normalID, "Progress note from integration test")
	runWhipCLI(t, "workspace", "broadcast", workspace, "Broadcast to active task")
	runWhipCLI(t, "task", "complete", normalID, "--note", "Completed from integration test")

	normalTask, err := h.store.LoadTask(normalID)
	if err != nil {
		t.Fatalf("LoadTask normal: %v", err)
	}
	if normalTask.Status != whiplib.StatusCompleted {
		t.Fatalf("normal status = %s, want %s", normalTask.Status, whiplib.StatusCompleted)
	}
	if len(normalTask.Notes) != 3 {
		t.Fatalf("normal notes count = %d, want 3", len(normalTask.Notes))
	}

	runWhipCLI(t, "task", "assign", failingID)
	runWhipCLI(t, "task", "start", failingID, "--note", "Failing task started")
	runWhipCLI(t, "task", "fail", failingID, "--note", "handoff after failure")

	failedTask, err := h.store.LoadTask(failingID)
	if err != nil {
		t.Fatalf("LoadTask failed: %v", err)
	}
	if failedTask.Status != whiplib.StatusFailed {
		t.Fatalf("failed status = %s, want %s", failedTask.Status, whiplib.StatusFailed)
	}
	if failedTask.Runner != "" || failedTask.IRCName != "" || failedTask.ShellPID != 0 {
		t.Fatalf("failed task runtime should be cleared: runner=%q irc=%q pid=%d", failedTask.Runner, failedTask.IRCName, failedTask.ShellPID)
	}
	previousSessionID := failedTask.SessionID
	if previousSessionID == "" {
		t.Fatalf("failed task should preserve the last session id")
	}

	runWhipCLI(t, "task", "assign", failingID)
	reassignedTask, err := h.store.LoadTask(failingID)
	if err != nil {
		t.Fatalf("LoadTask reassigned: %v", err)
	}
	if reassignedTask.Status != whiplib.StatusAssigned {
		t.Fatalf("reassigned status = %s, want %s", reassignedTask.Status, whiplib.StatusAssigned)
	}
	if reassignedTask.SessionID == previousSessionID {
		t.Fatalf("reassigned task should overwrite the previous session id")
	}
	runWhipCLI(t, "task", "cancel", failingID, "--note", "Canceled after reassignment")

	canceledTask, err := h.store.LoadTask(failingID)
	if err != nil {
		t.Fatalf("LoadTask canceled: %v", err)
	}
	if canceledTask.Status != whiplib.StatusCanceled {
		t.Fatalf("canceled status = %s, want %s", canceledTask.Status, whiplib.StatusCanceled)
	}
	if canceledTask.Runner != "" || canceledTask.IRCName != "" || canceledTask.ShellPID != 0 {
		t.Fatalf("canceled task runtime should be cleared: runner=%q irc=%q pid=%d", canceledTask.Runner, canceledTask.IRCName, canceledTask.ShellPID)
	}
	if canceledTask.SessionID == "" {
		t.Fatalf("canceled task should preserve the last session id")
	}
	if canceledTask.SessionID != reassignedTask.SessionID {
		t.Fatalf("canceled task should keep the last assigned session id: got %q want %q", canceledTask.SessionID, reassignedTask.SessionID)
	}

	ircLog := readIRCLog(t, h.fake.ircLogPath)
	if !strings.Contains(ircLog, "msg target=wp-"+normalID+" text=Broadcast to active task") {
		t.Fatalf("broadcast log missing normal task message:\n%s", ircLog)
	}

	runWhipCLI(t, "task", "clean")
	assertNoTasksRemain(t, h.store, workspace)
}

func TestWhipStartReviewFlowRegression(t *testing.T) {
	h := newSkillFlowHarness(t)
	const workspace = "skills-review"

	reviewID := createWhipTask(t,
		"task", "create", "Review task",
		"--workspace", workspace,
		"--cwd", h.workspaceDir,
		"--backend", "claude",
		"--difficulty", "medium",
		"--review",
		"--desc", "Review-gated lifecycle flow",
	)

	assertWorkspaceView(t, workspace, "direct-cwd")

	createdSnapshot := readLifecycleSnapshot(t, reviewID)
	assertActionSet(t, createdSnapshot.Task.AvailableActions, "assign", "cancel")

	runWhipCLI(t, "task", "assign", reviewID)
	runWhipCLI(t, "task", "start", reviewID, "--note", "Review task started")

	inProgressSnapshot := readLifecycleSnapshot(t, reviewID)
	assertActionSet(t, inProgressSnapshot.Task.AvailableActions, "review", "fail", "cancel")

	_, _, err := execWhipCLICapture(t, "task", "complete", reviewID, "--note", "Should be blocked before review")
	if err == nil || !strings.Contains(err.Error(), "requires review") {
		t.Fatalf("review task complete error = %v, want requires review", err)
	}

	runWhipCLI(t, "task", "review", reviewID, "--note", "Ready for review")
	reviewSnapshot := readLifecycleSnapshot(t, reviewID)
	assertActionSet(t, reviewSnapshot.Task.AvailableActions, "request-changes", "approve", "fail", "cancel")

	runWhipCLI(t, "task", "request-changes", reviewID, "--note", "Address review feedback before approval")
	reworkSnapshot := readLifecycleSnapshot(t, reviewID)
	assertActionSet(t, reworkSnapshot.Task.AvailableActions, "review", "fail", "cancel")

	runWhipCLI(t, "task", "note", reviewID, "Rework in progress after review feedback")
	runWhipCLI(t, "task", "review", reviewID, "--note", "Ready for re-review")
	runWhipCLI(t, "task", "approve", reviewID, "--note", "Approved by integration test")
	runWhipCLI(t, "task", "complete", reviewID, "--note", "Completed after approval")

	reviewTask, err := h.store.LoadTask(reviewID)
	if err != nil {
		t.Fatalf("LoadTask review: %v", err)
	}
	if reviewTask.Status != whiplib.StatusCompleted {
		t.Fatalf("review status = %s, want %s", reviewTask.Status, whiplib.StatusCompleted)
	}
	if len(reviewTask.Notes) != 7 {
		t.Fatalf("review notes count = %d, want 7", len(reviewTask.Notes))
	}

	ircLog := readIRCLog(t, h.fake.ircLogPath)
	if !strings.Contains(ircLog, "msg target=wp-"+reviewID+" text=Task "+reviewID+" needs changes.") {
		t.Fatalf("request-changes log missing review notification:\n%s", ircLog)
	}
	if !strings.Contains(ircLog, "msg target=wp-"+reviewID+" text=Task "+reviewID+" approved.") {
		t.Fatalf("approval log missing review notification:\n%s", ircLog)
	}

	runWhipCLI(t, "task", "clean")
	assertNoTasksRemain(t, h.store, workspace)
}

func TestWhipPlanCommandSurfaceRegression(t *testing.T) {
	taskHelp, _, err := execWhipCLICapture(t, "task", "--help")
	if err != nil {
		t.Fatalf("task --help: %v", err)
	}
	for _, expected := range []string{
		"Lifecycle Commands",
		"assign",
		"start",
		"review",
		"request-changes",
		"approve",
		"complete",
		"fail",
		"cancel",
		"view",
		"lifecycle",
		"note",
	} {
		if !strings.Contains(taskHelp, expected) {
			t.Fatalf("task --help missing %q:\n%s", expected, taskHelp)
		}
	}
	for _, removed := range []string{"show", "status", "retry", "resume", "unassign", "kill", "attach"} {
		if helpListsCommand(taskHelp, removed) {
			t.Fatalf("task --help should not mention %q:\n%s", removed, taskHelp)
		}
	}

	workspaceHelp, _, err := execWhipCLICapture(t, "workspace", "--help")
	if err != nil {
		t.Fatalf("workspace --help: %v", err)
	}
	for _, expected := range []string{"broadcast", "view", "drop"} {
		if !strings.Contains(workspaceHelp, expected) {
			t.Fatalf("workspace --help missing %q:\n%s", expected, workspaceHelp)
		}
	}
	if helpListsCommand(workspaceHelp, "show") {
		t.Fatalf("workspace --help should not mention show:\n%s", workspaceHelp)
	}

	approveHelp, _, err := execWhipCLICapture(t, "task", "approve", "--help")
	if err != nil {
		t.Fatalf("task approve --help: %v", err)
	}
	if !strings.Contains(approveHelp, "review -> approved") {
		t.Fatalf("approve help missing transition:\n%s", approveHelp)
	}
	if !strings.Contains(approveHelp, "notifies the assignee over IRC when possible") {
		t.Fatalf("approve help missing side effect:\n%s", approveHelp)
	}

	requestChangesHelp, _, err := execWhipCLICapture(t, "task", "request-changes", "--help")
	if err != nil {
		t.Fatalf("task request-changes --help: %v", err)
	}
	if !strings.Contains(requestChangesHelp, "review -> in_progress") {
		t.Fatalf("request-changes help missing transition:\n%s", requestChangesHelp)
	}
	if !strings.Contains(requestChangesHelp, "notifies the assignee over IRC when possible") {
		t.Fatalf("request-changes help missing side effect:\n%s", requestChangesHelp)
	}
}

type fakeSkillFlowTools struct {
	ircLogPath string
}

type skillFlowHarness struct {
	store        *whiplib.Store
	workspaceDir string
	fake         fakeSkillFlowTools
}

func installFakeSkillFlowTools(t *testing.T) fakeSkillFlowTools {
	t.Helper()

	toolDir := filepath.Join(t.TempDir(), "bin")
	stateDir := filepath.Join(t.TempDir(), "state")
	tmuxStateDir := filepath.Join(stateDir, "tmux")
	if err := os.MkdirAll(toolDir, 0o755); err != nil {
		t.Fatalf("MkdirAll toolDir: %v", err)
	}
	if err := os.MkdirAll(tmuxStateDir, 0o755); err != nil {
		t.Fatalf("MkdirAll tmuxStateDir: %v", err)
	}

	ircLogPath := filepath.Join(stateDir, "irc.log")
	t.Setenv("WHIP_TEST_STATE_DIR", stateDir)
	t.Setenv("PATH", toolDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	writeExecutable(t, filepath.Join(toolDir, "tmux"), `#!/bin/sh
set -eu
STATE_DIR="${WHIP_TEST_STATE_DIR:?}/tmux"
cmd="${1:-}"
[ $# -gt 0 ] && shift || true
case "$cmd" in
  new-session)
    name=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -s)
          name="$2"
          shift 2
          ;;
        *)
          shift
          ;;
      esac
    done
    [ -n "$name" ] || exit 1
    : > "$STATE_DIR/$name"
    ;;
  has-session)
    [ "${1:-}" = "-t" ] || exit 1
    [ -f "$STATE_DIR/$2" ]
    ;;
  kill-session)
    [ "${1:-}" = "-t" ] || exit 1
    rm -f "$STATE_DIR/$2"
    ;;
  capture-pane|attach)
    exit 0
    ;;
  *)
    exit 0
    ;;
esac
`)

	writeExecutable(t, filepath.Join(toolDir, "claude-irc"), `#!/bin/sh
set -eu
LOG="${WHIP_TEST_STATE_DIR:?}/irc.log"
cmd="${1:-}"
[ $# -gt 0 ] && shift || true
case "$cmd" in
  msg)
    target="${1:-}"
    shift || true
    printf 'msg target=%s text=%s\n' "$target" "$*" >> "$LOG"
    ;;
  clean|join|quit|who|inbox|broadcast|upgrade)
    :
    ;;
  *)
    :
    ;;
esac
`)

	return fakeSkillFlowTools{ircLogPath: ircLogPath}
}

func newSkillFlowHarness(t *testing.T) skillFlowHarness {
	t.Helper()

	store := tempWhipStore(t)
	workspaceDir := canonicalTestPath(t, t.TempDir())
	fake := installFakeSkillFlowTools(t)
	t.Setenv("WHIP_SHELL_PID", "424242")

	return skillFlowHarness{
		store:        store,
		workspaceDir: workspaceDir,
		fake:         fake,
	}
}

func writeExecutable(t *testing.T, path string, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("WriteFile %s: %v", path, err)
	}
}

func createWhipTask(t *testing.T, args ...string) string {
	t.Helper()
	stdout, _, err := execWhipCLICapture(t, args...)
	if err != nil {
		t.Fatalf("create task %s: %v", strings.Join(args, " "), err)
	}
	id := strings.TrimSpace(stdout)
	if id == "" {
		t.Fatalf("create task %s returned empty id", strings.Join(args, " "))
	}
	return id
}

func execWhipCLICapture(t *testing.T, args ...string) (stdout string, stderr string, err error) {
	t.Helper()

	oldStdout := os.Stdout
	oldStderr := os.Stderr
	defer func() {
		os.Stdout = oldStdout
		os.Stderr = oldStderr
	}()

	stdoutReader, stdoutWriter, pipeErr := os.Pipe()
	if pipeErr != nil {
		t.Fatalf("Pipe stdout: %v", pipeErr)
	}
	stderrReader, stderrWriter, pipeErr := os.Pipe()
	if pipeErr != nil {
		t.Fatalf("Pipe stderr: %v", pipeErr)
	}

	os.Stdout = stdoutWriter
	os.Stderr = stderrWriter

	root := newRootCmd()
	root.SetOut(stdoutWriter)
	root.SetErr(stderrWriter)
	root.SetArgs(args)
	err = root.Execute()

	_ = stdoutWriter.Close()
	_ = stderrWriter.Close()

	stdoutBytes, readErr := io.ReadAll(stdoutReader)
	if readErr != nil {
		t.Fatalf("ReadAll stdout: %v", readErr)
	}
	stderrBytes, readErr := io.ReadAll(stderrReader)
	if readErr != nil {
		t.Fatalf("ReadAll stderr: %v", readErr)
	}

	return string(stdoutBytes), string(stderrBytes), err
}

type lifecycleSnapshot struct {
	Task struct {
		ID               string `json:"id"`
		Status           string `json:"status"`
		AvailableActions []struct {
			Name string `json:"name"`
		} `json:"available_actions"`
	} `json:"task"`
}

func readLifecycleSnapshot(t *testing.T, taskID string) lifecycleSnapshot {
	t.Helper()

	stdout, _, err := execWhipCLICapture(t, "task", "lifecycle", taskID, "--format", "json")
	if err != nil {
		t.Fatalf("task lifecycle %s: %v", taskID, err)
	}

	var snapshot lifecycleSnapshot
	if err := json.Unmarshal([]byte(stdout), &snapshot); err != nil {
		t.Fatalf("Unmarshal lifecycle snapshot: %v\n%s", err, stdout)
	}
	return snapshot
}

func readIRCLog(t *testing.T, path string) string {
	t.Helper()

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile irc log: %v", err)
	}
	return string(data)
}

func assertWorkspaceView(t *testing.T, workspace string, executionModel string) {
	t.Helper()

	workspaceView, _, err := execWhipCLICapture(t, "workspace", "view", workspace)
	if err != nil {
		t.Fatalf("workspace view: %v", err)
	}
	if !strings.Contains(workspaceView, "Name:             "+workspace) {
		t.Fatalf("workspace view missing workspace name:\n%s", workspaceView)
	}
	if !strings.Contains(workspaceView, "Execution model:  "+executionModel) {
		t.Fatalf("workspace view missing execution model %q:\n%s", executionModel, workspaceView)
	}
}

func assertNoTasksRemain(t *testing.T, store *whiplib.Store, workspace string) {
	t.Helper()

	tasks, err := store.ListTasks()
	if err != nil {
		t.Fatalf("ListTasks after clean: %v", err)
	}
	if len(tasks) != 0 {
		t.Fatalf("ListTasks after clean = %d, want 0", len(tasks))
	}

	workspaceAfterClean, _, err := execWhipCLICapture(t, "workspace", "view", workspace)
	if err != nil {
		t.Fatalf("workspace view after clean: %v", err)
	}
	if !strings.Contains(workspaceAfterClean, "Tasks:            none") {
		t.Fatalf("workspace view after clean should report no tasks:\n%s", workspaceAfterClean)
	}
}

func assertActionSet(t *testing.T, actions []struct {
	Name string `json:"name"`
}, want ...string) {
	t.Helper()

	got := make([]string, 0, len(actions))
	for _, action := range actions {
		got = append(got, action.Name)
	}
	slices.Sort(got)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("available actions = %v, want %v", got, want)
	}
}

func helpListsCommand(helpText string, name string) bool {
	pattern := regexp.MustCompile(`(?m)^  ` + regexp.QuoteMeta(name) + `\s`)
	return pattern.FindStringIndex(helpText) != nil
}
