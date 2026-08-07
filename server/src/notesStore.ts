import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { testingDirFor } from './config.js'

export interface WorkspaceNote {
  id: string
  title: string
  body: string
  labels: string[]
  archived: boolean
  trashed: boolean
  createdAt: string
  updatedAt: string
}

export interface NotesFile {
  labels: string[]
  notes: WorkspaceNote[]
  seededDefaults: boolean
}

const MAX_NOTES = 500
const MAX_TITLE = 200
const MAX_BODY = 100_000
const DEFAULT_LABELS = ['Family', 'Tasks', 'Personal', 'Meetings', 'Shopping', 'Planning', 'Travel']
const DEFAULT_NOTE_DEFS = [
  {
    id: 'default-project-notes',
    title: 'Project Notes',
    body: 'Capture useful project context, decisions, and follow-up ideas here.',
    labels: ['Personal'],
  },
  {
    id: 'default-weekly-planning',
    title: 'Weekly Planning',
    body: 'Review open work, prioritize the next release, and record anything that needs attention.',
    labels: ['Planning'],
  },
  {
    id: 'default-testing-reminders',
    title: 'Testing Reminders',
    body: 'Keep short reminders for regression coverage, environments, and checks to repeat before release.',
    labels: ['Tasks'],
  },
]

export function notesDir(root: string): string {
  return path.join(testingDirFor(root), 'notes')
}

function notesFile(root: string): string {
  return path.join(notesDir(root), 'notes.json')
}

function blank(): NotesFile {
  return { labels: [...DEFAULT_LABELS], notes: [], seededDefaults: false }
}

function normalize(raw: unknown): NotesFile {
  if (!raw || typeof raw !== 'object') return blank()
  const input = raw as { labels?: unknown; notes?: unknown; seededDefaults?: unknown }
  const labels = Array.isArray(input.labels)
    ? input.labels.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim()).slice(0, 100)
    : []
  const notes = Array.isArray(input.notes)
    ? input.notes.filter((value): value is WorkspaceNote => {
        if (!value || typeof value !== 'object') return false
        const note = value as Partial<WorkspaceNote>
        return typeof note.id === 'string' && typeof note.title === 'string' && typeof note.body === 'string'
      }).map((note) => ({
        id: note.id,
        title: note.title.slice(0, MAX_TITLE),
        body: note.body.slice(0, MAX_BODY),
        labels: Array.isArray(note.labels) ? note.labels.filter((value): value is string => typeof value === 'string').slice(0, 20) : [],
        archived: note.archived === true,
        trashed: note.trashed === true,
        createdAt: typeof note.createdAt === 'string' ? note.createdAt : new Date().toISOString(),
        updatedAt: typeof note.updatedAt === 'string' ? note.updatedAt : new Date().toISOString(),
      })).slice(0, MAX_NOTES)
    : []
  return { labels: [...new Set(labels)], notes, seededDefaults: input.seededDefaults === true }
}

export function readNotes(root: string): NotesFile {
  try {
    const data = normalize(JSON.parse(fs.readFileSync(notesFile(root), 'utf8')))
    if (!data.seededDefaults) {
      const now = new Date().toISOString()
      data.notes.push(...DEFAULT_NOTE_DEFS.map((note) => ({ ...note, archived: false, trashed: false, createdAt: now, updatedAt: now })))
      data.seededDefaults = true
      writeNotes(root, data)
    }
    return data
  } catch {
    const now = new Date().toISOString()
    const data = {
      ...blank(),
      notes: DEFAULT_NOTE_DEFS.map((note) => ({ ...note, archived: false, trashed: false, createdAt: now, updatedAt: now })),
      seededDefaults: true,
    }
    writeNotes(root, data)
    return data
  }
}

function writeNotes(root: string, data: NotesFile): void {
  const dir = notesDir(root)
  fs.mkdirSync(dir, { recursive: true })
  const target = notesFile(root)
  const temp = `${target}.tmp-${process.pid}`
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, target)
}

