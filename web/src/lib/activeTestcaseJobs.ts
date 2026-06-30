// Tracks the active test-case generation jobs per project in localStorage, so a
// browser reload reconnects to still-running server-side jobs and the always-mounted
// <TestCaseJobWatcher/> can announce each one's completion from any page.
//
// The value under `qc.testcaseJob.<projectId>` is a JSON array of job ids — the page
// can now run several generations at once (up to a small parallel cap). A legacy
// plain-string value (a single id from older builds) is still read as a one-element
// list for backward compatibility.

export const ACTIVE_JOB_PREFIX = 'qc.testcaseJob.'

export function loadActiveJobIds(projectId: string | null): string[] {
  if (!projectId) return []
  try {
    const raw = localStorage.getItem(ACTIVE_JOB_PREFIX + projectId)
    if (!raw) return []
    if (raw.startsWith('[')) {
      const arr = JSON.parse(raw)
      return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : []
    }
    return [raw] // legacy single-id value
  } catch {
    return []
  }
}

export function addActiveJobId(projectId: string, jobId: string): void {
  try {
    const ids = loadActiveJobIds(projectId)
    if (!ids.includes(jobId)) ids.push(jobId)
    localStorage.setItem(ACTIVE_JOB_PREFIX + projectId, JSON.stringify(ids))
  } catch {
    /* storage unavailable */
  }
}

export function removeActiveJobId(projectId: string, jobId: string): void {
  try {
    const ids = loadActiveJobIds(projectId).filter((id) => id !== jobId)
    if (ids.length) localStorage.setItem(ACTIVE_JOB_PREFIX + projectId, JSON.stringify(ids))
    else localStorage.removeItem(ACTIVE_JOB_PREFIX + projectId)
  } catch {
    /* storage unavailable */
  }
}
