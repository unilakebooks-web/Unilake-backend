import { WebSocketServer, type WebSocket } from "ws";
import type { Server } from "http";
import { logger } from "../lib/logger.js";
import { getOrderSessionId } from "../services/session.service.js";
import { joinRoom, leaveRoom } from "./rooms.js";


export function setupWebSocket(httpServer: Server) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const sessionId = url.searchParams.get("sessionId");
    const token = url.searchParams.get("token");

    if (!sessionId || !token) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    let session;
    try {
      session = await getOrderSessionId(sessionId);
    } catch (error: any) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      logger.error("Coundn't find any session")
      return;
    }

    if (session.wsRoomToken !== token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      logger.error("Token you gave does not match the token in the DB")
      return;
    }


    if (session.isExpired) {
      socket.write("HTTP/1.1 410 Gone\r\n\r\n");
      socket.destroy();
      logger.error("session is expired try again with the new session")
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req, sessionId);
    });
  });

  wss.on("connection", (ws: WebSocket, req : any, sessionId: string) => {
    joinRoom(sessionId, ws);
    logger.info({ sessionId }, "WS connection joined room");

    ws.on("close", () => {
      leaveRoom(sessionId, ws);
      logger.info({ sessionId }, "WS connection left room");
    });

    ws.on("error", (err) => {
      logger.error({ sessionId, err }, "WebSocket connection error");
    });
  });

  wss.on('error', (err) => {
    logger.error({ err }, 'WebSocketServer error');
  });

  return wss;
}
