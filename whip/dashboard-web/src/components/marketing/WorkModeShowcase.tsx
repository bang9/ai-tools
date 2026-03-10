import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'

const globalSteps = [
  { label: 'You', detail: 'Set the outcome and constraints.' },
  { label: 'Companion AI Agent', detail: 'Takes one direct task and executes it end to end.' },
  { label: 'Completed', detail: 'You review the result and close the loop.' },
]

const stackedLanes = [
  { title: 'Contract lane', state: 'approved' },
  { title: 'API lane', state: 'in progress' },
  { title: 'Timeline UI', state: 'blocked by API' },
  { title: 'Export + rollout', state: 'queued for review' },
]

function laneStateClass(state: string) {
  if (state === 'approved') return 'bg-[linear-gradient(135deg,rgba(167,243,208,0.45),rgba(209,250,229,0.25))] text-emerald-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.6),0_2px_6px_rgba(52,211,153,0.08)] dark:bg-emerald-400/8 dark:text-emerald-200 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]'
  if (state === 'in progress') return 'bg-[linear-gradient(135deg,rgba(186,230,253,0.45),rgba(224,242,254,0.25))] text-sky-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.6),0_2px_6px_rgba(56,189,248,0.08)] dark:bg-sky-400/8 dark:text-sky-200 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]'
  if (state.includes('review')) return 'bg-[linear-gradient(135deg,rgba(221,214,254,0.45),rgba(237,233,254,0.25))] text-violet-700 shadow-[inset_0_1px_0_rgba(255,255,255,0.6),0_2px_6px_rgba(139,92,246,0.08)] dark:bg-violet-400/8 dark:text-violet-200 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]'
  return 'bg-white/30 text-[#4b5975] shadow-[inset_0_1px_0_rgba(255,255,255,0.5),0_2px_6px_rgba(76,94,160,0.04)] dark:bg-white/[0.04] dark:text-[#8494b8] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]'
}

function laneDot(state: string) {
  if (state === 'approved') return 'bg-emerald-500 dark:bg-emerald-400'
  if (state === 'in progress') return 'bg-sky-500 dark:bg-sky-400 animate-pulse'
  if (state.includes('review')) return 'bg-violet-500 dark:bg-violet-400'
  return 'bg-[#b0bdd4] dark:bg-[#4a5b7a]'
}

type Mode = 'global' | 'workspace'

interface ModeConfig {
  eyebrow: string
  title: string
  description: string
  tags: string[]
}

const modes: Record<Mode, ModeConfig> = {
  global: {
    eyebrow: 'Global',
    title: 'Single task work',
    description: 'When the work is direct, keep it simple. One lead works with one AI companion agent, keeps the context tight, and closes the task in one clear line.',
    tags: ['one task', 'one companion agent', 'single review point'],
  },
  workspace: {
    eyebrow: 'Workspace',
    title: 'Stacked task work',
    description: 'When the work branches, you assign a Workspace Lead — an AI companion agent that autonomously shapes the stack, dispatches workers, manages dependencies, and escalates review only when it matters.',
    tags: ['workspace lead', 'autonomous orchestration', 'dependency-aware', 'review only when needed'],
  },
}

