/**
 * QC AI Labs — one tool (/ai-labs/:id).
 *
 * The list says what a tool is for; this page is the part that makes the recommendation
 * actionable: **how to install it and how to use it**, in numbered steps with the real
 * commands. A shelf nobody can act on is a link dump.
 *
 * It's a route rather than a modal on purpose — a guide is something you leave open in a tab,
 * scroll back through while a terminal runs, bookmark, and paste to a teammate. A dialog can do
 * none of those.
 *
 * An unknown `:id` renders a plain "not on the shelf" card instead of throwing; the URL is
 * hand-editable and a stale bookmark shouldn't produce a blank screen.
 */
import { useState } from 'react'
import { ArrowUpRight, Check, ChevronRight, Copy, TriangleAlert } from 'lucide-react'
import { useParams } from 'react-router-dom'
import { toast } from 'sonner'

import { Badges, Fit, LabShell, Monogram } from '@/components/ai-labs-ui'
import { findTool, type LabStep } from '@/lib/ai-labs'
import { cn } from '@/lib/utils'

/**
 * A command, ready to be copied. The whole reason the guide is worth reading is that you can
 * run what's on it without retyping — so every code block carries its own copy button rather
 * than making the reader select multi-line text out of a dark box.
 */
function Command({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="group relative mt-3 overflow-hidden rounded-xl border border-white/10 bg-black/40">
      <pre className="overflow-x-auto px-4 py-3 pr-12 font-mono text-[13px] leading-relaxed text-zinc-300">
        {code}
      </pre>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard
            .writeText(code)
            .then(() => {
              setCopied(true)
              // Reset by hand rather than on a timer the component might outlive — a second
              // copy re-arms it, and leaving the tick up is a fair answer to "did that work?".
              toast.success('Copied')
            })
            .catch(() => toast.error('Could not copy — select the text instead'))
        }}
        title="Copy"
        aria-label="Copy command"
        className="absolute right-2 top-2 flex size-8 items-center justify-center rounded-lg text-zinc-500 transition-colors duration-200 hover:bg-white/10 hover:text-white"
      >
        {copied ? <Check className="size-3.5 text-emerald-400" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  )
}

/** One numbered step. The number is the whole visual system here — no cards, no icons. */
function Step({ n, step }: { n: number; step: LabStep }) {
  return (
    <li className="flex gap-4">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-white/10 text-xs font-semibold tabular-nums text-zinc-400">
        {n}
      </span>
      <div className="min-w-0 flex-1 pb-8">
        <h3 className="font-medium tracking-tight text-white">{step.title}</h3>
        {step.body && (
          <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">{renderInline(step.body)}</p>
        )}
        {step.code && <Command code={step.code} />}
      </div>
    </li>
  )
}

/**
 * The two bits of markup a step body actually needs — `code` and **bold** — done by hand.
 * Pulling in react-markdown for one paragraph would cost more than it explains.
 */
function renderInline(text: string): React.ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return (
        <code
          key={i}
          className="rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[12px] text-zinc-200"
        >
          {part.slice(1, -1)}
        </code>
      )
    }
    if (part.startsWith('**') && part.endsWith('**')) {
      return (
        <strong key={i} className="font-medium text-zinc-200">
          {part.slice(2, -2)}
        </strong>
      )
    }
    return part
  })
}

function Section({
  title,
  children,
  className,
}: {
  title: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <section className={cn('border-t border-white/[0.07] pt-8', className)}>
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
        {title}
      </h2>
      <div className="mt-5">{children}</div>
    </section>
  )
}

export default function AiLabDetailPage() {
  const { id } = useParams()
  const tool = findTool(id)

  if (!tool) {
    return (
      <LabShell title="Not found" back="/ai-labs" backLabel="Back to the shelf">
        <div className="max-w-md py-24">
          <h1 className="text-2xl font-semibold tracking-tight text-white">Not on the shelf</h1>
          <p className="mt-3 text-sm leading-relaxed text-zinc-400">
            There&apos;s no tool at this address. It may have been renamed or removed — the shelf
            is short and hand-picked, so it changes.
          </p>
        </div>
      </LabShell>
    )
  }

  return (
    <LabShell title={tool.name} back="/ai-labs" backLabel="Back to the shelf">
      <article className="max-w-3xl space-y-10 py-12">
        <header className="space-y-5">
          <div className="flex items-start gap-4">
            <Monogram text={tool.monogram} large />
            <div className="min-w-0 flex-1">
              <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                {tool.name}
              </h1>
              <p className="mt-1 text-sm text-zinc-500">{tool.vendor}</p>
            </div>
          </div>

          <p className="text-base leading-relaxed text-zinc-300">{tool.pitch}</p>

          <div className="flex flex-wrap items-center gap-1.5">
            <Badges tool={tool} />
            {tool.flags.map((f) => (
              <span
                key={f}
                className="inline-flex items-center rounded-full border border-white/10 px-2.5 py-1 text-[11px] font-medium text-zinc-400"
              >
                {f}
              </span>
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
            <Fit value={tool.fit} />
            <a
              href={tool.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-sm font-medium text-zinc-950 transition-colors duration-200 hover:bg-zinc-200"
            >
              Visit site
              <ArrowUpRight className="size-4" />
            </a>
          </div>
        </header>

        <Section title="What it is">
          <p className="text-sm leading-relaxed text-zinc-300">{tool.what}</p>
        </Section>

        <Section title="What a QC team uses it for">
          <ul className="space-y-2">
            {tool.useCases.map((u) => (
              <li key={u} className="flex gap-2.5 text-sm text-zinc-300">
                <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-zinc-600" />
                <span>{u}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Before you start">
          <ul className="space-y-2">
            {tool.requires.map((r) => (
              <li key={r} className="flex gap-2.5 text-sm text-zinc-300">
                <Check className="mt-0.5 size-3.5 shrink-0 text-zinc-600" />
                <span>{renderInline(r)}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Install">
          <ol className="space-y-0">
            {tool.install.map((s, i) => (
              <Step key={s.title} n={i + 1} step={s} />
            ))}
          </ol>
        </Section>

        <Section title="How to use it">
          <ol className="space-y-0">
            {tool.usage.map((s, i) => (
              <Step key={s.title} n={i + 1} step={s} />
            ))}
          </ol>
        </Section>

        <div className="grid gap-8 border-t border-white/[0.07] pt-8 sm:grid-cols-2">
          <section>
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-emerald-300/80">
              Strong at
            </h2>
            <ul className="mt-4 space-y-2">
              {tool.strengths.map((s) => (
                <li key={s} className="flex gap-2.5 text-sm text-zinc-300">
                  <Check className="mt-0.5 size-3.5 shrink-0 text-emerald-400/80" />
                  <span>{s}</span>
                </li>
              ))}
            </ul>
          </section>
          {/* Limits are not a disclaimer — they're the half a vendor's own page omits, and the
              reason a reader trusts the shelf. */}
          <section>
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-amber-300/80">
              Watch out for
            </h2>
            <ul className="mt-4 space-y-2">
              {tool.limits.map((l) => (
                <li key={l} className="flex gap-2.5 text-sm text-zinc-300">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-400/80" />
                  <span>{l}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <footer className="border-t border-white/[0.07] pt-6 text-sm leading-relaxed text-zinc-600">
          Curated by hand · the fit score is our take, not a benchmark. Steps were run on a real
          machine, but versions move — if a command has drifted, the vendor&apos;s own page is
          linked above.
        </footer>
      </article>
    </LabShell>
  )
}
