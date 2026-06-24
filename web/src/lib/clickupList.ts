// Per-project ClickUp List binding. When set, the ticket picker pulls tasks
// straight from this list (complete & accurate) instead of searching recent
// tasks across the whole workspace. Stored per device, keyed by project id.

export interface ListBinding {
  team: string
  teamName: string
  listId: string
  listName: string
  folderName: string | null
}

const PREFIX = 'qc.clickupList.'

export function loadListBinding(projectId: string): ListBinding | null {
  try {
    const raw = localStorage.getItem(PREFIX + projectId)
    if (!raw) return null
    const v = JSON.parse(raw)
    if (!v || typeof v.listId !== 'string' || !v.listId) return null
    return {
      team: String(v.team ?? ''),
      teamName: String(v.teamName ?? ''),
      listId: String(v.listId),
      listName: String(v.listName ?? v.listId),
      folderName: v.folderName ? String(v.folderName) : null,
    }
  } catch {
    return null
  }
}

export function saveListBinding(projectId: string, binding: ListBinding): void {
  try {
    localStorage.setItem(PREFIX + projectId, JSON.stringify(binding))
  } catch {
    /* storage unavailable */
  }
}

export function clearListBinding(projectId: string): void {
  try {
    localStorage.removeItem(PREFIX + projectId)
  } catch {
    /* ignore */
  }
}
