import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { listProjects } from './api'
import type { Project } from './types'

const STORAGE_KEY = 'qc.activeProjectId'

interface ProjectContextValue {
  projects: Project[]
  activeProject: Project | undefined
  activeProjectId: string | null
  setActiveProjectId: (id: string) => void
  isLoading: boolean
  refetch: () => void
}

const ProjectContext = createContext<ProjectContextValue | null>(null)

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
  })

  const projects = useMemo(() => data ?? [], [data])

  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(() => readStored())

  // Resolve the active id once projects are loaded: keep the stored id if it
  // still exists, otherwise fall back to the default (or first) project.
  // Never fall back while a refetch is in flight — a just-created project's id
  // is valid but not in the stale list yet, and falling back here would undo
  // the auto-activation of a newly created project.
  useEffect(() => {
    if (projects.length === 0 || isFetching) return
    const stored = activeProjectId
    const valid = stored && projects.some((p) => p.id === stored)
    if (valid) return
    const fallback = projects.find((p) => p.isDefault) ?? projects[0]
    if (fallback) {
      setActiveProjectIdState(fallback.id)
      try {
        localStorage.setItem(STORAGE_KEY, fallback.id)
      } catch {
        /* ignore */
      }
    }
  }, [projects, activeProjectId, isFetching])

  const setActiveProjectId = useCallback((id: string) => {
    setActiveProjectIdState(id)
    try {
      localStorage.setItem(STORAGE_KEY, id)
    } catch {
      /* ignore */
    }
  }, [])

  const activeProject = useMemo(
    () => projects.find((p) => p.id === activeProjectId),
    [projects, activeProjectId],
  )

  const value = useMemo<ProjectContextValue>(
    () => ({
      projects,
      activeProject,
      activeProjectId,
      setActiveProjectId,
      isLoading,
      refetch: () => {
        void refetch()
      },
    }),
    [projects, activeProject, activeProjectId, setActiveProjectId, isLoading, refetch],
  )

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
}

export function useProjects(): ProjectContextValue {
  const ctx = useContext(ProjectContext)
  if (!ctx) throw new Error('useProjects must be used within a ProjectProvider')
  return ctx
}
