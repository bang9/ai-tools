import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'

type NoteTone = 'operator' | 'companion' | 'system'
type LaneTone = 'planned' | 'active' | 'review' | 'done'

interface Note {
  label: string
  text: string
  tone: NoteTone
}

interface Lane {
  title: string
  status: string
  tone: LaneTone
}

interface PreviewStep {
  id: string
  label: string
  summary: string
  command: string
  dialogue: Note[]
  companionStatus: string
  lanes: Lane[]
  insight: string
}

const steps: PreviewStep[] = [
  {
    id: 'plan',
    label: 'Plan',
    summary: 'You describe the goal. The AI companion agent shapes it into a stacked run.',
    command: 'whip task create "Incident replay workflow" --difficulty hard --review',
    dialogue: [
      {
        label: 'You',
        text: 'Ship incident replay for the support console without derailing the current branch.',
        tone: 'operator',
      },
      {
        label: 'Companion',
        text: 'I will shape this into a stacked run: shared event contract, replay API, timeline UI, and rollout review.',
        tone: 'companion',
      },
    ],
    companionStatus: 'Shaping the run',
    lanes: [
      { title: 'Event contract', status: 'planned', tone: 'planned' },
      { title: 'Replay API', status: 'planned', tone: 'planned' },
      { title: 'Timeline UI', status: 'blocked', tone: 'planned' },
      { title: 'Rollout review', status: 'planned', tone: 'planned' },
    ],
    insight: 'The run starts with a human-companion planning pass, not blind parallelism.',
  },
  {
    id: 'assign',
    label: 'Assign',
    summary: 'The companion agent dispatches sub agents where it is safe to fan out.',
    command: 'whip task assign api-lane && whip task assign contract-lane',
    dialogue: [
      {
        label: 'You',
        text: 'Looks right. Dispatch what can start now and keep the rest queued behind the contract.',
        tone: 'operator',
      },
      {
        label: 'Companion',
        text: 'Assigning the contract and API lanes first. Timeline UI will wait until the shared event shape is real.',
        tone: 'companion',
      },
    ],
    companionStatus: 'Dispatching sub agents',
    lanes: [
      { title: 'Event contract', status: 'in progress', tone: 'active' },
      { title: 'Replay API', status: 'in progress', tone: 'active' },
      { title: 'Timeline UI', status: 'waiting', tone: 'planned' },
      { title: 'Rollout review', status: 'queued', tone: 'planned' },
    ],
    insight: 'Sub agents execute, but the companion agent still owns routing and sequencing.',
  },
  {
    id: 'review',
    label: 'Review',
    summary: 'The companion agent escalates only the decisions that need a human.',
    command: 'whip task approve contract-lane && whip task status export-lane review',
    dialogue: [
      {
        label: 'Companion',
        text: 'The shared contract is stable. I am escalating the export lane because the format drift needs a human decision.',
        tone: 'companion',
      },
      {
        label: 'You',
        text: 'Approve the contract. Send the export lane back for one revision and keep the rest moving.',
        tone: 'operator',
      },
    ],
    companionStatus: 'Reviewing critical moment',
    lanes: [
      { title: 'Event contract', status: 'approved', tone: 'done' },
      { title: 'Replay API', status: 'review', tone: 'review' },
      { title: 'Timeline UI', status: 'in progress', tone: 'active' },
      { title: 'Rollout review', status: 'queued', tone: 'planned' },
    ],
    insight: 'The human reviews the inflection point. The companion agent handles the rest.',
  },
  {
    id: 'complete',
    label: 'Complete',
    summary: 'All lanes converge. The companion agent closes the run cleanly.',
    command: 'whip task status replay-run completed --note "stack merged cleanly"',
    dialogue: [
      {
        label: 'Companion',
        text: 'All lanes are closed. The stack merged cleanly and the final state is ready to hand back.',
        tone: 'companion',
      },
      {
        label: 'You',
        text: 'Ship it. Close the run and move on.',
        tone: 'operator',
      },
    ],
    companionStatus: 'Run complete',
    lanes: [
      { title: 'Event contract', status: 'done', tone: 'done' },
      { title: 'Replay API', status: 'done', tone: 'done' },
      { title: 'Timeline UI', status: 'done', tone: 'done' },
      { title: 'Rollout review', status: 'done', tone: 'done' },
    ],
    insight: 'A good run ends with merged work, clear state, and no dangling lanes.',
  },
]

function dialogueBubbleClass(tone: NoteTone) {
  if (tone === 'operator')
    return 'bg-[linear-gradient(135deg,rgba(186,230,253,0.35),rgba(224,242,254,0.20))] shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_2px_8px_rgba(56,189,248,0.06)] dark:bg-sky-400/8 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]'
  if (tone === 'companion')
    return 'bg-[linear-gradient(135deg,rgba(221,214,254,0.35),rgba(237,233,254,0.20))] shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_2px_8px_rgba(139,92,246,0.06)] dark:bg-violet-400/8 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]'
  return 'bg-white/30 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] dark:bg-white/[0.03] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
}

