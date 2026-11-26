import type { CardInstance } from "./cards.js";

export type GamePhase =
  | "lobby"
  | "initial_placement"
  | "pre_action"
  | "action"
  | "movement"
  | "litter"
  | "discard"
  | "response"
  | "choice"
  | "combat"
  | "finished";

export type Zone = "sofa" | "salon";

export interface BoardCat extends CardInstance {
  ownerId: string;
  zone: Zone;
}

export interface ActiveEffect {
  kind: "nap" | "strike";
  expiresForPlayerId: string;
}

export interface PurrEffect {
  card: CardInstance;
  ownerId: string;
  catInstanceIds: string[];
  expiresForPlayerId: string;
}

export interface PlayerState {
  id: string;
  name: string;
  hand: CardInstance[];
  skipCards: CardInstance[];
  sofa: BoardCat[];
  salon: BoardCat[];
  structure: CardInstance | null;
  structureProtectedCatId: string | null;
  litter: CardInstance[];
  skipNextTurn: boolean;
  purrEffects: PurrEffect[];
  purrPrestigeCatIds: string[];
  actionBonusPrestige: number;
  scratcherArmed: boolean;
  scratcherUsed: boolean;
  extraMoves: number;
  turnFlags: string[];
}

export interface GameLogEntry {
  id: string;
  text: string;
  createdAt: number;
}

export interface PendingEffect {
  id: string;
  actorId: string;
  card: CardInstance;
  choices: Record<string, string | string[] | boolean | undefined>;
}

export interface ResponseWindow {
  pending: PendingEffect;
  stack: Array<{ playerId: string; card: CardInstance }>;
  order: string[];
  cursor: number;
  expiresAt: number;
}

export interface CombatState {
  attackerId: string;
  initialTargetId: string;
  targetPlayerId: string;
  targetCardInstanceId: string;
  redirectPlayerId: string;
  attack: CardInstance;
  attackSupports: CardInstance[];
  defense: CardInstance | null;
  defenseSupports: CardInstance[];
  defenseExpiresAt: number | null;
  revealed: boolean;
  redirectedPlayers: string[];
  spentResponseCards: CardInstance[];
}

export interface PendingDiscard {
  playerIds: string[];
  cursor: number;
  countByPlayer: Record<string, number>;
  reason: string;
  next: "continue" | "end_turn" | "finish_combat";
  toLitter: boolean;
}

export interface PendingGlobalChoice {
  kind: "toy-exchange" | "neighbor-dog" | "veterinary";
  actorId: string;
  card: CardInstance;
  playerIds: string[];
  cursor: number;
  choices: Record<string, string | string[] | null>;
}

export interface PendingSalvage {
  playerId: string;
  structureCard: CardInstance;
}

export interface GameState {
  id: string;
  roomId: string;
  phase: GamePhase;
  players: PlayerState[];
  currentPlayerIndex: number;
  round: number;
  turnNumber: number;
  actionsRemaining: number;
  actionUsed: boolean;
  actionPhaseSkipped: boolean;
  deck: CardInstance[];
  discard: CardInstance[];
  activeEffects: ActiveEffect[];
  privatePeeks: Record<string, CardInstance[]>;
  responseWindow: ResponseWindow | null;
  combat: CombatState | null;
  pendingGlobalChoice: PendingGlobalChoice | null;
  pendingSalvage: PendingSalvage | null;
  pendingDiscard: PendingDiscard | null;
  pendingChoices: Record<string, string>;
  initialCatChoices: Record<string, CardInstance[]>;
  pendingCatPlacements: Record<string, CardInstance[]>;
  pendingDrawNotices: Record<string, CardInstance[]>;
  initialDrawChoicePlayerId: string | null;
  winnerId: string | null;
  endedReason: "victory" | "cancelled" | null;
  log: GameLogEntry[];
}

