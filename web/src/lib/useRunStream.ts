import { useEffect, useMemo, useRef, useState } from 'react'
import type { LogEvent, Phase, StreamMessage } from './types'

export interface RunStream {
  events: LogEvent[]
  connected: boolean
  phase: Phase | null
}

export function useRunStream(runId: string | null): RunStream {
  const [events, setEvents] = useState<LogEvent[]>([])
  const [connected, setConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!runId) return

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)
    wsRef.current = ws

    ws.onopen = () => {
      setConnected(true)
      ws.send(JSON.stringify({ subscribe: runId }))
    }
    ws.onclose = () => setConnected(false)
    ws.onerror = () => setConnected(false)
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as StreamMessage
        if (msg.runId === runId && msg.event) {
          setEvents((prev) => [...prev, msg.event])
        }
      } catch {
        // ignore malformed frames
      }
    }

    return () => {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null
      ws.close()
      wsRef.current = null
      setEvents([])
      setConnected(false)
    }
  }, [runId])

  const phase = useMemo<Phase | null>(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const p = events[i].phase
      if (p) return p
    }
    return null
  }, [events])

  return { events, connected, phase }
}
