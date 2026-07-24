import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Plug, TriangleAlert } from 'lucide-react'
import { listMcp } from '@/lib/api'
import { useProjects } from '@/lib/project-context'

/** Friendly labels for the canonical .mcp.json server names. */
const SERVER_LABELS: Record<string, string> = {
  clickup: 'ClickUp',
  figma: 'Figma',
  playwright: 'Playwright',
  'mobile-mcp': 'Mobile',
  'appium-mcp': 'Appium',
}

function labelFor(name: string): string {
  return SERVER_LABELS[name] ?? name
}

function joinNames(names: string[], conj: 'and' | 'or' = 'and'): string {
  if (names.length <= 1) return names.join('')
  if (names.length === 2) return `${names[0]} ${conj} ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, ${conj} ${names[names.length - 1]}`
}

/**
 * Informative banner shown on a feature page when the active project is missing
 * the MCP server(s) that feature needs — it can't run until they're configured.
 * Renders nothing while loading, when no project is selected, or once all the
 * required servers are present in the project's .mcp.json. Shares the
 * `['mcp', projectId]` query cache with the MCP page, so it updates as soon as a
 * server is added there.
 */
export function McpRequiredNotice({
  required,
  feature,
  anyOf = false,
}: {
  /** Canonical server names the feature needs (e.g. ['clickup']). */
  required: string[]
  /** Short feature name, e.g. "crawl tickets" or "Design Check". */
  feature: string
  /**
   * When true, ANY ONE of `required` satisfies the feature (e.g. a mobile run
   * needs Mobile MCP *or* Appium). The notice then shows only if NONE are
   * present, and lists the options with "or". Default false = all are required.
   */
  anyOf?: boolean
}) {
  const { activeProjectId } = useProjects()
  const { data: servers } = useQuery({
    queryKey: ['mcp', activeProjectId],
    queryFn: () => listMcp(activeProjectId as string),
    enabled: !!activeProjectId,
  })

  // Don't flash the warning before we know the project's MCP setup.
  if (!activeProjectId || !servers) return null

  const configured = new Set(servers.map((s) => s.name))
  // any-of: satisfied if at least one is configured → nothing "missing" then.
  // all-of: every server that isn't configured is missing.
  const missing =
    anyOf && required.some((name) => configured.has(name))
      ? []
      : required.filter((name) => !configured.has(name))
  if (missing.length === 0) return null

  const labels = missing.map(labelFor)

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-amber-300/60 bg-amber-50/60 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between dark:bg-amber-950/20">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
          <TriangleAlert className="size-4" />
        </span>
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-semibold tracking-tight text-amber-900 dark:text-amber-200">
            Configure MCP to {feature}
          </p>
          <p className="text-xs leading-relaxed text-amber-800/90 dark:text-amber-300/80">
            {anyOf ? (
              <>
                This project hasn't set up a{' '}
                <span className="font-medium">{joinNames(labels, 'or')}</span> server yet — add
                either one on the MCP page, then come back.
              </>
            ) : (
              <>
                This project hasn't set up the{' '}
                <span className="font-medium">{joinNames(labels)}</span>{' '}
                {missing.length === 1 ? 'server' : 'servers'} yet — add{' '}
                {missing.length === 1 ? 'it' : 'them'} on the MCP page, then come back.
              </>
            )}
          </p>
        </div>
      </div>
      <Link
        to="/mcp"
        className="inline-flex shrink-0 items-center justify-center gap-1.5 self-start rounded-full bg-amber-600 px-4 py-2 text-xs font-semibold text-white transition-all duration-200 hover:bg-amber-700 hover:shadow-sm active:scale-[0.98] sm:self-auto"
      >
        <Plug className="size-3.5" />
        Configure MCP
        <ArrowRight className="size-3.5" />
      </Link>
    </div>
  )
}

export default McpRequiredNotice