function GlobalVisual() {
  return (
    <div className="rounded-[2rem] bg-white/35 p-5 shadow-[inset_0_1.5px_0_rgba(255,255,255,0.95),inset_0_-0.5px_0_rgba(255,255,255,0.3),0_16px_48px_rgba(76,94,160,0.08)] backdrop-blur-[24px] backdrop-saturate-[1.8] dark:bg-white/4 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] dark:backdrop-saturate-100">
      <div className="mb-4 rounded-[1rem] bg-[linear-gradient(135deg,rgba(79,70,229,0.10),rgba(59,130,246,0.06))] px-4 py-3 font-mono text-xs text-[#4f46e5] shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] dark:bg-[linear-gradient(135deg,rgba(79,70,229,0.16),rgba(59,130,246,0.10))] dark:text-[#c7d2fe] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        whip task create "Polish the billing empty state copy"
      </div>
      <div className="relative space-y-5">
        <div className="absolute left-[1.1rem] top-5 bottom-5 w-px bg-[linear-gradient(180deg,rgba(79,70,229,0.18),rgba(79,70,229,0.58),rgba(79,70,229,0.18))] dark:bg-[linear-gradient(180deg,rgba(129,140,248,0.12),rgba(129,140,248,0.48),rgba(129,140,248,0.12))]" />
        {globalSteps.map(step => (
          <div key={step.label} className="relative pl-10">
            <span className="absolute left-0 top-1.5 inline-flex h-9 w-9 items-center justify-center rounded-full bg-[linear-gradient(135deg,rgba(224,231,255,0.8),rgba(199,210,255,0.6))] text-[11px] font-semibold uppercase tracking-[0.16em] text-[#4f46e5] shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_8px_24px_rgba(79,70,229,0.12)] dark:bg-[linear-gradient(135deg,rgba(79,70,229,0.22),rgba(59,130,246,0.14))] dark:text-[#b8c3ff] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
              {step.label === 'Completed' ? 'OK' : step.label === 'You' ? 'You' : 'AI'}
            </span>
            <div className="rounded-[1.2rem] bg-white/50 px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_8px_24px_rgba(76,94,160,0.05)] backdrop-blur-[12px] backdrop-saturate-[1.3] dark:bg-white/5 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
              <div className="text-sm font-semibold text-[#0f172a] dark:text-white">{step.label}</div>
              <div className="mt-1 text-sm leading-7 text-[#667085] dark:text-white/62">{step.detail}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function WorkspaceVisual() {
  return (
    <div className="overflow-hidden rounded-[2rem] bg-white/35 shadow-[inset_0_1.5px_0_rgba(255,255,255,0.95),inset_0_-0.5px_0_rgba(255,255,255,0.3),0_24px_80px_rgba(76,94,160,0.10),0_8px_24px_rgba(76,94,160,0.06)] backdrop-blur-[24px] backdrop-saturate-[1.8] dark:bg-[#111827]/90 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_26px_80px_rgba(10,20,40,0.40)] dark:backdrop-blur-[20px] dark:backdrop-saturate-100">
      <div className="bg-[linear-gradient(180deg,rgba(255,255,255,0.40),rgba(255,255,255,0.15))] px-5 py-3 dark:bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.01))]">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-[#3b82f6]/50" />
            <span className="h-2 w-2 rounded-full bg-[#818cf8]/50" />
            <span className="h-2 w-2 rounded-full bg-[#c084fc]/50" />
          </div>
          <div className="text-[11px] uppercase tracking-[0.2em] text-[#94a3b8] dark:text-[#6878a0]">stack graph</div>
        </div>
      </div>

      <div className="grid gap-0 lg:grid-cols-[0.84fr_1.16fr]">
        <div className="shadow-[inset_0_-1px_0_rgba(255,255,255,0.2)] dark:shadow-[inset_0_-1px_0_rgba(255,255,255,0.04)] lg:shadow-[inset_-1px_0_0_rgba(255,255,255,0.2)] lg:dark:shadow-[inset_-1px_0_0_rgba(255,255,255,0.04)]">
          <div className="px-5 py-5">
            <div className="rounded-2xl bg-white/40 px-4 py-4 text-[#334155] shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_4px_16px_rgba(76,94,160,0.05)] backdrop-blur-[12px] backdrop-saturate-[1.4] dark:bg-white/[0.04] dark:text-[#c4d5ff] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
              <div className="text-[11px] uppercase tracking-[0.18em] text-[#94a3b8] dark:text-[#6878a0]">You → Workspace Lead</div>
              <div className="mt-2 text-sm leading-7">
                "Ship the incident replay workflow."
                <br />
                "I'll split it into shared contract, API, UI, and rollout lanes."
              </div>
            </div>
            <motion.div
              animate={{ y: [0, -3, 0] }}
              transition={{ duration: 4.2, repeat: Infinity, ease: 'easeInOut' }}
              className="mt-4 rounded-2xl bg-[linear-gradient(135deg,rgba(196,181,253,0.30),rgba(221,214,254,0.15))] px-4 py-4 text-[#1e293b] shadow-[inset_0_1px_0_rgba(255,255,255,0.6),0_12px_32px_rgba(139,92,246,0.08)] backdrop-blur-[12px] backdrop-saturate-[1.4] dark:bg-[linear-gradient(135deg,rgba(79,70,229,0.14),rgba(139,92,246,0.10))] dark:text-white dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_18px_45px_rgba(79,70,229,0.12)]"
            >
              <div className="flex items-center gap-2">
                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-violet-100/80 text-[9px] font-bold text-violet-600 dark:bg-violet-400/20 dark:text-violet-300">AI</span>
                <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[#667085] dark:text-white/55">AI companion agent</span>
              </div>
              <div className="mt-1.5 text-sm font-semibold">Owns the run shape</div>
              <div className="mt-1.5 text-sm leading-7 text-[#667085] dark:text-white/75">
                Dispatches lead and workers, preserves stack order, and routes only the critical review moment back to you.
              </div>
            </motion.div>
          </div>
        </div>

        <div className="px-5 py-5">
          <div className="mb-3 text-[11px] uppercase tracking-[0.18em] text-[#94a3b8] dark:text-[#6878a0]">Task lanes</div>
          <div className="grid grid-cols-2 gap-2.5">
            {stackedLanes.map(lane => (
              <motion.div
                key={lane.title}
                whileHover={{ y: -2 }}
                transition={{ duration: 0.2 }}
                className={`rounded-xl px-3.5 py-2.5 backdrop-blur-[10px] backdrop-saturate-[1.3] ${laneStateClass(lane.state)}`}
              >
                <div className="flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 rounded-full ${laneDot(lane.state)}`} />
                  <span className="text-[13px] font-semibold">{lane.title}</span>
                </div>
                <div className="mt-0.5 pl-3.5 text-[11px] uppercase tracking-[0.12em] opacity-70">{lane.state}</div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export function WorkModeShowcase() {
  const [active, setActive] = useState<Mode>('global')
  const mode = modes[active]

  return (
    <section className="pb-18">
      <div className="mx-auto max-w-3xl text-center">
        <p className="text-xs uppercase tracking-[0.24em] text-[#4f46e5] dark:text-[#94a3ff]">Execution modes</p>
        <h2 className="mt-4 text-3xl font-semibold tracking-[-0.04em] text-[#0f172a] dark:text-white sm:text-5xl">
          Start in global for direct work.
          <br />
          Move into a workspace when the run branches.
        </h2>
        <p className="mx-auto mt-5 max-w-2xl text-base leading-8 text-[#667085] dark:text-white/66 sm:text-lg">
          whip stays a task orchestrator first. The difference is how much structure the run needs.
        </p>
      </div>

      {/* Mode tabs */}
      <div className="mt-10 flex justify-center">
        <div className="inline-flex rounded-full bg-white/40 p-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_10px_30px_rgba(91,108,255,0.08)] backdrop-blur-[16px] backdrop-saturate-[1.6] dark:bg-white/5 dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
          {(['global', 'workspace'] as Mode[]).map(m => (
            <button
              key={m}
              type="button"
              onClick={() => setActive(m)}
              className={`rounded-full px-5 py-2 text-sm font-semibold transition-all ${
                active === m
                  ? 'bg-[linear-gradient(135deg,#4f46e5,#8b5cf6)] text-white shadow-[0_0_20px_rgba(99,102,241,0.24)]'
                  : 'text-[#667085] hover:text-[#334155] dark:text-white/55 dark:hover:text-white'
              }`}
            >
              {m === 'global' ? 'Global' : 'Workspace'}
            </button>
          ))}
        </div>
      </div>

      {/* Full-width mode card */}
      <AnimatePresence mode="wait">
        <motion.div
          key={active}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="mt-8"
        >
          <div className="relative overflow-hidden rounded-[2rem] bg-white/30 p-6 shadow-[inset_0_1.5px_0_rgba(255,255,255,0.95),inset_0_-0.5px_0_rgba(255,255,255,0.3),0_28px_80px_rgba(76,94,160,0.10),0_8px_24px_rgba(76,94,160,0.06)] backdrop-blur-[24px] backdrop-saturate-[1.8] dark:bg-white/[0.03] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_28px_80px_rgba(0,0,0,0.30)] dark:backdrop-saturate-100 sm:p-8">
            <div className="pointer-events-none absolute right-[-5rem] top-[-5rem] h-48 w-48 rounded-full bg-[radial-gradient(circle,rgba(99,102,241,0.16),transparent_70%)] blur-[60px]" />

            <div className="relative grid gap-8 lg:grid-cols-[1fr_1.3fr] lg:items-start">
              {/* Text side */}
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-[#4f46e5] dark:text-[#9fb1ff]">{mode.eyebrow}</p>
                <h3 className="mt-3 text-2xl font-semibold tracking-[-0.04em] text-[#0f172a] dark:text-white sm:text-3xl">
                  {mode.title}
                </h3>
                <p className="mt-3 max-w-xl text-sm leading-7 text-[#667085] dark:text-white/64">
                  {mode.description}
                </p>

                <div className="mt-5 flex flex-wrap gap-2">
                  {mode.tags.map(tag => (
                    <div
                      key={tag}
                      className="rounded-full bg-white/40 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#4f46e5] shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_4px_12px_rgba(79,70,229,0.06)] backdrop-blur-[10px] backdrop-saturate-[1.3] dark:bg-white/5 dark:text-[#b8c3ff] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]"
                    >
                      {tag}
                    </div>
                  ))}
                </div>
              </div>

              {/* Visual side */}
              <div>
                {active === 'global' ? <GlobalVisual /> : <WorkspaceVisual />}
              </div>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </section>
  )
}
