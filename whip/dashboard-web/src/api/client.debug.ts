import type { Message, Peer, Task } from './types'
import type { WhipClient } from './client'

type MockInbox = Record<string, Message[]>

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError')
  }
}

function ts(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString()
}

function createMockTasks(): Task[] {
  return [
    {
      id: 'c0a91',
      title: 'Design event schema',
      description: 'Define the shared analytics contract for ingestion and replay.',
      cwd: '/workspace/search-platform',
      workspace: 'global',
      status: 'completed',
      backend: 'claude',
      runner: 'tmux',
      irc_name: 'whip-c0a91',
      master_irc_name: 'whip-master',
      session_id: 'sess-global-c0a91',
      shell_pid: 1001,
      pid_alive: false,
      note: 'Schema landed and review comments resolved.',
      difficulty: 'medium',
      review: false,
      depends_on: [],
      created_at: ts(240),
      updated_at: ts(125),
      assigned_at: ts(230),
      completed_at: ts(125),
    },
    {
      id: '7b2d4',
      title: 'Replay analyzer',
      description: 'Instrument the replay parser and compare live vs stored ranking output.',
      cwd: '/workspace/search-platform',
      workspace: 'incident-replay',
      status: 'review',
      backend: 'claude',
      runner: 'tmux',
      irc_name: 'whip-7b2d4',
      master_irc_name: 'whip-master-incident-replay',
      session_id: 'sess-replay-7b2d4',
      shell_pid: 1207,
      pid_alive: true,
      note: 'Replay diff is ready. Waiting on AI companion agent review.',
      difficulty: 'hard',
      review: true,
      depends_on: [],
      created_at: ts(130),
      updated_at: ts(4),
      assigned_at: ts(120),
      completed_at: null,
    },
    {
      id: '91fd2',
      title: 'CJK tokenizer spike',
      description: 'Evaluate tokenizer options for mixed CJK queries and wire the winning path.',
      cwd: '/workspace/search-platform',
      workspace: 'incident-replay',
      status: 'in_progress',
      backend: 'codex',
      runner: 'tmux',
      irc_name: 'whip-91fd2',
      master_irc_name: 'whip-master-incident-replay',
      session_id: 'sess-replay-91fd2',
      shell_pid: 1219,
      pid_alive: true,
      note: 'Comparing Sudachi vs unigram segmentation on replay samples.',
      difficulty: 'hard',
      review: false,
      depends_on: ['7b2d4'],
      created_at: ts(128),
      updated_at: ts(2),
      assigned_at: ts(118),
      completed_at: null,
    },
    {
      id: 'ab331',
      title: 'Dashboard copy + edge-case callouts',
      description: 'Refine the ops view once replay analyzer behavior is approved.',
      cwd: '/workspace/search-platform',
      workspace: 'incident-replay',
      status: 'created',
      backend: 'claude',
      runner: '',
      irc_name: '',
      master_irc_name: 'whip-master-incident-replay',
      session_id: '',
      shell_pid: 0,
      pid_alive: false,
      note: 'Queued behind replay + tokenizer validation.',
      difficulty: 'medium',
      review: false,
      depends_on: ['7b2d4', '91fd2'],
      created_at: ts(110),
      updated_at: ts(30),
      assigned_at: null,
      completed_at: null,
    },
    {
      id: 'd44ef',
      title: 'Rollout checklist',
      description: 'Prepare runbook, smoke checks, and rollback checklist for the lane.',
      cwd: '/workspace/search-platform',
      workspace: 'incident-replay',
      status: 'approved_pending_finalize',
      backend: 'claude',
      runner: 'tmux',
      irc_name: 'whip-d44ef',
      master_irc_name: 'whip-master-incident-replay',
      session_id: 'sess-replay-d44ef',
      shell_pid: 1320,
      pid_alive: true,
      note: 'Approved. Waiting for final commit and closeout note.',
      difficulty: 'easy',
      review: true,
      depends_on: ['ab331'],
      created_at: ts(90),
      updated_at: ts(1),
      assigned_at: ts(80),
      completed_at: null,
    },
  ]
}

function createMockPeers(): Peer[] {
  return [
    { name: 'ai-companion-agent', online: true, cwd: '/workspace/search-platform', registered_at: ts(140) },
    { name: 'whip-7b2d4', online: true, cwd: '/workspace/search-platform', registered_at: ts(118) },
    { name: 'whip-91fd2', online: true, cwd: '/workspace/search-platform', registered_at: ts(117) },
    { name: 'whip-d44ef', online: true, cwd: '/workspace/search-platform', registered_at: ts(80) },
  ]
}