export interface PublicPlayerState {
  id: string;
  name: string;
  handCount: number;
  sofa: BoardCat[];
  salon: BoardCat[];
  structure: CardInstance | null;
  structureProtectedCatId: string | null;
  litterCount: number;
  prestige: number;
  targetPrestige: number;
  isCurrentPlayer: boolean;
  skipNextTurn: boolean;
  activeSynergies: string[];
}

export interface PublicGameState {
  id: string;
  roomId: string;
  phase: GamePhase;
  players: PublicPlayerState[];
  currentPlayerId: string | null;
  round: number;
  turnNumber: number;
  actionsRemaining: number;
  actionUsed: boolean;
  initialPlacementPlayerIds: string[];
  pendingCatPlacementPlayerIds: string[];
  pendingDrawNoticePlayerIds: string[];
  waitingPlayerIds: string[];
  initialDrawChoicePlayerId: string | null;
  deckCount: number;
  discardCount: number;
  discard: CardInstance[];
  activeEffects: ActiveEffect[];
  responseWindow: PublicResponseWindow | null;
  combat: PublicCombatState | null;
  pendingGlobalChoice: Pick<PendingGlobalChoice, "kind" | "actorId" | "playerIds" | "cursor"> | null;
  pendingDiscard: PendingDiscard | null;
  winnerId: string | null;
  endedReason: GameState["endedReason"];
  log: GameLogEntry[];
}

export interface PublicCombatState {
  attackerId: string;
  initialTargetId: string;
  targetPlayerId: string;
  targetCardInstanceId: string;
  revealed: boolean;
  attackCardIds: string[];
  defenseCardId: string | null;
  attackPower: number | null;
  defensePower: number | null;
  redirectPlayerId: string | null;
  defenseExpiresAt: number | null;
}

export interface PublicResponseWindow {
  actorId: string;
  cardId: string;
  pendingActorId: string;
  pendingCardId: string;
  recipientIds: string[];
  cursor: number;
  expiresAt: number;
}

export interface PrivateGameState {
  playerId: string;
  hand: CardInstance[];
  litter: CardInstance[];
  yourTurn: boolean;
  availableActions: string[];
  pendingChoice: string | null;
  redirectAvailable: boolean;
  initialPlacementCats: CardInstance[];
  pendingCatPlacements: CardInstance[];
  pendingDrawNotice: CardInstance[];
  peekedCards: CardInstance[];
}

export type GameCommand =
  | { type: "choose-initial-cats"; placements: Array<{ catInstanceId: string; to: Zone }> }
  | { type: "choose-drawn-cats"; placements: Array<{ catInstanceId: string; to: Zone }> }
  | { type: "acknowledge-draw" }
  | { type: "choose-initial-draw"; useRaccoon: boolean }
  | { type: "skip-action-phase" }
  | { type: "activate-preaction"; ability: "curious" | "triplets" | "hyperactive" | "scratcher"; cards?: string[]; keepCardId?: string; movement?: MoveChoice }
  | { type: "play-card"; cardInstanceId: string; choices?: PendingEffect["choices"] }
  | { type: "declare-attack"; targetPlayerId: string; targetCardInstanceId: string; attackInstanceId: string; supportInstanceIds: string[] }
  | { type: "choose-defense"; defenseInstanceId: string | null; supportInstanceIds: string[]; spyInstanceId?: string }
  | { type: "redirect-attack"; cardInstanceId: string; targetPlayerId: string; targetCardInstanceId: string }
  | { type: "pass-redirect" }
  | { type: "reveal-attack"; method: "spy" | "nosy"; cardInstanceId?: string }
  | { type: "respond-flush"; cardInstanceId: string }
  | { type: "pass-response" }
  | { type: "move"; movement: MoveChoice }
  | { type: "finish-movement" }
  | { type: "resolve-choice"; choice: string | string[] | boolean }
  | { type: "discard-cards"; cardInstanceIds: string[] }
  | { type: "resolve-litter"; recoverCardInstanceId: string | null };

export interface MoveChoice {
  playerId: string;
  catInstanceId: string;
  to: Zone;
  exchangeCatInstanceId?: string;
}
