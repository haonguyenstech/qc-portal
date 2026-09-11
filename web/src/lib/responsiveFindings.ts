import type {
  ResponsiveDeviceCapture,
  ResponsiveFinding,
  ResponsiveJob,
  ResponsiveSeverity,
} from './types'

/**
 * How a responsive sweep is read and written down — the verdict, the wording, and
 * the Markdown deliverable.
 *
 * ONE source for the screen and for the exported report, the same rule
 * `systemReport.ts` and `perfReport.ts` follow: a finding pasted into a ticket has
 * to say the same thing as the row it was copied from, or the two disagree in
 * front of a developer and the report stops being trusted.
 */

const SEVERITY_ORDER: Record<ResponsiveSeverity, number> = { high: 0, medium: 1, low: 2 }

export function bySeverity(a: ResponsiveFinding, b: ResponsiveFinding): number {
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.count - a.count
}

/** The word for a severity in the UI — matches the portal's fixed status palette. */
export const SEVERITY_LABEL: Record<ResponsiveSeverity, string> = {
  high: 'Broken',
  medium: 'Needs a look',
  low: 'Polish',
}

/**
 * Tailwind classes per severity. Red/amber/slate rather than red/amber/green:
 * "low" is not a pass, it is a finding nobody has to fix today, and painting it
 * green makes a list of nine of them look like a clean sweep.
 */
export const SEVERITY_CLASS: Record<ResponsiveSeverity, string> = {
  high: 'border-destructive/40 bg-destructive/10 text-destructive',
  medium: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  low: 'border-border/60 bg-muted/60 text-muted-foreground',
}

/** What each finding means, in one sentence, for the row's expanded state. */
export const KIND_EXPLAINER: Record<ResponsiveFinding['kind'], string> = {
  'no-viewport-meta':
    'The page has no viewport meta tag, so a phone lays it out at ~980px and shrinks the result. Every media query in the CSS is inert until the tag is added.',
  'zoom-disabled':
    'The viewport meta blocks pinch-zoom. It fails WCAG 1.4.4 and is the usual reason small print is unreadable on a phone.',
  'horizontal-overflow':
    'The document is wider than the screen, so the whole page can be dragged sideways. Almost always one element with a fixed width, a long unbroken string, or a table.',
  'wide-element':
    'These elements are individually wider than the viewport. They are the cause of the sideways scroll above, or will be once a parent stops hiding them.',
  'small-tap-target':
    'Controls under 44×44 CSS px are hard to hit with a thumb. Apple asks for 44, WCAG 2.2 AA for 24 — a text link inside a paragraph is exempt and is not counted here.',
  'tiny-text':
    'Text under 12px is hard to read on a phone. A form field under 16px is worse: iOS Safari zooms the page when it is focused, which reads as the layout jumping.',
  'clipped-text':
    'The content is wider than its box and overflow is hidden with no ellipsis, so the text is simply missing at this width rather than truncated visibly.',
  'fixed-overlay':
    'A fixed or sticky bar covers a quarter of the screen or more. On a short phone viewport that is a third of the page a user cannot scroll away from.',
  'oversized-image':
    'The image file is at least twice the pixels it is drawn at, at this device pixel ratio — wasted mobile data and a slower first paint on a real network.',
}

// ------------------------------------------------------------------ verdict

export interface ResponsiveVerdict {
  /** `broken` if anything is high, `warn` if anything is medium, else `ok`. */
  level: 'ok' | 'warn' | 'broken'
  /** One line for the header — what an engineer would say out loud. */
  headline: string
  counts: Record<ResponsiveSeverity, number>
  /** Devices with at least one high finding, by label. */
  brokenDevices: string[]
}

/**
 * The sweep's verdict.
 *
 * A device that FAILED to capture (a timeout, a crash) is not counted as clean:
 * that is the mirror-image of the redirect trap — a sweep where four of six
 * devices errored would otherwise announce "no serious problems", which is the
 * confident wrong answer. It is reported as its own line instead.
 */
