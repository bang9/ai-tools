import { useRef } from 'react'
import type { ReactNode } from 'react'
import { motion, useScroll, useTransform } from 'motion/react'
import { Link } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { MarketingShell } from '../components/marketing/MarketingShell'
import { siteMeta } from '../content/site'

const ease: [number, number, number, number] = [0.22, 1, 0.36, 1]

/* ------------------------------------------------------------------ */
/*  Reusable pieces                                                    */
/* ------------------------------------------------------------------ */

function Phase({ number, label }: { number: string; label: string }) {
  return (
    <div className="mb-6 flex items-center justify-center gap-3">
      <span className="text-xs font-semibold uppercase tracking-[0.3em] text-[#4f46e5] dark:text-[#94a3ff]">
        {number}
      </span>
      <span className="h-px w-8 bg-[#4f46e5]/25 dark:bg-[#94a3ff]/25" />
      <span className="text-xs uppercase tracking-[0.2em] text-[#94a3b8] dark:text-white/40">
        {label}
      </span>
    </div>
  )
}

function Terminal({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  return (
    <div className={`overflow-hidden rounded-[1.5rem] border border-[#1e293b] bg-[#0f172a] shadow-[0_32px_80px_rgba(0,0,0,0.28)] dark:border-white/8 ${className}`}>
      <div className="flex items-center gap-2 border-b border-white/6 px-5 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-[#f87171]/40" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#fbbf24]/40" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#34d399]/40" />
        <span className="ml-4 text-[11px] uppercase tracking-[0.18em] text-white/28">{title}</span>
      </div>
      <div className="p-5 font-mono text-[13px] leading-7 text-white/68">
        {children}
      </div>
    </div>
  )
}

function Glass({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-[2rem] border border-white/80 bg-white/58 p-6 shadow-[0_28px_80px_rgba(76,94,160,0.10)] backdrop-blur-2xl dark:border-white/10 dark:bg-white/5 dark:shadow-[0_28px_80px_rgba(0,0,0,0.24)] sm:p-8 ${className}`}>
      {children}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Hero                                                               */
/* ------------------------------------------------------------------ */

function HeroSection() {
  const ref = useRef<HTMLDivElement>(null)
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ['start start', 'end start'],
  })
  const opacity = useTransform(scrollYProgress, [0, 0.85], [1, 0])
  const y = useTransform(scrollYProgress, [0, 0.85], [0, -80])

  return (
    <motion.section
      ref={ref}
      style={{ opacity, y }}
      className="flex min-h-[82vh] flex-col items-center justify-center text-center"
    >
      <motion.p
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease }}
        className="text-xs uppercase tracking-[0.3em] text-[#4f46e5] dark:text-[#94a3ff]"
      >
        How It Works
      </motion.p>

      <motion.h1
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8, ease, delay: 0.1 }}
        className="mt-6 max-w-4xl text-5xl font-semibold tracking-[-0.05em] text-[#0f172a] dark:text-white sm:text-7xl lg:text-8xl"
      >
        You lead the run.
        <br />
        <span className="bg-[linear-gradient(135deg,#4f46e5,#7c3aed,#3b82f6)] bg-clip-text text-transparent">
          Agents ship the work.
        </span>
      </motion.h1>

      <motion.p
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease, delay: 0.22 }}
        className="mx-auto mt-7 max-w-2xl text-lg leading-8 text-[#667085] dark:text-white/62 sm:text-xl"
      >
        A scroll through what it actually feels like to orchestrate
        companion agents with whip — from intent to shipped code.
      </motion.p>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.2, duration: 1 }}
        className="mt-16"
      >
        <div className="flex flex-col items-center gap-1 text-[#94a3b8] dark:text-white/28">
          <span className="text-[10px] uppercase tracking-[0.28em]">Scroll</span>
          <motion.div
            animate={{ y: [0, 6, 0] }}
            transition={{ repeat: Infinity, duration: 1.8, ease: 'easeInOut' }}
            className="h-6 w-px bg-current opacity-40"
          />
        </div>
      </motion.div>
    </motion.section>
  )
}

/* ------------------------------------------------------------------ */
/*  01 — Define                                                        */
/* ------------------------------------------------------------------ */

function DefineSection() {
  return (
    <section className="flex min-h-[88vh] flex-col items-center justify-center py-24">
      <motion.div
        initial={{ opacity: 0, y: 36 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-15%' }}
        transition={{ duration: 0.72, ease }}
        className="text-center"
      >
        <Phase number="01" label="Define" />
        <h2 className="max-w-4xl text-4xl font-semibold tracking-[-0.04em] text-[#0f172a] dark:text-white sm:text-6xl">
          Start with the outcome
        </h2>
        <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-[#667085] dark:text-white/62">
          You don't brief whip with a task list. You describe what you want
          to ship, set the boundaries, and let the run structure itself.
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, y: 32 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-10%' }}
        transition={{ duration: 0.65, ease }}
        className="mt-14 w-full max-w-3xl"
      >
        <Terminal title="Operator prompt">
          <div className="space-y-4">
            <p className="text-white/90">Rebuild our search stack.</p>
            <div className="space-y-1 text-white/60">
              <p>Replace Postgres full-text with a dedicated search service.</p>
              <p>Index pipeline, query API with faceted filters, updated</p>
              <p>search UI, and gradual rollout behind a feature flag.</p>
            </div>
            <p className="border-t border-white/8 pt-4 text-[#60a5fa]">
              Zero downtime. Old search stays live until validation.
            </p>
          </div>
        </Terminal>
      </motion.div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  02 — Shape                                                         */
/* ------------------------------------------------------------------ */

const runPlanTasks = [
  { name: 'Index pipeline', status: 'ready', waiting: false, accent: 'bg-[#818cf8]' },
  { name: 'Search API', status: 'ready', waiting: false, accent: 'bg-[#60a5fa]' },
  { name: 'Search UI', status: 'depends on API', waiting: true, accent: 'bg-[#a78bfa]' },
  { name: 'Rollout + migration', status: 'depends on all', waiting: true, accent: 'bg-[#c084fc]' },
]

function ShapeSection() {
  return (
    <section className="flex min-h-[88vh] flex-col items-center justify-center py-24">
      <motion.div
        initial={{ opacity: 0, y: 36 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-15%' }}
        transition={{ duration: 0.72, ease }}
        className="text-center"
      >
        <Phase number="02" label="Shape" />
        <h2 className="max-w-4xl text-4xl font-semibold tracking-[-0.04em] text-[#0f172a] dark:text-white sm:text-6xl">
          The run takes shape
        </h2>
        <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-[#667085] dark:text-white/62">
          whip reads the intent and structures it into parallel lanes with
          clear dependencies. You see the full plan before anything moves.
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true, margin: '-10%' }}
        transition={{ duration: 0.5, ease }}
        className="mt-14 w-full max-w-3xl"
      >
        <Glass>
          <p className="mb-6 text-[11px] uppercase tracking-[0.22em] text-[#94a3b8] dark:text-white/38">
            Run plan — search-rebuild
          </p>
          <div className="space-y-3">
            {runPlanTasks.map((task, i) => (
              <motion.div
                key={task.name}
                initial={{ opacity: 0, x: -20 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, ease, delay: 0.3 + 0.1 * i }}
                className="flex items-center gap-4 rounded-[1.25rem] border border-white/80 bg-white/72 px-5 py-4 dark:border-white/8 dark:bg-white/4"
              >
                <div className={`h-2.5 w-2.5 shrink-0 rounded-full ${task.accent}`} />
                <p className="flex-1 text-sm font-semibold text-[#1e293b] dark:text-white/90">{task.name}</p>
                <span
                  className={`rounded-full px-3 py-1 text-[11px] uppercase tracking-[0.14em] ${
                    task.waiting
                      ? 'border border-violet-200 bg-violet-50 text-violet-600 dark:border-violet-400/20 dark:bg-violet-500/10 dark:text-violet-300'
                      : 'border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-500/10 dark:text-emerald-300'
                  }`}
                >
                  {task.status}
                </span>
              </motion.div>
            ))}
          </div>
          <div className="mt-6 flex items-center gap-2 text-sm text-[#667085] dark:text-white/50">
            <div className="h-px flex-1 bg-[#e2e8f0] dark:bg-white/8" />
            <span>2 lanes start now · 2 wait</span>
            <div className="h-px flex-1 bg-[#e2e8f0] dark:bg-white/8" />
          </div>
        </Glass>
      </motion.div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  03 — Dispatch                                                      */
/* ------------------------------------------------------------------ */

const ircMessages = [
  { from: 'whip-a3f2', text: 'Schema mapped. 14 fields indexed. Moving to CDC connector.', color: 'text-[#818cf8]' },
  { from: 'whip-b8c1', text: 'Query builder done. Starting faceted filter logic.', color: 'text-[#60a5fa]' },
  { from: 'whip-a3f2', text: 'Pipeline live. Backfill running — 2.1M docs/hr.', color: 'text-[#818cf8]' },
  { from: 'whip-b8c1', text: 'Faceted filters passing. 43 test cases green.', color: 'text-[#60a5fa]' },
]

function DispatchSection() {
  return (
    <section className="flex min-h-[92vh] flex-col items-center justify-center py-24">
      <motion.div
        initial={{ opacity: 0, y: 36 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-15%' }}
        transition={{ duration: 0.72, ease }}
        className="text-center"
      >
        <Phase number="03" label="Dispatch" />
        <h2 className="max-w-4xl text-4xl font-semibold tracking-[-0.04em] text-[#0f172a] dark:text-white sm:text-6xl">
          Companion agents, in motion
        </h2>
        <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-[#667085] dark:text-white/62">
          Each companion agent owns a lane. They coordinate through IRC, report
          progress, and surface review points — without flooding your terminal.
        </p>
      </motion.div>

      <div className="mt-14 grid w-full max-w-5xl gap-5 lg:grid-cols-2">
        <motion.div
          initial={{ opacity: 0, y: 32 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-10%' }}
          transition={{ duration: 0.6, ease }}
        >
          <Terminal title="whip dispatch">
            <div className="space-y-3">
              <div className="flex gap-2">
                <span className="text-white/40">$</span>
                <span className="text-[#c7d2fe]">whip task assign a3f2 && whip task assign b8c1</span>
              </div>
              <div className="space-y-1.5 border-t border-white/6 pt-3">
                <p><span className="text-[#34d399]">→</span> Launched: index-pipeline <span className="text-white/36">(whip-a3f2)</span></p>
                <p><span className="text-[#34d399]">→</span> Launched: search-api <span className="text-white/36">(whip-b8c1)</span></p>
                <p><span className="text-[#60a5fa]">ℹ</span> claude-irc routing active</p>
              </div>
            </div>
          </Terminal>
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true, margin: '-10%' }}
          transition={{ duration: 0.5, ease }}
        >
          <Glass>
            <p className="mb-5 text-[11px] uppercase tracking-[0.22em] text-[#94a3b8] dark:text-white/38">
              IRC feed
            </p>
            <div className="space-y-3">
              {ircMessages.map((msg, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, y: 12 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.4, ease, delay: 0.3 + 0.12 * i }}
                  className="rounded-[1rem] border border-white/80 bg-white/72 px-4 py-3 dark:border-white/8 dark:bg-white/4"
                >
                  <span className={`text-xs font-semibold ${msg.color}`}>{msg.from}</span>
                  <p className="mt-1 text-sm leading-6 text-[#475467] dark:text-white/66">{msg.text}</p>
                </motion.div>
              ))}
            </div>
          </Glass>
        </motion.div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  04 — Review                                                        */
/* ------------------------------------------------------------------ */

function ReviewSection() {
  return (
    <section className="flex min-h-[88vh] flex-col items-center justify-center py-24">
      <motion.div
        initial={{ opacity: 0, y: 36 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-15%' }}
        transition={{ duration: 0.72, ease }}
        className="text-center"
      >
        <Phase number="04" label="Review" />
        <h2 className="max-w-4xl text-4xl font-semibold tracking-[-0.04em] text-[#0f172a] dark:text-white sm:text-6xl">
          Step in when it counts
        </h2>
        <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-[#667085] dark:text-white/62">
          You don't watch every keystroke. Agents surface the moments that need
          your judgment — a design tradeoff, an edge case, a direction check.
        </p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        whileInView={{ opacity: 1, scale: 1 }}
        viewport={{ once: true, margin: '-10%' }}
        transition={{ duration: 0.65, ease }}
        className="mt-14 w-full max-w-3xl"
      >
        <Glass>
          <div className="space-y-5">
            <div className="rounded-[1.25rem] border border-[#818cf8]/20 bg-[linear-gradient(135deg,rgba(79,70,229,0.06),rgba(99,102,241,0.03))] p-5 dark:border-[#818cf8]/15 dark:bg-[linear-gradient(135deg,rgba(79,70,229,0.12),rgba(99,102,241,0.06))]">
              <div className="mb-3 flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-[#818cf8]" />
                <span className="text-xs font-semibold text-[#818cf8]">whip-b8c1</span>
                <span className="text-[10px] uppercase tracking-[0.16em] text-[#94a3b8] dark:text-white/36">review requested</span>
              </div>
              <p className="text-sm leading-7 text-[#334155] dark:text-white/78">
                Relevance scoring uses BM25 with field boosting. Tests passing.
              </p>
              <p className="mt-2 text-sm leading-7 text-[#667085] dark:text-white/56">
                Edge case: multi-word queries on CJK content need a tokenizer
                override. Should I handle it here or route to index-pipeline?
              </p>
            </div>

            <div className="rounded-[1.25rem] border border-[#34d399]/20 bg-[linear-gradient(135deg,rgba(52,211,153,0.06),rgba(16,185,129,0.03))] p-5 dark:border-[#34d399]/15 dark:bg-[linear-gradient(135deg,rgba(52,211,153,0.10),rgba(16,185,129,0.05))]">
              <div className="mb-3 flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-[#34d399]" />
                <span className="text-xs font-semibold text-[#34d399]">You</span>
                <span className="text-[10px] uppercase tracking-[0.16em] text-[#94a3b8] dark:text-white/36">decision</span>
              </div>
              <p className="text-sm leading-7 text-[#334155] dark:text-white/78">
                Approve the scoring. Route the CJK tokenizer to the pipeline
                task — it owns the analyzer config. Keep the query layer clean.
              </p>
            </div>
          </div>
        </Glass>
      </motion.div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  05 — Close                                                         */
/* ------------------------------------------------------------------ */

const runStats = [
  { value: '4', label: 'tasks shipped' },
  { value: '4', label: 'PRs merged' },
  { value: '0', label: 'rollbacks' },
  { value: '0', label: 'open leftovers' },
]

function CloseSection() {
  return (
    <section className="flex min-h-[82vh] flex-col items-center justify-center py-24">
      <motion.div
        initial={{ opacity: 0, y: 36 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-15%' }}
        transition={{ duration: 0.72, ease }}
        className="text-center"
      >
        <Phase number="05" label="Close" />
        <h2 className="max-w-4xl text-4xl font-semibold tracking-[-0.04em] text-[#0f172a] dark:text-white sm:text-6xl">
          Merge it. Close the run.
        </h2>
        <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-[#667085] dark:text-white/62">
          The run is not done when code exists. It is done when PRs are merged,
          every lane is closed, and nothing is left dangling.
        </p>
      </motion.div>

      <div className="mt-14 w-full max-w-3xl space-y-6">
        <div className="flex flex-wrap justify-center gap-3">
          {runStats.map((s, i) => (
            <motion.div
              key={s.label}
              initial={{ opacity: 0, scale: 0.92 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, ease, delay: 0.06 * i }}
              className="rounded-full border border-[#d8e2ff] bg-white/72 px-5 py-2.5 shadow-[0_10px_30px_rgba(76,94,160,0.08)] backdrop-blur-xl dark:border-white/10 dark:bg-white/5"
            >
              <span className="text-sm font-semibold text-[#0f172a] dark:text-white">{s.value}</span>
              <span className="ml-2 text-sm text-[#667085] dark:text-white/55">{s.label}</span>
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-8%' }}
          transition={{ duration: 0.6, ease }}
        >
          <Glass>
            <p className="mb-4 text-[11px] uppercase tracking-[0.22em] text-[#94a3b8] dark:text-white/38">
              Run closeout
            </p>
            <div className="space-y-3 text-sm leading-7 text-[#334155] dark:text-white/72">
              <p>All four branches merged to main. No orphaned lanes.</p>
              <p>CJK tokenizer follow-up noted for next sprint — routed during review, not forgotten.</p>
            </div>
          </Glass>
        </motion.div>
      </div>
    </section>
  )
}

/* ------------------------------------------------------------------ */
/*  CTA                                                                */
/* ------------------------------------------------------------------ */

function ClosingCTA() {
  return (
    <motion.section
      initial={{ opacity: 0, y: 40 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-10%' }}
      transition={{ duration: 0.7, ease }}
      className="pb-8 pt-12 text-center"
    >
      <Glass className="py-16">
        <h2 className="text-3xl font-semibold tracking-[-0.04em] text-[#0f172a] dark:text-white sm:text-5xl">
          Ready to lead your first run?
        </h2>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link
            to="/login"
            className="rounded-full bg-[linear-gradient(135deg,#4f46e5,#8b5cf6)] px-6 py-3 text-sm font-semibold text-white shadow-[0_20px_40px_rgba(99,102,241,0.25)] transition-transform hover:-translate-y-0.5"
          >
            Connect dashboard
          </Link>
          <a
            href={siteMeta.repoURL}
            target="_blank"
            rel="noreferrer"
            className="rounded-full border border-[#d8e2ff] bg-white/62 px-6 py-3 text-sm font-semibold text-[#334155] backdrop-blur-xl transition-colors hover:bg-white dark:border-white/10 dark:bg-white/5 dark:text-white/84 dark:hover:bg-white/8"
          >
            View on GitHub
          </a>
        </div>
      </Glass>
    </motion.section>
  )
}

/* ------------------------------------------------------------------ */
/*  SEO data                                                           */
/* ------------------------------------------------------------------ */

const seoSteps = [
  { name: 'Define the outcome', text: 'Describe what you want to ship, set boundaries, and let whip structure the run.' },
  { name: 'Shape the run', text: 'whip turns intent into parallel lanes with clear dependencies and stack order.' },
  { name: 'Dispatch companion agents', text: 'Each agent owns a lane, coordinates through IRC, and surfaces review points.' },
  { name: 'Review when it counts', text: 'Step in for design tradeoffs and edge cases, not routine progress.' },
  { name: 'Close the loop', text: 'Merge PRs, close every lane, and leave nothing dangling.' },
]

/* ------------------------------------------------------------------ */
/*  Page                                                               */
/* ------------------------------------------------------------------ */

export function WorkflowPage() {
  return (
    <>
      <Seo
        title="How whip works"
        description="A scroll-driven product story of how a developer orchestrates AI companion agents with whip — from defining the outcome to shipping code."
        path="/how-it-works"
        type="article"
        keywords={['whip workflow', 'task orchestrator', 'ai companion agents', 'how whip works', 'agent orchestration']}
        jsonLd={[
          {
            '@context': 'https://schema.org',
            '@type': 'HowTo',
            name: 'How to orchestrate AI companion agents with whip',
            description: 'An operator-perspective walkthrough of orchestrating AI companion agents with whip.',
            step: seoSteps.map((s, i) => ({
              '@type': 'HowToStep',
              position: i + 1,
              name: s.name,
              text: s.text,
            })),
          },
          {
            '@context': 'https://schema.org',
            '@type': 'TechArticle',
            headline: 'How whip works',
            author: { '@type': 'Person', name: 'Airen Kang' },
            publisher: { '@type': 'Organization', name: siteMeta.name },
            description: 'An operator-perspective product story of how whip orchestrates AI companion agent runs.',
          },
        ]}
      />
      <MarketingShell>
        <HeroSection />
        <DefineSection />
        <ShapeSection />
        <DispatchSection />
        <ReviewSection />
        <CloseSection />
        <ClosingCTA />
      </MarketingShell>
    </>
  )
}