function createMockInbox(): MockInbox {
  return {
    user: [
      {
        from: 'ai-companion-agent',
        content: 'Plan locked. I split the replay investigation into analyzer, tokenizer, and rollout lanes.',
        timestamp: ts(18),
        read: true,
      },
      {
        from: 'whip-7b2d4',
        content: 'Replay analyzer is ready for review. Diff screenshots and failing samples are attached in the task note.',
        timestamp: ts(6),
        read: false,
      },
      {
        from: 'whip-91fd2',
        content: 'Tokenizer benchmark is still running. Sudachi is winning on mixed CJK queries so far.',
        timestamp: ts(3),
        read: false,
      },
    ],
  }
}

function initialMockCapture(): string {
  return [
    '╭─ whip-master-incident-replay ───────────────────────────────────────────────╮',
    '│ AI companion agent is orchestrating the replay lane                         │',
    '╰──────────────────────────────────────────────────────────────────────────────╯',
    '',
    '$ whip task create "Replay analyzer" --workspace incident-replay',
    '$ whip task create "CJK tokenizer spike" --workspace incident-replay',
    '$ whip task dep 91fd2 --after 7b2d4',
    '$ whip task assign 7b2d4',
    '$ claude-irc msg whip-91fd2 "Stand by until replay diff is approved."',
    '',
    '[review] replay analyzer ready',
    '  - edge case: multi-word queries on CJK content need tokenizer follow-up',
    '  - next: approve replay lane, then route tokenizer lane',
    '',
    '$ whip task approve 7b2d4',
  ].join('\n')
}

export class MockWhipClient implements WhipClient {
  private tasks = createMockTasks()
  private peers = createMockPeers()
  private inbox = createMockInbox()
  private capture = initialMockCapture()
  private commandCount = 0

  async getPeers(signal?: AbortSignal): Promise<Peer[]> {
    assertNotAborted(signal)
    return this.peers
  }

  async sendMessage(to: string, content: string): Promise<void> {
    const now = new Date().toISOString()
    const reply = mockReplyForPeer(to, content)
    this.inbox.user = [
      ...(this.inbox.user ?? []),
      {
        from: to,
        content: reply,
        timestamp: now,
        read: false,
      },
    ]
  }

  async getInbox(name: string, _all?: boolean, signal?: AbortSignal): Promise<Message[]> {
    assertNotAborted(signal)
    return [...(this.inbox[name] ?? [])].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  }

  async markRead(name: string): Promise<void> {
    this.inbox[name] = (this.inbox[name] ?? []).map(msg => ({ ...msg, read: true }))
  }

  async clearInbox(name: string): Promise<void> {
    this.inbox[name] = []
  }

  async getMasterCapture(): Promise<{ content: string }> {
    return { content: this.capture }
  }

  async sendMasterKeys(keys: string): Promise<void> {
    const command = keys.trim()
    if (!command) return
    this.commandCount += 1
    const response = mockTerminalReply(command, this.commandCount)
    this.capture = [this.capture, `$ ${command}`, response].join('\n')
  }

  async getMasterStatus(): Promise<{ session: string; alive: boolean }> {
    return { session: 'whip-master-dev', alive: true }
  }

  async getTasks(signal?: AbortSignal): Promise<Task[]> {
    assertNotAborted(signal)
    return this.tasks
  }

  async getTask(id: string): Promise<Task> {
    const task = this.tasks.find(item => item.id === id)
    if (!task) {
      throw new Error(`Task ${id} not found`)
    }
    return task
  }

  async ping(): Promise<boolean> {
    return true
  }
}

function mockReplyForPeer(to: string, content: string): string {
  if (to === 'ai-companion-agent') {
    return `Acknowledged. I routed that into the active stack: "${content}".`
  }
  return `Received. I will fold "${content}" into the current task note.`
}

function mockTerminalReply(command: string, commandCount: number): string {
  if (commandCount === 1) {
    return '[plan] companion agent re-ran the lane summary and refreshed the task board.'
  }
  if (command.toLowerCase().includes('approve')) {
    return '[review] approval recorded. Finalize step is ready on the companion lane.'
  }
  return '[dispatch] mock terminal accepted the command and updated the run preview.'
}
