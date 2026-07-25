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
/** The server closes a socket with this code when another window attaches to its session. */
export const WS_CLOSE_TAKEN_OVER = 4001

export function useXtermSession(
  getParams: () => Record<string, string>,
  options?: {
    initialCommand?: string
    /** Called when the socket closes, with the WebSocket close code. */
    onClosed?: (code: number) => void
  },
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

  /**
   * End the session for good. The server keeps a shell running when its socket
   * merely closes (so leaving the page doesn't kill it), so an explicit Disconnect
   * has to say so — `{type:'kill'}` — before we tear the socket down.
   */
  const disconnect = useCallback(() => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'kill' }))
      } catch {
        /* socket already going away */
      }
    }
    teardown()
    setStatus('idle')
  }, [teardown])

  // Inject text into the live shell as if typed (no trailing Enter, so the user can
  // review/edit before submitting). Used by the Terminal page's slash-command picker.
  const sendText = useCallback((text: string) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data: text }))
      termRef.current?.focus()
    }
  }, [])

  /**
   * Open (or re-open) the terminal. Pass `reattach` when the server already has a
   * live session for these params: the shell is picked up where it was left, so the
   * `initialCommand` must NOT be replayed — it would be typed into whatever is
   * already running in there.
   */
  /** Put the caret in this terminal — used when switching between terminal tabs. */
  const focus = useCallback(() => {
    termRef.current?.focus()
  }, [])

  const connect = useCallback((opts?: { reattach?: boolean }) => {
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
    // Windows/Linux clipboard: xterm handles the Ctrl+V keydown itself — it
    // sends the ^V control byte to the shell and preventDefaults the browser's
    // native paste, so nothing is ever pasted. Returning false here makes xterm
    // skip the keydown, letting the native paste event reach its textarea (which
    // xterm does handle). Ctrl+Shift+C copies the selection (plain Ctrl+C must
    // stay SIGINT). macOS is untouched — Cmd+V/Cmd+C already work natively, and
    // Ctrl+V there is a real shell keybinding (literal-next).
    const isMac = /mac/i.test(navigator.platform)
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown' || isMac) return true
      const key = ev.key.toLowerCase()
      if (ev.ctrlKey && !ev.altKey && key === 'v') return false
      if (ev.ctrlKey && ev.shiftKey && key === 'c') {
        const sel = term.getSelection()
        if (sel) {
          void navigator.clipboard?.writeText(sel).catch(() => {})
          return false
        }
      }
      return true
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
      const cmd = opts?.reattach ? undefined : optionsRef.current?.initialCommand
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
    ws.onclose = (e) => {
      teardown()
      setStatus('idle')
      optionsRef.current?.onClosed?.(e.code)
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

  // Unmount (navigating away) closes the socket WITHOUT killing the shell — the
  // server detaches and keeps it running, and the next connect() re-attaches.
  // `setStatus('idle')` is a no-op on a real unmount, but it matters when React
  // re-mounts the same instance (StrictMode in dev): status must reflect that the
  // socket is gone, or a status-driven re-connect would never fire.
  useEffect(
    () => () => {
      teardown()
      setStatus('idle')
    },
    [teardown],
  )

  return { hostRef, status, connect, disconnect, sendText, focus }
}
