import { randomInt } from "node:crypto";
import { matchMaker, Room, type Client } from "@colyseus/core";
import {
  MAX_ROOM_PLAYERS,
  MIN_ROOM_PLAYERS,
  ROOM_AUTO_START_DELAY_MS,
  ROOM_CODE_LENGTH,
  isValidRoomCode,
  normalizeRoomCode,
  type GameCommand,
  type GameState,
  type RoomLobbyState,
} from "../../shared/game-types.js";
import { accountForToken, recordMatch, type Account } from "../data/store.js";
import {
  applyGameCommand,
  createGame,
  expireCombatDefense as expireCombatDefenseCommand,
  type PlayerSeat,
} from "./game-engine.js";
import { projectPrivateState, projectPublicState } from "./projections.js";

interface RoomCreateOptions {
  token?: string;
  maxPlayers?: unknown;
  isPrivate?: unknown;
}

interface RoomJoinOptions {
  token?: string;
  code?: unknown;
}

interface RoomMetadata {
  roomCode: string;
  isPrivate: boolean;
  creatorName: string;
  maxPlayers: number;
  status: "lobby" | "playing";
  autoStartAt: number | null;
}

const ROOM_CODE_CHARACTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const reservedRoomCodes = new Set<string>();

async function reserveRoomCode(): Promise<string> {
  const activeRooms = await matchMaker.query({ name: "game" });
  const activeCodes = new Set(
    activeRooms
      .map((room) => room.metadata?.roomCode)
      .filter((code): code is string => typeof code === "string"),
  );
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = "";
    for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
      code += ROOM_CODE_CHARACTERS[randomInt(ROOM_CODE_CHARACTERS.length)];
    }
    if (!activeCodes.has(code) && !reservedRoomCodes.has(code)) {
      reservedRoomCodes.add(code);
      return code;
    }
  }
  throw new Error("No se pudo generar un código de sala único.");
}

export class GameRoom extends Room {
  private readonly seats = new Map<string, Account>();
  private creatorId = "";
  private creatorName = "";
  private roomCode = "";
  private privateRoom = false;
  private maxPlayers = MAX_ROOM_PLAYERS;
  private gameState: GameState | null = null;
  private recordedWinnerId: string | null = null;
  private responseTimeout: ReturnType<typeof setTimeout> | null = null;
  private combatTimeout: ReturnType<typeof setTimeout> | null = null;
  private autoStartTimeout: ReturnType<typeof setTimeout> | null = null;
  private autoStartAt: number | null = null;
  private presenceInterval: ReturnType<typeof setInterval> | null = null;
  private readonly waitingSince = new Map<string, number>();

  async onCreate(options: RoomCreateOptions): Promise<void> {
    const creator = accountForToken(options.token);
    if (!creator) throw new Error("La sesión ha caducado. Vuelve a iniciar sesión.");
    if (
      typeof options.maxPlayers !== "number" ||
      !Number.isInteger(options.maxPlayers) ||
      options.maxPlayers < MIN_ROOM_PLAYERS ||
      options.maxPlayers > MAX_ROOM_PLAYERS
    ) {
      throw new Error(`El máximo de jugadores debe estar entre ${MIN_ROOM_PLAYERS} y ${MAX_ROOM_PLAYERS}.`);
    }
    if (typeof options.isPrivate !== "boolean") {
      throw new Error("Indica si la sala será pública o privada.");
    }

    this.creatorId = creator.id;
    this.creatorName = creator.username;
    this.maxPlayers = options.maxPlayers;
    this.privateRoom = options.isPrivate;
    this.maxClients = this.maxPlayers;
    this.roomCode = await reserveRoomCode();
    try {
      await this.setPrivate(this.privateRoom);
      await this.setMetadata(this.roomMetadata());
    } catch (error) {
      reservedRoomCodes.delete(this.roomCode);
      throw error;
    }

    this.onMessage("refresh", (client: Client) => {
      if (this.gameState) {
        client.send("public-state", projectPublicState(this.gameState));
        client.send("private-state", projectPrivateState(this.gameState, this.getSeat(client).id));
      } else {
        client.send("lobby", this.lobbyState());
      }
    });
    this.onMessage("start-game", (client: Client) => this.startGame(client));
    this.onMessage("kick-player", (client: Client, message: unknown) => this.kickPlayer(client, message));
    this.onMessage("command", (client: Client, message: unknown) => this.receiveCommand(client, message));
    this.presenceInterval = setInterval(() => this.publishPresence(), 1_000);
  }

