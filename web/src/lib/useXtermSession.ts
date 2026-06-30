import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

export type TerminalStatus = 'idle' | 'connecting' | 'connected'

/**
 * Drive an xterm.js terminal bridged to the server's `/ws/terminal` pseudo-terminal.
 * The plumbing (xterm instance, fit-on-resize, the WebSocket, and clean teardown)
 * lives here so both the Terminal page and the run "Continue session" panel share
 * one correct implementation — they differ only in the query params they connect
 * with (e.g. `projectId` for a plain shell, `runId` to resume a Claude session).
 *
 * Protocol: server→client frames are raw terminal bytes; client→server frames are
 * JSON control messages ({type:'input'} / {type:'resize'}).
 */
export function useXtermSession(
  getParams: () => Record<string, string>,
  options?: { initialCommand?: string },
) {
  const [status, setStatus] = useState<TerminalStatus>('idle')
  const hostRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  // Keep the latest param-builder + options without making connect()'s identity churn.
  const paramsRef = useRef(getParams)
  const optionsRef = useRef(options)
  useEffect(() => {
    paramsRef.current = getParams
    optionsRef.current = options
  })

  const teardown = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onopen =
        wsRef.current.onclose =
        wsRef.current.onerror =
        wsRef.current.onmessage =
          null
      try {
        wsRef.current.close()
      } catch {
        /* ignore */
      }
      wsRef.current = null
    }
    if (termRef.current) {
      termRef.current.dispose()
      termRef.current = null
    }
    fitRef.current = null
  }, [])

  const disconnect = useCallback(() => {
    teardown()
    setStatus('idle')
  }, [teardown])

  const connect = useCallback(() => {
    if (!hostRef.current || wsRef.current) return
    setStatus('connecting')

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"Google Sans Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: {
        background: '#09090b', // zinc-950, matches the JobLogPanel surface
        foreground: '#e4e4e7',
        cursor: '#e4e4e7',
        selectionBackground: '#3f3f46',
      },
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current)
    fit.fit()
    term.focus()
    termRef.current = term
    fitRef.current = fit

    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const params = new URLSearchParams({
      ...paramsRef.current(),
      cols: String(term.cols),
      rows: String(term.rows),
    })
    const ws = new WebSocket(`${proto}://${location.host}/ws/terminal?${params.toString()}`)
    wsRef.current = ws

    ws.onopen = () => {
      setStatus('connected')
      term.focus()
      // Optionally auto-run a command once the shell is up (e.g. launch Claude).
      // A short delay lets the freshly-spawned login shell print its prompt first,
      // so the command lands on a clean line. `\r` is what Enter sends in a TTY.
      const cmd = optionsRef.current?.initialCommand
      if (cmd) {
        setTimeout(() => {
          if (wsRef.current === ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', data: `${cmd}\r` }))
          }
        }, 500)
      }
    }
    ws.onmessage = (e) => {
      term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer))
    }
    ws.onclose = () => {
      teardown()
      setStatus('idle')
    }
    ws.onerror = () => {
      teardown()
      setStatus('idle')
    }

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }))
      }
    })
    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }))
      }
    })
  }, [teardown])

  // Refit on container resize while connected.
  useEffect(() => {
    if (status === 'idle') return
    const host = hostRef.current
    if (!host) return
    const ro = new ResizeObserver(() => {
      try {
        fitRef.current?.fit()
      } catch {
        /* terminal disposed mid-resize */
      }
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [status])

  // Always tear down on unmount.
  useEffect(() => () => teardown(), [teardown])

  return { hostRef, status, connect, disconnect }
}
