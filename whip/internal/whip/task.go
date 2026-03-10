package whip

import "time"

const TaskRoleLead = "lead"

type Note struct {
	Timestamp time.Time `json:"timestamp"`
	Status    string    `json:"status"`
	Content   string    `json:"content"`
}

type TaskEvent struct {
	Timestamp  time.Time `json:"timestamp"`
	Actor      string    `json:"actor"`
	Command    string    `json:"command"`
	Action     string    `json:"action"`
	FromStatus string    `json:"from_status,omitempty"`
	ToStatus   string    `json:"to_status,omitempty"`
	Detail     string    `json:"detail,omitempty"`
}

type Task struct {
	ID            string      `json:"id"`
	Title         string      `json:"title"`
	Description   string      `json:"description"`
	CWD           string      `json:"cwd"`
	Workspace     string      `json:"workspace,omitempty"`
	Status        TaskStatus  `json:"status"`
	Backend       string      `json:"backend,omitempty"`
	Runner        string      `json:"runner,omitempty"`
	IRCName       string      `json:"irc_name"`
	MasterIRCName string      `json:"master_irc_name"`
	SessionID     string      `json:"session_id,omitempty"`
	ShellPID      int         `json:"shell_pid"`
	Note          string      `json:"note"`
	Notes         []Note      `json:"notes,omitempty"`
	Difficulty    string      `json:"difficulty,omitempty"`
	Review        bool        `json:"review,omitempty"`
	Role          string      `json:"role,omitempty"`
	DependsOn     []string    `json:"depends_on"`
	CreatedAt     time.Time   `json:"created_at"`
	UpdatedAt     time.Time   `json:"updated_at"`
	AssignedAt    *time.Time  `json:"assigned_at"`
	HeartbeatAt   *time.Time  `json:"heartbeat_at,omitempty"`
	CompletedAt   *time.Time  `json:"completed_at"`
	Events        []TaskEvent `json:"events,omitempty"`
}

func NewTask(title, description, cwd string) *Task {
	now := time.Now()
	return &Task{
		ID:          generateID(),
		Title:       title,
		Description: description,
		CWD:         cwd,
		Workspace:   GlobalWorkspaceName,
		Status:      StatusCreated,
		DependsOn:   []string{},
		CreatedAt:   now,
		UpdatedAt:   now,
	}
}

func (t *Task) IsLead() bool {
	return t.Role == TaskRoleLead
}

func (t *Task) WorkspaceName() string {
	return NormalizeWorkspaceName(t.Workspace)
}
