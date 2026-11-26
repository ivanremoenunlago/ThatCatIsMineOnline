import { Room, type Client } from "@colyseus/core";
import type { GameCommand, GameState } from "../../shared/game-types.js";
import { accountForToken, recordMatch, type Account } from "../data/store.js";
import {
  applyGameCommand,
  createGame,
  expireCombatDefense as expireCombatDefenseCommand,
  type PlayerSeat,
} from "./game-engine.js";
import { projectPrivateState, projectPublicState } from "./projections.js";

export class GameRoom extends Room {
  private readonly seats = new Map<string, Account>();
  private gameState: GameState | null = null;
  private recordedWinnerId: string | null = null;
  private responseTimeout: ReturnType<typeof setTimeout> | null = null;
  private combatTimeout: ReturnType<typeof setTimeout> | null = null;
  private presenceInterval: ReturnType<typeof setInterval> | null = null;
  private readonly waitingSince = new Map<string, number>();

  onCreate(): void {
    this.maxClients = 5;
    this.onMessage("refresh", (client: Client) => {
      if (this.gameState) {
        client.send("public-state", projectPublicState(this.gameState));
        client.send("private-state", projectPrivateState(this.gameState, this.getSeat(client).id));
      } else {
        client.send("lobby", this.lobbyState());
      }
    });
    this.onMessage("start-game", (client: Client) => this.startGame(client));
    this.onMessage("command", (client: Client, message: unknown) => this.receiveCommand(client, message));
    this.presenceInterval = setInterval(() => this.publishPresence(), 1_000);
  }

  onJoin(client: Client, options: { token?: string }): void {
    if (this.gameState) throw new Error("La partida ya ha comenzado.");
    const account = accountForToken(options.token);
    if (!account) throw new Error("La sesión ha caducado. Vuelve a iniciar sesión.");
    if ([...this.seats.values()].some((seat) => seat.id === account.id)) {
      throw new Error("Esta cuenta ya está en la sala.");
    }
    this.seats.set(client.sessionId, account);
    this.publishLobby(client);
  }

  onLeave(client: Client): void {
    const account = this.seats.get(client.sessionId);
    this.seats.delete(client.sessionId);
    if (this.gameState) {
      this.broadcast("notice", `${account?.username ?? "Un jugador"} se ha desconectado.`);
    } else {
      this.publishLobby();
    }
  }

  onDispose(): void {
    if (this.responseTimeout) clearTimeout(this.responseTimeout);
    this.responseTimeout = null;
    if (this.combatTimeout) clearTimeout(this.combatTimeout);
    this.combatTimeout = null;
    if (this.presenceInterval) clearInterval(this.presenceInterval);
    this.presenceInterval = null;
  }

  private getSeat(client: Client): Account {
    const account = this.seats.get(client.sessionId);
    if (!account) throw new Error("No perteneces a esta sala.");
    return account;
  }

  private publishLobby(excludedClient?: Client): void {
    const state = this.lobbyState();
    if (!excludedClient) {
      this.broadcast("lobby", state);
      return;
    }
    for (const client of this.clients) {
      if (client !== excludedClient) client.send("lobby", state);
    }
  }

  private lobbyState(): { players: Array<{ id: string; name: string }>; hostId: string | null; minPlayers: number; maxPlayers: number } {
    const players = [...this.seats.values()].map(({ id, username }) => ({ id, name: username }));
    return { players, hostId: players[0]?.id ?? null, minPlayers: 2, maxPlayers: this.maxClients };
  }

  private startGame(client: Client): void {
    try {
      const account = this.getSeat(client);
      if (this.gameState) throw new Error("La partida ya ha comenzado.");
      if ([...this.seats.values()][0]?.id !== account.id) throw new Error("Solo quien creó la sala puede empezar.");
      if (this.seats.size < 2) throw new Error("Se necesitan al menos 2 jugadores.");
      const seats: PlayerSeat[] = [...this.seats.values()].map(({ id, username }) => ({ id, name: username }));
      this.gameState = createGame(this.roomId, seats);
      const now = Date.now();
      for (const seat of seats) this.waitingSince.set(seat.id, now);
      this.lock();
      this.publishGame();
    } catch (error) {
      client.send("error", errorMessage(error));
    }
  }

