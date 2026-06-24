// Remember the last run-form inputs per project so the QC engineer doesn't
// retype the same URL / skill / notes every time. Stored in localStorage.

export interface LastInputs {
  ticketId: string
  appUrl: string
  skill: string
  instructions: string
}

const PREFIX = 'qc.lastInputs.'

export function loadLastInputs(projectId: string): LastInputs | null {
  try {
    const raw = localStorage.getItem(PREFIX + projectId)
    if (!raw) return null
    const v = JSON.parse(raw)
    if (!v || typeof v !== 'object') return null
    return {
      ticketId: typeof v.ticketId === 'string' ? v.ticketId : '',
      appUrl: typeof v.appUrl === 'string' ? v.appUrl : '',
      skill: typeof v.skill === 'string' ? v.skill : '',
      instructions: typeof v.instructions === 'string' ? v.instructions : '',
    }
  } catch {
    return null
  }
}

export function saveLastInputs(projectId: string, inputs: LastInputs): void {
  try {
    localStorage.setItem(PREFIX + projectId, JSON.stringify(inputs))
  } catch {
    /* storage unavailable */
  }
}

/** True if the string is a valid http(s) URL. Empty string counts as "not yet invalid". */
export function isValidHttpUrl(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  try {
    const u = new URL(trimmed)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}
