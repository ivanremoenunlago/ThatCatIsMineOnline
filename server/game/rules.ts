import { CARD_BY_ID } from "../../shared/card-catalog.js";
import { SYNERGIES } from "../../shared/synergies.js";
import type { BoardCat, GameState, MoveChoice, PlayerState, Zone } from "../../shared/game-types.js";

export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleError";
  }
}

export function getPlayer(state: GameState, playerId: string): PlayerState {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new RuleError("Jugador no encontrado.");
  return player;
}

export function getCard(cardId: string) {
  const definition = CARD_BY_ID.get(cardId);
  if (!definition) throw new RuleError(`Carta desconocida: ${cardId}`);
  return definition;
}

export function allCats(player: PlayerState): BoardCat[] {
  return [...player.sofa, ...player.salon];
}

export function countCats(player: PlayerState): number {
  return player.sofa.length + player.salon.length;
}

export function hasActiveEffect(state: GameState, kind: "nap" | "strike"): boolean {
  return state.activeEffects.some((effect) => effect.kind === kind);
}

export function catIsInZone(player: PlayerState, cardId: string, zone: Zone): boolean {
  const collection = zone === "sofa" ? player.sofa : player.salon;
  return collection.some((cat) => cat.cardId === cardId);
}

export function synergyIsActive(player: PlayerState, synergyId: string, state: GameState): boolean {
  if (hasActiveEffect(state, "nap")) return false;
  const synergy = SYNERGIES.find((candidate) => candidate.id === synergyId);
  if (!synergy) return false;
  const sofaIds = new Set(player.sofa.map((cat) => cat.cardId));
  if (synergyId === "triplets") {
    return ["cat-triplet-1", "cat-triplet-2", "cat-triplet-3"].every((id) => sofaIds.has(id));
  }
  return synergy.cats.every((id) => sofaIds.has(id));
}

export function sofaOccupancy(player: PlayerState): number {
  const spaces = player.sofa.reduce((total, cat) => total + (CARD_BY_ID.get(cat.cardId)?.sofaSpaces ?? 1), 0);
  const hasFat = player.sofa.some((cat) => cat.cardId === "cat-fat");
  const hasUnderfed = player.sofa.some((cat) => cat.cardId === "cat-underfed");
  return spaces - (hasFat && hasUnderfed ? 1 : 0);
}

export function canFitInSofa(player: PlayerState, cardId: string, replacingCatId?: string): boolean {
  const existing = replacingCatId
    ? player.sofa.filter((cat) => cat.instanceId !== replacingCatId)
    : player.sofa;
  const incoming = CARD_BY_ID.get(cardId);
  if (!incoming || incoming.kind !== "cat") return false;
  const spaces = existing.reduce((total, cat) => total + (CARD_BY_ID.get(cat.cardId)?.sofaSpaces ?? 1), 0);
  const fatCount = existing.filter((cat) => cat.cardId === "cat-fat").length + Number(cardId === "cat-fat");
  const underfedCount = existing.filter((cat) => cat.cardId === "cat-underfed").length + Number(cardId === "cat-underfed");
  const synergySpace = fatCount > 0 && underfedCount > 0 ? 1 : 0;
  return spaces + (incoming.sofaSpaces ?? 1) - synergySpace <= 3;
}

export function placeCat(player: PlayerState, cat: BoardCat, zone?: Zone): Zone {
  const destination = zone ?? (canFitInSofa(player, cat.cardId) ? "sofa" : "salon");
  if (destination === "sofa" && !canFitInSofa(player, cat.cardId)) {
    throw new RuleError("No hay espacio suficiente en el Sofá.");
  }
  cat.ownerId = player.id;
  cat.zone = destination;
  (destination === "sofa" ? player.sofa : player.salon).push(cat);
  return destination;
}