  private receiveCommand(client: Client, message: unknown): void {
    try {
      const account = this.getSeat(client);
      if (!this.gameState) throw new Error("La partida todavía no ha comenzado.");
      if (!isGameCommand(message)) throw new Error("Comando de juego no válido.");
      const nextState = applyGameCommand(this.gameState, account.id, message);
      this.waitingSince.set(account.id, Date.now());
      this.recordWinnerIfNeeded(nextState);
      this.gameState = nextState;
      this.publishGame();
    } catch (error) {
      client.send("error", errorMessage(error));
    }
  }

  private publishGame(): void {
    if (!this.gameState) return;
    this.scheduleResponseTimeout();
    this.scheduleCombatTimeout();
    const publicState = projectPublicState(this.gameState);
    const waiting = new Set(publicState.waitingPlayerIds);
    for (const playerId of this.waitingSince.keys()) {
      if (!waiting.has(playerId)) this.waitingSince.delete(playerId);
    }
    for (const playerId of waiting) {
      if (!this.waitingSince.has(playerId)) this.waitingSince.set(playerId, Date.now());
    }
    this.broadcast("public-state", publicState);
    for (const client of this.clients) {
      const account = this.seats.get(client.sessionId);
      if (account) client.send("private-state", projectPrivateState(this.gameState, account.id));
    }
    this.publishPresence();
  }

  private scheduleResponseTimeout(): void {
    if (this.responseTimeout) clearTimeout(this.responseTimeout);
    this.responseTimeout = null;
    const expiresAt = this.gameState?.responseWindow?.expiresAt;
    if (expiresAt === undefined) return;
    this.responseTimeout = setTimeout(() => this.expireResponse(expiresAt), Math.max(0, expiresAt - Date.now()));
  }

  private expireResponse(expiresAt: number): void {
    this.responseTimeout = null;
    const state = this.gameState;
    const window = state?.responseWindow;
    if (!state || !window || window.expiresAt !== expiresAt) return;
    if (expiresAt > Date.now()) {
      this.scheduleResponseTimeout();
      return;
    }
    const playerId = window.order[window.cursor];
    if (!playerId) {
      console.error("Expired response window has no current recipient.");
      return;
    }
    try {
      this.gameState = applyGameCommand(state, playerId, { type: "pass-response" });
      this.publishGame();
    } catch (error) {
      console.error("Could not auto-pass an expired response window.", error);
      this.broadcast("error", errorMessage(error));
    }
  }

  private scheduleCombatTimeout(): void {
    if (this.combatTimeout) clearTimeout(this.combatTimeout);
    this.combatTimeout = null;
    const combat = this.gameState?.combat;
    if (!combat || combat.defenseExpiresAt === null || this.gameState?.responseWindow) return;
    const { targetPlayerId, defenseExpiresAt } = combat;
    this.combatTimeout = setTimeout(
      () => this.expireCombatTimeout(targetPlayerId, defenseExpiresAt),
      Math.max(0, defenseExpiresAt - Date.now()),
    );
  }

  private expireCombatTimeout(playerId: string, expectedExpiresAt: number): void {
    this.combatTimeout = null;
    const state = this.gameState;
    if (!state) return;
    if (state.combat?.defenseExpiresAt !== expectedExpiresAt) return;
    if (expectedExpiresAt > Date.now()) {
      this.scheduleCombatTimeout();
      return;
    }
    try {
      const nextState = expireCombatDefenseCommand(state, playerId, expectedExpiresAt);
      if (!nextState) return;
      this.recordWinnerIfNeeded(nextState);
      this.gameState = nextState;
      this.publishGame();
    } catch (error) {
      console.error("Could not auto-accept an expired attack.", error);
      this.broadcast("error", errorMessage(error));
    }
  }

  private publishPresence(): void {
    if (!this.gameState) return;
    this.broadcast("presence", {
      idleSinceByPlayer: Object.fromEntries(this.waitingSince.entries()),
    });
  }

  private recordWinnerIfNeeded(state: GameState): void {
    if (!state.winnerId || this.recordedWinnerId === state.winnerId) return;
    recordMatch(state.winnerId, state.players.map((player) => player.id));
    this.recordedWinnerId = state.winnerId;
  }
}

function isGameCommand(value: unknown): value is GameCommand {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Ha ocurrido un error inesperado.";
}
