/**
 * QC AI Labs (/ai-labs) — a curated shelf of the AI products worth a QC engineer's time.
 *
 * The list only has to answer "what should I try, and why?"; the answer to "how do I actually
 * get it running?" is a whole page of its own (`/ai-labs/:id`, `AiLabDetailPage`). A card is
 * therefore a LINK, not a dialog — a guide with commands in it is something people leave open
 * in a tab, come back to, and send to a teammate, none of which a modal can do.
 *
 * The catalog lives in `lib/ai-labs.ts`; the dark standalone surface and the shared bits in
 * `components/ai-labs-ui.tsx`, which is also where the why of both is written down.
 */
import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'

import { Badges, Fit, LabShell, Monogram } from '@/components/ai-labs-ui'
import { CATALOG, type LabTool } from '@/lib/ai-labs'

function ToolCard({ tool }: { tool: LabTool }) {
  return (
    <Link
      to={`/ai-labs/${tool.id}`}
      className="flex h-full flex-col gap-4 rounded-2xl border border-white/10 bg-white/[0.02] p-6 transition-colors duration-200 hover:border-white/20 hover:bg-white/[0.04] focus:outline-none focus-visible:border-white/40"
    >
      <div className="flex items-start gap-3.5">
        <Monogram text={tool.monogram} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="truncate font-semibold tracking-tight text-white">{tool.name}</div>
          <div className="truncate text-xs text-zinc-500">{tool.vendor}</div>
        </div>
      </div>

      <p className="text-sm leading-relaxed text-zinc-400">{tool.pitch}</p>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badges tool={tool} />
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 border-t border-white/[0.07] pt-4">
        <Fit value={tool.fit} />
        <span className="inline-flex items-center gap-1 text-xs font-medium text-zinc-400">
          Install &amp; guide
          <ChevronRight className="size-3.5" />
        </span>
      </div>
    </Link>
  )
}

export default function AiLabsPage() {
  return (
    <LabShell title="QC AI Labs" back="/qc-run" backLabel="Back to the portal">
      <section className="max-w-2xl pb-12 pt-16">
        <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
          The AI worth a tester&apos;s time.
        </h1>
        <p className="mt-4 text-base leading-relaxed text-zinc-400">
          A short shelf, on purpose — each one read the way you&apos;d want a colleague to explain
          it: what it&apos;s actually for, how to get it running, and where it quietly
          doesn&apos;t pay off.
        </p>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        {CATALOG.map((t) => (
          <ToolCard key={t.id} tool={t} />
        ))}
      </div>

      {/* Said plainly, at the bottom: the shelf and the scores are editorial. Presenting a
          judgement as data is how a reader stops trusting the whole page. */}
      <footer className="mt-16 border-t border-white/[0.07] pt-6 text-sm leading-relaxed text-zinc-600">
        Curated by hand · fit scores are our take, not a benchmark. This page runs no AI, reads no
        files, and is not connected to any project.
      </footer>
    </LabShell>
  )
}
