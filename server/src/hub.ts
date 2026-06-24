import type { WebSocket } from 'ws'
import type { StreamMessage } from './types.js'

// runId -> set of subscribed sockets
const rooms = new Map<string, Set<WebSocket>>()
// reverse lookup so we can clean up on close
const socketRooms = new Map<WebSocket, Set<string>>()

export function subscribe(runId: string, ws: WebSocket): void {
  let room = rooms.get(runId)
  if (!room) {
    room = new Set()
    rooms.set(runId, room)
  }
  room.add(ws)

  let mine = socketRooms.get(ws)
  if (!mine) {
    mine = new Set()
    socketRooms.set(ws, mine)
  }
  mine.add(runId)
}

export function unsubscribe(ws: WebSocket): void {
  const mine = socketRooms.get(ws)
  if (!mine) return
  for (const runId of mine) {
    const room = rooms.get(runId)
    if (room) {
      room.delete(ws)
      if (room.size === 0) rooms.delete(runId)
    }
  }
  socketRooms.delete(ws)
}

export function broadcast(runId: string, message: StreamMessage): void {
  const room = rooms.get(runId)
  if (!room || room.size === 0) return
  const payload = JSON.stringify(message)
  for (const ws of room) {
    try {
      ws.send(payload)
    } catch {
      /* socket gone; will be cleaned up on close */
    }
  }
}