function laneToneClass(tone: LaneTone) {
  switch (tone) {
    case 'done':
      return 'bg-[linear-gradient(135deg,rgba(167,243,208,0.45),rgba(209,250,229,0.25))] text-emerald-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.6),0_2px_6px_rgba(52,211,153,0.08)] dark:bg-emerald-400/10 dark:text-emerald-200 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]'
    case 'review':
      return 'bg-[linear-gradient(135deg,rgba(221,214,254,0.45),rgba(237,233,254,0.25))] text-violet-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.6),0_2px_6px_rgba(139,92,246,0.08)] dark:bg-violet-400/10 dark:text-violet-200 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]'
    case 'active':
      return 'bg-[linear-gradient(135deg,rgba(186,230,253,0.45),rgba(224,242,254,0.25))] text-sky-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.6),0_2px_6px_rgba(56,189,248,0.08)] dark:bg-sky-400/10 dark:text-sky-200 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]'
    default:
      return 'bg-white/30 text-[#4b5975] shadow-[inset_0_1px_0_rgba(255,255,255,0.5),0_2px_6px_rgba(76,94,160,0.04)] dark:bg-white/[0.04] dark:text-[#8494b8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
  }
}

function laneDot(tone: LaneTone) {
  switch (tone) {
    case 'done':
      return 'bg-emerald-500 dark:bg-emerald-400'
    case 'review':
      return 'bg-violet-500 dark:bg-violet-400'
    case 'active':
      return 'bg-sky-500 dark:bg-sky-400 animate-pulse'
    default:
      return 'bg-[#b0bdd4] dark:bg-[#4a5b7a]'
  }
}

