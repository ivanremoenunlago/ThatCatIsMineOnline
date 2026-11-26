import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import { matchMaker, Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { isValidRoomCode, normalizeRoomCode, type PublicRoomListing } from "../shared/game-types.js";
import { GameRoom } from "./game/game-room.js";
import {
  accountForToken,
  authenticate,
  listRecentMatches,
  listTestAccounts,
  updateAccountTheme,
} from "./data/store.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));
app.use((request, response, next) => {
  const origin = request.headers.origin;
  if (origin && /^http:\/\/(127\.0\.0\.1|localhost):5173$/.test(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }
  next();
});

app.get("/api/health", (_request, response) => response.json({ status: "ok" }));
app.get("/api/accounts", (_request, response) => response.json({ accounts: listTestAccounts() }));
app.get("/api/history", (_request, response) => response.json({ matches: listRecentMatches() }));
app.get("/api/rooms", async (_request, response, next) => {
  try {
    const rooms = await matchMaker.query({ name: "game" });
    const publicRooms: PublicRoomListing[] = rooms.flatMap((room) => {
      const metadata = room.metadata;
      const roomCode = metadata?.roomCode;
      if (room.private || metadata?.status !== "lobby" || typeof roomCode !== "string") return [];
      return [{
        roomId: room.roomId,
        roomCode,
        creatorName: typeof metadata.creatorName === "string" ? metadata.creatorName : "Anfitrión",
        playerCount: room.clients,
        maxPlayers: typeof metadata.maxPlayers === "number" ? metadata.maxPlayers : room.maxClients,
        autoStartAt: typeof metadata.autoStartAt === "number" ? metadata.autoStartAt : null,
      }];
    })
      .sort((left, right) => left.playerCount - right.playerCount || left.creatorName.localeCompare(right.creatorName));
    response.json({ rooms: publicRooms });
  } catch (error) {
    next(error);
  }
});
app.post("/api/rooms/resolve", async (request, response, next) => {
  const rawCode = request.body?.code;
  const code = typeof rawCode === "string" ? normalizeRoomCode(rawCode) : "";
  if (!isValidRoomCode(code)) {
    response.status(400).json({ error: "El código debe tener 4 letras o números." });
    return;
  }
  try {
    const rooms = await matchMaker.query({ name: "game" });
    const room = rooms.find((candidate) =>
      candidate.metadata?.roomCode === code && candidate.metadata?.status === "lobby",
    );
    if (!room) {
      response.status(404).json({ error: "No hay ninguna sala abierta con ese código." });
      return;
    }
    if (room.clients >= room.maxClients || room.locked) {
      response.status(409).json({ error: "La sala está llena o ya no admite jugadores." });
      return;
    }
    response.json({ roomId: room.roomId, roomCode: code });
  } catch (error) {
    next(error);
  }
});
app.post("/api/login", (request, response) => {
  const result = authenticate(request.body?.username, request.body?.password);
  if (!result) {
    response.status(401).json({ error: "Usuario o contraseña incorrectos." });
    return;
  }
  response.json(result);
});
app.post("/api/preferences/theme", (request, response) => {
  if (request.body?.theme !== "light" && request.body?.theme !== "dark") {
    response.status(400).json({ error: "El tema elegido no es válido." });
    return;
  }
  const account = accountForToken(request.body?.token);
  if (!account) {
    response.status(401).json({ error: "La sesión ha caducado. Vuelve a iniciar sesión." });
    return;
  }
  updateAccountTheme(account.id, request.body.theme);
  response.json({ theme: request.body.theme });
});

const clientDirectory = resolve(process.cwd(), "dist", "client");
app.use(express.static(clientDirectory));
app.get("/{*path}", (_request, response, next) => {
  response.sendFile(resolve(clientDirectory, "index.html"), (error) => {
    if (error) next(error);
  });
});
app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  console.error(error);
  response.status(500).json({ error: "Error interno del servidor." });
});

async function startServer(): Promise<void> {
  const apiPort = Number(process.env.HTTP_PORT ?? 2568);
  const gamePort = Number(process.env.GAME_PORT ?? 2567);
  app.listen(apiPort, "127.0.0.1", () => {
    console.log(`HTTP API ready at http://127.0.0.1:${apiPort}`);
  });

  const gameServer = new Server({
    transport: new WebSocketTransport({ server: createServer() }),
  });
  gameServer.define("game", GameRoom);
  await gameServer.listen(gamePort, "127.0.0.1");
  console.log(`Game server ready at ws://127.0.0.1:${gamePort}`);
}

startServer().catch((error: unknown) => {
  console.error("Could not start the game server.", error);
  process.exitCode = 1;
});
