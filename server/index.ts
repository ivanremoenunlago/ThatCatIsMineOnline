import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
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