export function HeroRunPreview() {
  const [index, setIndex] = useState(0)
  const step = steps[index]

  useEffect(() => {
    const id = window.setInterval(() => {
      setIndex(current => (current + 1) % steps.length)
    }, 9800)
    return () => window.clearInterval(id)
  }, [])

  return (
    <div>
      {/* Floating step controls */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.24em] text-[#6b7280] dark:text-white/40">
          live run
        </span>
        <div className="flex flex-wrap gap-2">
          {steps.map((item, itemIndex) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setIndex(itemIndex)}
              className={`rounded-full px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] transition-all ${
                itemIndex === index
                  ? 'bg-[linear-gradient(135deg,#4f46e5,#8b5cf6)] text-white shadow-[0_0_24px_rgba(99,102,241,0.30)]'
                  : 'bg-white/40 text-[#667085] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_2px_8px_rgba(76,94,160,0.06)] backdrop-blur-[12px] backdrop-saturate-[1.4] hover:bg-white/60 dark:bg-white/6 dark:text-white/48 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] dark:hover:bg-white/10'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Liquid glass run surface */}
      <div className="overflow-hidden rounded-[2rem] bg-white/35 shadow-[inset_0_1.5px_0_rgba(255,255,255,0.95),inset_0_-0.5px_0_rgba(255,255,255,0.3),0_24px_80px_rgba(76,94,160,0.10),0_8px_24px_rgba(76,94,160,0.06)] backdrop-blur-[24px] backdrop-saturate-[1.8] dark:bg-[#111827]/90 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_26px_80px_rgba(10,20,40,0.40)] dark:backdrop-blur-[20px] dark:backdrop-saturate-100">
        {/* Title bar */}
        <div className="flex items-center justify-between bg-[linear-gradient(180deg,rgba(255,255,255,0.40),rgba(255,255,255,0.15))] px-5 py-3 dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01))]">
          <div className="text-[11px] uppercase tracking-[0.2em] text-[#94a3b8] dark:text-[#6878a0]">
            whip dashboard
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-[#3b82f6]/50" />
            <span className="h-2 w-2 rounded-full bg-[#818cf8]/50" />
            <span className="h-2 w-2 rounded-full bg-[#c084fc]/50" />
          </div>
        </div>

        {/* Phase summary banner */}
        <AnimatePresence mode="wait">
          <motion.div
            key={`${step.id}-summary`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="bg-[linear-gradient(180deg,rgba(255,255,255,0.22),rgba(255,255,255,0.08))] px-5 py-3 shadow-[inset_0_-0.5px_0_rgba(255,255,255,0.2)] dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0.01))] dark:shadow-[inset_0_-0.5px_0_rgba(255,255,255,0.04)] sm:px-6"
          >
            <div className="flex items-center gap-3">
              <span className="inline-flex h-7 items-center rounded-full bg-[linear-gradient(135deg,#4f46e5,#8b5cf6)] px-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-white shadow-[0_4px_12px_rgba(79,70,229,0.25)]">
                {step.label}
              </span>
              <span className="text-sm text-[#334155] dark:text-[#c4d5ff]">{step.summary}</span>
            </div>
          </motion.div>
        </AnimatePresence>

        {/* Two-column content: Dialogue + Graph */}
        <div className="grid gap-0 lg:grid-cols-2">
          {/* Left: Dialogue */}
          <div className="shadow-[inset_0_-1px_0_rgba(255,255,255,0.2)] dark:shadow-[inset_0_-1px_0_rgba(255,255,255,0.04)] lg:shadow-[inset_-1px_0_0_rgba(255,255,255,0.2)] lg:dark:shadow-[inset_-1px_0_0_rgba(255,255,255,0.04)]">
            <div className="px-5 py-5 sm:px-6 lg:min-h-[22rem]">
              <div className="mb-4 text-[11px] uppercase tracking-[0.18em] text-[#94a3b8] dark:text-[#6878a0]">
                Conversation
              </div>

              <AnimatePresence mode="wait">
                <motion.div
                  key={`${step.id}-dialogue`}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
                  className="space-y-3"
                >
                  {step.dialogue.map(note => (
                    <div key={`${step.id}-${note.label}-${note.tone}`} className={`rounded-2xl px-4 py-3 backdrop-blur-[12px] backdrop-saturate-[1.4] ${dialogueBubbleClass(note.tone)}`}>
                      <div className="mb-1 flex items-center gap-2">
                        <span className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold ${note.tone === 'operator' ? 'bg-sky-100/80 text-sky-600 dark:bg-sky-400/20 dark:text-sky-300' : 'bg-violet-100/80 text-violet-600 dark:bg-violet-400/20 dark:text-violet-300'}`}>
                          {note.tone === 'operator' ? 'Y' : 'AI'}
                        </span>
                        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#667085] dark:text-white/60">{note.label}</span>
                      </div>
                      <p className="text-[13px] leading-6 text-[#334155] dark:text-white/85">{note.text}</p>
                    </div>
                  ))}
                </motion.div>
              </AnimatePresence>
            </div>
          </div>

          {/* Right: Companion graph with lanes */}
          <div className="px-5 py-5 sm:px-6 lg:min-h-[22rem]">
            <div className="mb-4 text-[11px] uppercase tracking-[0.18em] text-[#94a3b8] dark:text-[#6878a0]">
              Task graph
            </div>

            <AnimatePresence mode="wait">
              <motion.div
                key={`${step.id}-graph`}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
              >
                {/* Companion agent status */}
                <div className="mb-4 rounded-2xl bg-[linear-gradient(135deg,rgba(196,181,253,0.30),rgba(221,214,254,0.15))] px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.6),0_4px_16px_rgba(139,92,246,0.08)] backdrop-blur-[12px] backdrop-saturate-[1.4] dark:bg-[linear-gradient(135deg,rgba(79,70,229,0.14),rgba(139,92,246,0.10))] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                  <div className="flex items-center gap-2">
                    <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-violet-100/80 text-[9px] font-bold text-violet-600 dark:bg-violet-400/20 dark:text-violet-300">AI</span>
                    <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#667085] dark:text-white/55">AI companion agent</span>
                  </div>
                  <div className="mt-1.5 text-sm font-semibold text-[#1e293b] dark:text-white/90">{step.companionStatus}</div>
                </div>

                {/* Lane grid */}
                <div className="grid grid-cols-2 gap-2.5">
                  {step.lanes.map(lane => (
                    <div key={`${step.id}-${lane.title}`} className={`rounded-xl px-3.5 py-2.5 backdrop-blur-[10px] backdrop-saturate-[1.3] ${laneToneClass(lane.tone)}`}>
                      <div className="flex items-center gap-2">
                        <span className={`h-1.5 w-1.5 rounded-full ${laneDot(lane.tone)}`} />
                        <span className="text-[13px] font-semibold">{lane.title}</span>
                      </div>
                      <div className="mt-0.5 pl-3.5 text-[11px] uppercase tracking-[0.12em] opacity-70">{lane.status}</div>
                    </div>
                  ))}
                </div>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>

        {/* Command line */}
        <div className="bg-[linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.22))] px-5 py-3 font-mono text-[13px] text-[#1e293b] shadow-[inset_0_0.5px_0_rgba(255,255,255,0.25)] dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.01),rgba(255,255,255,0.03))] dark:text-[#c4d5ff] dark:shadow-[inset_0_0.5px_0_rgba(255,255,255,0.04)] sm:px-6">
          <span className="text-[#4f46e5] dark:text-[#818cf8]">companion@whip</span>
          <span className="mx-2 text-[#94a3b8] dark:text-[#6878a0]">$</span>
          <AnimatePresence mode="wait">
            <motion.span
              key={`${step.id}-command`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
            >
              {step.command}
            </motion.span>
          </AnimatePresence>
        </div>

        {/* Insight footer */}
        <div className="bg-[linear-gradient(180deg,rgba(255,255,255,0.05),rgba(255,255,255,0.15))] px-5 py-3 text-[13px] leading-6 text-[#667085] shadow-[inset_0_0.5px_0_rgba(255,255,255,0.2)] dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.01),rgba(255,255,255,0.02))] dark:text-[#6878a0] dark:shadow-[inset_0_0.5px_0_rgba(255,255,255,0.03)] sm:px-6">
          <AnimatePresence mode="wait">
            <motion.span
              key={`${step.id}-insight`}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
            >
              {step.insight}
            </motion.span>
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