export function getPrestige(player: PlayerState, state: GameState): number {
  const nap = hasActiveEffect(state, "nap");
  const sofaIds = new Set(player.sofa.map((cat) => cat.cardId));
  let prestige = player.actionBonusPrestige;

  for (const cat of allCats(player)) {
    const definition = getCard(cat.cardId);
    if (cat.cardId === "cat-loner" && cat.zone === "sofa") {
      prestige += player.sofa.length === 1 ? 7 : 0;
      continue;
    }

    prestige += cat.zone === "sofa" ? (definition.sofa ?? 0) : (definition.salon ?? 0);
    if (player.purrPrestigeCatIds.includes(cat.instanceId)) prestige += 1;
    if (nap || cat.zone !== "sofa") continue;

    if (cat.cardId === "cat-underfed" && player.hand.length === 0) prestige += 2;
    if (cat.cardId === "cat-mama") {
      for (const other of player.sofa) {
        if (other.instanceId === cat.instanceId) continue;
        prestige += other.cardId === "cat-baby" && synergyIsActive(player, "favorite-child", state) ? 3 : 1;
      }
    }
  }

  if (synergyIsActive(player, "neighborhood-veterans", state)) prestige += 2;
  if (synergyIsActive(player, "yin-yang", state)) prestige += 1;
  if (synergyIsActive(player, "triplets", state)) prestige += 2;
  return prestige;
}

export function targetPrestige(playerCount: number): number {
  if (playerCount === 2) return 15;
  if (playerCount === 3 || playerCount === 4) return 13;
  if (playerCount === 5) return 12;
  throw new RuleError("La partida necesita entre 2 y 5 jugadores.");
}

export function checkVictory(state: GameState, playerId: string): boolean {
  if (state.players[state.currentPlayerIndex]?.id !== playerId) return false;
  const player = getPlayer(state, playerId);
  if (getPrestige(player, state) < targetPrestige(state.players.length)) return false;
  state.winnerId = playerId;
  state.endedReason = "victory";
  state.phase = "finished";
  state.responseWindow = null;
  state.combat = null;
  state.pendingCatPlacements = {};
  state.pendingDrawNotices = {};
  state.pendingPrivateNotices = {};
  state.pendingDiscard = null;
  state.pendingGlobalChoice = null;
  state.pendingSalvage = null;
  state.pendingChoices = {};
  return true;
}

export function findCat(player: PlayerState, instanceId: string): BoardCat | undefined {
  return [...player.sofa, ...player.salon].find((cat) => cat.instanceId === instanceId);
}

export function findProtectedCat(player: PlayerState, instanceId: string): boolean {
  return player.structure?.cardId === "structure-bed" && player.structureProtectedCatId === instanceId;
}

export function canMoveBetweenZones(state: GameState, player: PlayerState, cat: BoardCat): boolean {
  return !hasActiveEffect(state, "strike") && !findProtectedCat(player, cat.instanceId);
}

export function moveCat(state: GameState, actorId: string, movement: MoveChoice, countsAsExtra = false): void {
  const owner = getPlayer(state, movement.playerId);
  if (movement.playerId !== actorId && state.phase !== "action") {
    throw new RuleError("Solo puedes mover gatos de otra casa al resolver un efecto.");
  }
  const cat = findCat(owner, movement.catInstanceId);
  if (!cat) throw new RuleError("No se encontró el gato que quieres mover.");
  if (cat.zone === movement.to) throw new RuleError("El gato ya está en esa zona.");
  if (
    cat.cardId === "cat-victim" &&
    movement.to === "sofa" &&
    owner.turnFlags.includes("victim-cannot-return")
  ) {
    throw new RuleError("Victimista no puede volver al Sofá este turno.");
  }
  if (!canMoveBetweenZones(state, owner, cat)) {
    throw new RuleError("Un efecto activo impide mover ese gato entre zonas.");
  }

  const from = cat.zone === "sofa" ? owner.sofa : owner.salon;
  const to = movement.to === "sofa" ? owner.sofa : owner.salon;
  const previousZone = cat.zone;
  const index = from.findIndex((candidate) => candidate.instanceId === cat.instanceId);
  from.splice(index, 1);
  cat.zone = movement.to;
  to.push(cat);
  if (movement.to === "sofa" && sofaOccupancy(owner) > 3) {
    to.splice(to.findIndex((candidate) => candidate.instanceId === cat.instanceId), 1);
    cat.zone = previousZone;
    from.push(cat);
    throw new RuleError("El movimiento supera la capacidad del Sofá.");
  }

  if (countsAsExtra) owner.extraMoves = Math.max(0, owner.extraMoves - 1);
  if (
    owner.turnFlags.includes("why-me-ready") &&
    !owner.turnFlags.includes("why-me-drew") &&
    cat.cardId === "cat-victim" &&
    movement.to === "salon"
  ) {
    owner.turnFlags.push("why-me-drew");
    owner.turnFlags.push("victim-cannot-return");
  }
}
