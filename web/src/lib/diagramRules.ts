import { useCallback, useEffect, useState } from 'react'
import type { TestRule } from './testRules'

// Reusable diagram instruction presets. Structurally identical to a TestRule
// (id / label / hint) so the shared ManageRulesDialog + chip UI can be reused.
// Each toggled chip adds its `hint` to the instructions sent to the diagram model.
export type DiagramRule = TestRule

const STORAGE_KEY = 'qc.diagramRules'

// Shipped defaults — used on first run and when the user resets.
export const DEFAULT_DIAGRAM_RULES: DiagramRule[] = [
  {
    id: 'user-flows',
    label: 'User flows',
    hint: 'Emphasize end-to-end user flows: how a user moves from screen to screen to complete each task.',
  },
  {
    id: 'group-features',
    label: 'Group by feature',
    hint: 'Group related screens and steps into subgraphs, one per feature or functional area.',
  },
  {
    id: 'screens',
    label: 'Screens & pages',
    hint: 'Model the actual screens/pages as nodes and the navigation between them as edges.',
  },
  {
    id: 'roles',
    label: 'Roles / actors',
    hint: 'Distinguish the different user roles/actors and show which flows each one can reach.',
  },
  {
    id: 'data-flow',
    label: 'Data flow',
    hint: 'Show how data moves between the main components (inputs, processing, storage, outputs).',
  },
  {
    id: 'states',
    label: 'States & status',
    hint: 'Capture important state transitions (e.g. draft → submitted → approved) where they matter.',
  },
  {
    id: 'integrations',
    label: 'Integrations',
    hint: 'Include external systems and integrations the project talks to, as clearly-labeled nodes.',
  },
  {
    id: 'happy-only',
    label: 'Happy path only',
    hint: 'Keep the diagram focused on the main success path; omit error and edge-case branches.',
  },
  {
    id: 'concise',
    label: 'Keep it concise',
    hint: 'Favor a small, readable diagram (around 6–12 nodes) over exhaustive detail.',
  },
]

function newRuleId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `d-${Math.random().toString(36).slice(2)}`
  }
}

function isRule(v: unknown): v is DiagramRule {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as DiagramRule).id === 'string' &&
    typeof (v as DiagramRule).label === 'string' &&
    typeof (v as DiagramRule).hint === 'string'
  )
}

function load(): DiagramRule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_DIAGRAM_RULES
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return DEFAULT_DIAGRAM_RULES
    const valid = parsed.filter(isRule)
    return valid.length ? valid : DEFAULT_DIAGRAM_RULES
  } catch {
    return DEFAULT_DIAGRAM_RULES
  }
}

function save(rules: DiagramRule[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rules))
  } catch {
    /* storage unavailable — keep in memory only */
  }
}

/** Combine the picked preset hints + free text into one instructions string. */
export function buildDiagramInstructions(
  rules: DiagramRule[],
  ruleIds: Set<string>,
  freeText: string,
): string {
  const parts: string[] = []
  const picked = rules.filter((r) => ruleIds.has(r.id))
  if (picked.length) {
    parts.push('Follow these guidelines:')
    for (const r of picked) parts.push(`- ${r.hint}`)
  }
  const ft = freeText.trim()
  if (ft) parts.push(parts.length ? `\nAlso: ${ft}` : ft)
  return parts.join('\n')
}

/** Manage the user's reusable diagram presets, persisted to localStorage. */
export function useDiagramRules() {
  const [rules, setRules] = useState<DiagramRule[]>(load)

  useEffect(() => {
    save(rules)
  }, [rules])

  const addRule = useCallback((label: string, hint: string) => {
    const entry: DiagramRule = { id: newRuleId(), label: label.trim(), hint: hint.trim() }
    if (!entry.label || !entry.hint) return false
    setRules((prev) => [...prev, entry])
    return true
  }, [])

  const updateRule = useCallback(
    (id: string, patch: Partial<Pick<DiagramRule, 'label' | 'hint'>>) => {
      setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    },
    [],
  )

  const removeRule = useCallback((id: string) => {
    setRules((prev) => prev.filter((r) => r.id !== id))
  }, [])

  const resetRules = useCallback(() => {
    setRules(DEFAULT_DIAGRAM_RULES)
  }, [])

  return { rules, addRule, updateRule, removeRule, resetRules }
}
