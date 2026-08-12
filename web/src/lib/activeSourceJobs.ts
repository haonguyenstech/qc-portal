// Tracks the active source clone/sync jobs per project in localStorage, so a
// browser reload reconnects to still-running server-side jobs and the always-mounted
// <SourceJobWatcher/> can announce each one's completion from any page.
//
// The value under `qc.sourceJob.<projectId>` is a JSON array of job ids — a project's
// repos (backend / web / mobile) sync CONCURRENTLY, so several can be in flight at
// once. A legacy plain-string value (a single id from older builds) is still read as
// a one-element list. Mirrors lib/activeTestcaseJobs.ts.

export const ACTIVE_JOB_PREFIX = 'qc.sourceJob.'

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