export function verdictOf(result: ResponsiveJob['result']): ResponsiveVerdict {
  const counts: Record<ResponsiveSeverity, number> = { high: 0, medium: 0, low: 0 }
  const brokenDevices: string[] = []
  const captures = result?.captures ?? []
  let failed = 0

  for (const c of captures) {
    if (c.error) {
      failed++
      continue
    }
    let high = 0
    for (const f of c.findings) {
      counts[f.severity]++
      if (f.severity === 'high') high++
    }
    if (high) brokenDevices.push(c.device.label)
  }

  const level = counts.high > 0 ? 'broken' : counts.medium > 0 ? 'warn' : 'ok'
  const devices = captures.length - failed
  const headline =
    devices === 0
      ? failed
        ? `No device could be captured — ${failed} failed.`
        : 'Nothing captured yet.'
      : counts.high > 0
        ? `Broken on ${brokenDevices.length} of ${devices} device${devices === 1 ? '' : 's'} — ${counts.high} serious finding${counts.high === 1 ? '' : 's'}.`
        : counts.medium > 0
          ? `Renders on all ${devices} device${devices === 1 ? '' : 's'}, with ${counts.medium} thing${counts.medium === 1 ? '' : 's'} worth a look.`
          : `Clean on ${devices} device${devices === 1 ? '' : 's'}.`

  return {
    level,
    headline: failed && devices > 0 ? `${headline} ${failed} device${failed === 1 ? '' : 's'} could not be captured.` : headline,
    counts,
    brokenDevices,
  }
}

/** The findings of one device, worst first. */
export function sortedFindings(capture: ResponsiveDeviceCapture): ResponsiveFinding[] {
  return [...capture.findings].sort(bySeverity)
}

/**
 * Findings that appear on EVERY captured device, by kind.
 *
 * The single most useful reading of a multi-device sweep: a problem on one phone
 * is a breakpoint bug, and the same problem on all six is a layout bug — and only
 * the second one is worth one ticket instead of six.
 */
export function commonKinds(result: ResponsiveJob['result']): ResponsiveFinding['kind'][] {
  const captures = (result?.captures ?? []).filter((c) => !c.error)
  if (captures.length < 2) return []
  const [first, ...rest] = captures
  return first.findings
    .map((f) => f.kind)
    .filter((kind) => rest.every((c) => c.findings.some((f) => f.kind === kind)))
}

// ------------------------------------------------------------------ markdown

/**
 * The sweep as Markdown — what gets pasted into a ticket or dropped next to a
 * screenshot. Written for the developer who has to fix it: device, measurement,
 * and the element path, in that order, because "it's broken on mobile" is the bug
 * report this is meant to replace.
 */
export function responsiveMarkdown(job: ResponsiveJob): string {
  const result = job.result
  const verdict = verdictOf(result)
  const lines: string[] = []

  lines.push(`# Responsive check — ${job.config.url}`)
  lines.push('')
  lines.push(`**${verdict.headline}**`)
  lines.push('')
  lines.push(`- Captured: ${result?.capturedAt ? new Date(result.capturedAt).toLocaleString() : '—'}`)
  lines.push(`- Devices: ${job.config.devices.map((d) => `${d.label} (${d.width}×${d.height} @${d.dpr}x)`).join(', ')}`)
  if (result?.redirected) {
    lines.push(`- **Redirected** to ${result.finalUrl} — everything below describes that page.`)
  }
  const common = commonKinds(result)
  if (common.length) {
    lines.push(
      `- On every device: ${common.join(', ')} — a layout problem rather than a breakpoint one.`,
    )
  }
  lines.push('')

  lines.push('| Device | Viewport | Serious | Total | Verdict |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const c of result?.captures ?? []) {
    const high = c.findings.filter((f) => f.severity === 'high').length
    lines.push(
      `| ${c.device.label} | ${c.device.width}×${c.device.height} @${c.device.dpr}x | ${
        c.error ? '—' : high
      } | ${c.error ? '—' : c.findings.length} | ${
        c.error ? `not captured (${c.error})` : high ? 'Broken' : c.findings.length ? 'Needs a look' : 'Clean' }|`,
    )
  }
  lines.push('')

  for (const c of result?.captures ?? []) {
    if (c.error) continue
    const findings = sortedFindings(c)
    lines.push(`## ${c.device.label} — ${c.device.width}×${c.device.height}`)
    lines.push('')
    if (!findings.length) {
      lines.push('No findings.')
      lines.push('')
      continue
    }
    for (const f of findings) {
      lines.push(`### ${SEVERITY_LABEL[f.severity]} — ${f.title}`)
      lines.push('')
      lines.push(f.detail)
      if (f.samples.length) {
        lines.push('')
        for (const s of f.samples) {
          const where = `at ${s.rect.x},${s.rect.y} · ${s.rect.width}×${s.rect.height}`
          lines.push(`- \`${s.selector}\` — ${where}${s.text ? ` — "${s.text}"` : ''}`)
        }
      }
      lines.push('')
    }
    if (c.jsErrors.length) {
      lines.push(`**JavaScript errors while loading:**`)
      lines.push('')
      for (const e of c.jsErrors) lines.push(`- \`${e}\``)
      lines.push('')
    }
  }

  return lines.join('\n')
}