  async onJoin(client: Client, options: RoomJoinOptions): Promise<void> {
    if (this.gameState) throw new Error("La partida ya ha comenzado.");
    const account = accountForToken(options.token);
    if (!account) throw new Error("La sesión ha caducado. Vuelve a iniciar sesión.");
    const code = typeof options.code === "string" ? normalizeRoomCode(options.code) : "";
    if (account.id !== this.creatorId && (!isValidRoomCode(code) || code !== this.roomCode)) {
      throw new Error("El código de sala no es válido.");
    }
    if ([...this.seats.values()].some((seat) => seat.id === account.id)) {
      throw new Error("Esta cuenta ya está en la sala.");
    }
    if (this.seats.size >= this.maxPlayers) throw new Error("La sala está llena.");
    this.seats.set(client.sessionId, account);
    await this.updateLobby();
  }

  async onLeave(client: Client): Promise<void> {
    const account = this.seats.get(client.sessionId);
    this.seats.delete(client.sessionId);
    if (this.gameState) {
      this.broadcast("notice", `${account?.username ?? "Un jugador"} se ha desconectado.`);
    } else {
      await this.updateLobby();
    }
  }

  onDispose(): void {
    this.clearAutoStart();
    reservedRoomCodes.delete(this.roomCode);
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

  private roomMetadata(): RoomMetadata {
    return {
      roomCode: this.roomCode,
      isPrivate: this.privateRoom,
      creatorName: this.creatorName,
      maxPlayers: this.maxPlayers,
      status: this.gameState ? "playing" : "lobby",
      autoStartAt: this.autoStartAt,
    };
  }

  private lobbyState(): RoomLobbyState {
    const players = [...this.seats.values()].map(({ id, username }) => ({ id, name: username }));
    return {
      roomId: this.roomId,
      roomCode: this.roomCode,
      isPrivate: this.privateRoom,
      creatorId: this.creatorId,
      creatorName: this.creatorName,
      maxPlayers: this.maxPlayers,
      autoStartAt: this.autoStartAt,
      players,
    };
  }

  private async updateLobby(): Promise<void> {
    if (this.gameState) return;
    if (this.seats.size === this.maxPlayers) {
      this.clearAutoStart();
      this.autoStartAt = Date.now() + ROOM_AUTO_START_DELAY_MS;
      const expectedStartAt = this.autoStartAt;
      this.autoStartTimeout = setTimeout(() => {
        void this.startGame(undefined, expectedStartAt);
      }, ROOM_AUTO_START_DELAY_MS);
    } else {
      this.clearAutoStart();
    }
    await this.setMetadata(this.roomMetadata());
    this.broadcast("lobby", this.lobbyState());
  }

  private clearAutoStart(): void {
    if (this.autoStartTimeout) clearTimeout(this.autoStartTimeout);
    this.autoStartTimeout = null;
    this.autoStartAt = null;
  }

  private kickPlayer(client: Client, message: unknown): void {
    try {
      const account = this.getSeat(client);
      if (this.gameState) throw new Error("No se puede expulsar a nadie después de empezar la partida.");
      if (account.id !== this.creatorId) throw new Error("Solo quien creó la sala puede expulsar jugadores.");
      if (
        typeof message !== "object" ||
        message === null ||
        !("playerId" in message) ||
        typeof message.playerId !== "string"
      ) {
        throw new Error("El jugador elegido no es válido.");
      }
      if (message.playerId === this.creatorId) throw new Error("No puedes expulsarte de tu propia sala.");
      const target = this.clients.find((candidate) => this.seats.get(candidate.sessionId)?.id === message.playerId);
      if (!target) throw new Error("Ese jugador ya no está en la sala.");
      target.send("room-kicked", "El creador te ha expulsado de la sala.");
      target.leave(4000);
    } catch (error) {
      client.send("error", errorMessage(error));
    }
  }

  private async startGame(client?: Client, expectedStartAt?: number): Promise<void> {
    try {
      if (this.gameState) throw new Error("La partida ya ha comenzado.");
      if (expectedStartAt !== undefined) {
        if (this.autoStartAt !== expectedStartAt || this.seats.size !== this.maxPlayers) return;
      } else {
        const account = this.getSeat(client!);
        if (account.id !== this.creatorId) throw new Error("Solo quien creó la sala puede empezar.");
        if (this.seats.size < MIN_ROOM_PLAYERS) throw new Error(`Se necesitan al menos ${MIN_ROOM_PLAYERS} jugadores.`);
      }
      this.clearAutoStart();
      const seats: PlayerSeat[] = [...this.seats.values()].map(({ id, username }) => ({ id, name: username }));
      this.gameState = createGame(this.roomId, seats);
      const now = Date.now();
      for (const seat of seats) this.waitingSince.set(seat.id, now);
      await this.lock();
      await this.setMetadata(this.roomMetadata());
      this.publishGame();
    } catch (error) {
      if (client) client.send("error", errorMessage(error));
      else {
        console.error("Could not start the full room automatically.", error);
        this.broadcast("error", errorMessage(error));
      }
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
