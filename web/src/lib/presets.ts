import { useCallback, useEffect, useState } from 'react'

// A saved run configuration ("template") — apply it to fill the form in one click.
// A single-ticket preset intentionally excludes the ticket id (it changes every
// run). An E2E-flow preset additionally remembers the run mode, model, the flow's
// NAME and its ordered steps, so the whole flow can be re-run.
export interface RunPreset {
  id: string
  name: string
  appUrl: string
  skill: string
  instructions: string
  mode?: 'simple' | 'advanced'
  model?: string
  /**
   * The E2E flow's own title. The run files its report under this name's slug,
   * so a template that restored the steps but not the name used to hand every
   * loaded flow back the default "E2E flow" — and with it the same report slug.
   */
  flowName?: string
  tickets?: string[] // legacy — feature presets saved before flows dropped tickets
  workflowSteps?: string[] // advanced only — the ordered flow, one line per step
  /**
   * Each step's KIND, positionally alongside `workflowSteps`. The run contract is
   * lines only, so without this a loaded flow came back as six identical "Custom
   * step" cards — same run, but not the picture that was saved.
   */
  workflowKinds?: string[]
}

const STORAGE_KEY = 'qc.runPresets'

function newId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `p-${Math.random().toString(36).slice(2)}`
  }
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string')
}

function isPreset(v: unknown): v is RunPreset {
  if (!v || typeof v !== 'object') return false
  const p = v as RunPreset
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof p.appUrl === 'string' &&
    typeof p.skill === 'string' &&
    typeof p.instructions === 'string' &&
    // optional fields — present on advanced/feature presets, absent on older ones
    (p.mode === undefined || p.mode === 'simple' || p.mode === 'advanced') &&
    (p.model === undefined || typeof p.model === 'string') &&
    (p.flowName === undefined || typeof p.flowName === 'string') &&
    (p.tickets === undefined || isStringArray(p.tickets)) &&
    (p.workflowSteps === undefined || isStringArray(p.workflowSteps)) &&
    (p.workflowKinds === undefined || isStringArray(p.workflowKinds))
  )
}

function load(): RunPreset[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isPreset) : []
  } catch {
    return []
  }
}

function save(presets: RunPreset[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets))
  } catch {
    /* storage unavailable */
  }
}

/** Manage saved run presets, persisted to localStorage. */
export function useRunPresets() {
  const [presets, setPresets] = useState<RunPreset[]>(load)

  useEffect(() => {
    save(presets)
  }, [presets])

  const addPreset = useCallback((preset: Omit<RunPreset, 'id'>) => {
    const name = preset.name.trim()
    if (!name) return false
    setPresets((prev) => [...prev, { ...preset, name, id: newId() }])
    return true
  }, [])

  const renamePreset = useCallback((id: string, name: string) => {
    setPresets((prev) => prev.map((p) => (p.id === id ? { ...p, name } : p)))
  }, [])

  const removePreset = useCallback((id: string) => {
    setPresets((prev) => prev.filter((p) => p.id !== id))
  }, [])

  return { presets, addPreset, renamePreset, removePreset }
}
