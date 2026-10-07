import type { WebSocket } from "ws";

const rooms = new Map<string, Set<WebSocket>>();

export function joinRoom(sessionId: string, ws: WebSocket) {
  if (!rooms.has(sessionId)) {
    rooms.set(sessionId, new Set());
  }

  rooms.get(sessionId)!.add(ws);
}

export function leaveRoom(sessionId: string, ws: WebSocket) {
  const room = rooms.get(sessionId);
  if (room) {
    room.delete(ws);
    if (room.size === 0) {
      rooms.delete(sessionId);
    }
  }
}

export function getRoom(sessionId: string): Set<WebSocket> | undefined {
  return rooms.get(sessionId);
}