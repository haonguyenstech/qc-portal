import { useCallback, useEffect, useState } from 'react'

// A reusable "rule" the QC engineer can toggle on the Test cases page. Each one
// adds a coverage instruction (`hint`) to the prompt sent to Claude. Managed and
// persisted on this device so common rules can be curated once and reused.
export interface TestRule {
  id: string
  label: string
  hint: string
}

const STORAGE_KEY = 'qc.testCaseRules'

// Shipped defaults — used on first run and when the user resets.
export const DEFAULT_RULES: TestRule[] = [
  { id: 'happy', label: 'Happy path', hint: 'Cover the main success paths end to end.' },
  {
    id: 'negative',
    label: 'Negative & validation',
    hint: 'Include negative cases: invalid input, required-field and format validation, and rejection messages.',
  },
  {
    id: 'boundary',
    label: 'Boundary values',
    hint: 'Test boundary and edge values (min, max, empty, zero, just-over-limit).',
  },
  {
    id: 'errors',
    label: 'Error handling',
    hint: 'Cover error and exception states: failed requests, timeouts, server errors, and recovery.',
  },
  {
    id: 'permissions',
    label: 'Permissions / roles',
    hint: 'Verify access control per role/permission, including unauthorized-access attempts.',
  },
  {
    id: 'security',
    label: 'Security',
    hint: 'Include security checks: auth, injection/XSS, and sensitive-data exposure.',
  },
  {
    id: 'responsive',
    label: 'Responsive / mobile',
    hint: 'Verify responsive layout and behavior on mobile and desktop breakpoints.',
  },
  {
    id: 'a11y',
    label: 'Accessibility',
    hint: 'Add accessibility cases: keyboard navigation, focus order, labels, and contrast.',
  },
  {
    id: 'data',
    label: 'Data integrity',
    hint: 'Verify data is persisted, updated, and reflected correctly after reload.',
  },
  {
    id: 'i18n',
    label: 'Localization',
    hint: 'Cover localization/formatting: languages, dates, numbers, and currency.',
  },
  {
    id: 'performance',
    label: 'Performance',
    hint: 'Add performance-sensitive cases: large datasets, slow networks, and load.',
  },
]

export function newRuleId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `r-${Math.random().toString(36).slice(2)}`
  }
}

function isRule(v: unknown): v is TestRule {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as TestRule).id === 'string' &&
    typeof (v as TestRule).label === 'string' &&
    typeof (v as TestRule).hint === 'string'
  )
}

function load(): TestRule[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_RULES
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return DEFAULT_RULES
    const valid = parsed.filter(isRule)
    return valid.length ? valid : DEFAULT_RULES
  } catch {
    return DEFAULT_RULES
  }
}

function save(rules: TestRule[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rules))
  } catch {
    /* storage unavailable — keep in memory only */
  }
}

/** Combine the picked rule hints + free text into one instructions string. */
export function buildInstructions(
  rules: TestRule[],
  ruleIds: Set<string>,
  freeText: string,
): string {
  const parts: string[] = []
  const picked = rules.filter((r) => ruleIds.has(r.id))
  if (picked.length) {
    parts.push('Make sure to cover these areas:')
    for (const r of picked) parts.push(`- ${r.hint}`)
  }
  const ft = freeText.trim()
  if (ft) parts.push(parts.length ? `\nAlso: ${ft}` : ft)
  return parts.join('\n')
}

/** Manage the user's reusable test-case rules, persisted to localStorage. */
export function useTestRules() {
  const [rules, setRules] = useState<TestRule[]>(load)

  useEffect(() => {
    save(rules)
  }, [rules])

  const addRule = useCallback((label: string, hint: string) => {
    const entry: TestRule = { id: newRuleId(), label: label.trim(), hint: hint.trim() }
    if (!entry.label || !entry.hint) return false
    setRules((prev) => [...prev, entry])
    return true
  }, [])

  const updateRule = useCallback(
    (id: string, patch: Partial<Pick<TestRule, 'label' | 'hint'>>) => {
      setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
    },
    [],
  )

  const removeRule = useCallback((id: string) => {
    setRules((prev) => prev.filter((r) => r.id !== id))
  }, [])

  const resetRules = useCallback(() => {
    setRules(DEFAULT_RULES)
  }, [])

  return { rules, addRule, updateRule, removeRule, resetRules }
}