export function createNote(root: string, input: { title: string; body: string; label?: string }): WorkspaceNote {
  const data = readNotes(root)
  if (data.notes.length >= MAX_NOTES) throw new Error('notes limit reached')
  const title = input.title.trim()
  const body = (input.body ?? '').trim()
  if (!title) throw new Error('title is required')
  if (title.length > MAX_TITLE || body.length > MAX_BODY) throw new Error('note is too large')
  const now = new Date().toISOString()
  const note: WorkspaceNote = {
    id: crypto.randomUUID(),
    title,
    body,
    labels: input.label?.trim() ? [input.label.trim()] : [],
    archived: false,
    trashed: false,
    createdAt: now,
    updatedAt: now,
  }
  data.notes.unshift(note)
  writeNotes(root, data)
  return note
}

export function updateNote(root: string, id: string, patch: Partial<Pick<WorkspaceNote, 'title' | 'body' | 'labels' | 'archived' | 'trashed'>>): WorkspaceNote | null {
  const data = readNotes(root)
  const note = data.notes.find((item) => item.id === id)
  if (!note) return null
  if (patch.title !== undefined) {
    const title = patch.title.trim()
    if (!title || title.length > MAX_TITLE) throw new Error('invalid title')
    note.title = title
  }
  if (patch.body !== undefined) {
    const body = (patch.body ?? '').trim()
    if (body.length > MAX_BODY) throw new Error('invalid note body')
    note.body = body
  }
  if (patch.labels !== undefined) note.labels = [...new Set(patch.labels.filter((label) => typeof label === 'string' && label.trim()).map((label) => label.trim()))]
  if (patch.archived !== undefined) note.archived = patch.archived
  if (patch.trashed !== undefined) note.trashed = patch.trashed
  note.updatedAt = new Date().toISOString()
  writeNotes(root, data)
  return note
}

export function deleteNote(root: string, id: string): boolean {
  const data = readNotes(root)
  const before = data.notes.length
  data.notes = data.notes.filter((note) => note.id !== id)
  if (data.notes.length === before) return false
  writeNotes(root, data)
  return true
}

export function emptyTrash(root: string): number {
  const data = readNotes(root)
  const before = data.notes.length
  data.notes = data.notes.filter((note) => !note.trashed)
  const removed = before - data.notes.length
  if (removed > 0) writeNotes(root, data)
  return removed
}

export function addLabel(root: string, rawName: string): string {
  const name = rawName.trim().replace(/\s+/g, ' ').slice(0, 40)
  if (!name) throw new Error('label is required')
  const data = readNotes(root)
  const existing = data.labels.find((label) => label.toLowerCase() === name.toLowerCase())
  if (existing) return existing
  data.labels.push(name)
  writeNotes(root, data)
  return name
}

export function removeLabel(root: string, rawName: string): boolean {
  const name = rawName.trim()
  const data = readNotes(root)
  const before = data.labels.length
  data.labels = data.labels.filter((label) => label.toLowerCase() !== name.toLowerCase())
  if (data.labels.length === before) return false
  const now = new Date().toISOString()
  data.notes = data.notes.map((note) => {
    const labels = note.labels.filter((label) => label.toLowerCase() !== name.toLowerCase())
    return labels.length === note.labels.length ? note : { ...note, labels, updatedAt: now }
  })
  writeNotes(root, data)
  return true
}

export function renameLabel(root: string, rawOldName: string, rawNewName: string): boolean {
  const oldName = rawOldName.trim()
  const newName = rawNewName.trim().replace(/\s+/g, ' ').slice(0, 40)
  if (!oldName || !newName) throw new Error('label is required')
  const data = readNotes(root)
  const index = data.labels.findIndex((label) => label.toLowerCase() === oldName.toLowerCase())
  if (index < 0) return false
  if (data.labels.some((label, labelIndex) => labelIndex !== index && label.toLowerCase() === newName.toLowerCase())) {
    throw new Error('label already exists')
  }
  const actualOldName = data.labels[index]
  data.labels[index] = newName
  const now = new Date().toISOString()
  data.notes = data.notes.map((note) => {
    const labels = note.labels.map((label) => label.toLowerCase() === actualOldName.toLowerCase() ? newName : label)
    return labels.some((label, labelIndex) => label !== note.labels[labelIndex])
      ? { ...note, labels, updatedAt: now }
      : note
  })
  writeNotes(root, data)
  return true
}
