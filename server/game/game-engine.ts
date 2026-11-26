import { randomUUID } from "node:crypto";
import { CARD_BY_ID } from "../../shared/card-catalog.js";
import type { CardInstance } from "../../shared/cards.js";
import type {
  CombatState,
  GameCommand,
  GameLogEntry,
  GameState,
  MoveChoice,
  PendingEffect,
  PlayerState,
  ResponseWindow,
  Zone,
} from "../../shared/game-types.js";
import { drawCards, createDeck, queueCatPlacement, queueDrawNotice, shuffle, takeTopCard } from "./deck.js";
import {
  allCats,
  canFitInSofa,
  canMoveBetweenZones,
  checkVictory,
  countCats,
  findCat,
  findProtectedCat,
  getCard,
  getPlayer,
  hasActiveEffect,
  moveCat,
  placeCat,
  sofaOccupancy,
  synergyIsActive,
  targetPrestige,
  RuleError,
} from "./rules.js";

const RESPONSE_TIMEOUT_MS = 15_000;
const DEFENSE_TIMEOUT_MS = 30_000;

export interface PlayerSeat {
  id: string;
  name: string;
}

function makePlayer(seat: PlayerSeat): PlayerState {
  return {
    id: seat.id,
    name: seat.name,
    hand: [],
    skipCards: [],
    sofa: [],
    salon: [],
    structure: null,
    structureProtectedCatId: null,
    litter: [],
    skipNextTurn: false,
    purrEffects: [],
    purrPrestigeCatIds: [],
    actionBonusPrestige: 0,
    scratcherArmed: false,
    scratcherUsed: false,
    extraMoves: 0,
    turnFlags: [],
  };
}

function addLog(state: GameState, text: string): void {
  state.log.push({ id: randomUUID(), text, createdAt: Date.now() });
  if (state.log.length > 120) state.log.splice(0, state.log.length - 120);
}

function activePlayer(state: GameState): PlayerState {
  const player = state.players[state.currentPlayerIndex];
  if (!player) throw new RuleError("La partida no tiene un jugador activo.");
  return player;
}

function removeFromHand(player: PlayerState, instanceId: string): CardInstance {
  const index = player.hand.findIndex((card) => card.instanceId === instanceId);
  if (index < 0) throw new RuleError("Esa carta no está en tu mano.");
  return player.hand.splice(index, 1)[0];
}

function discardFromHand(state: GameState, player: PlayerState, instance: CardInstance, forced = false): void {
  if (forced && player.structure?.cardId === "structure-litter") {
    player.litter.push(instance);
  } else {
    state.discard.push(instance);
  }
}

function discardStructure(state: GameState, owner: PlayerState): CardInstance | null {
  const structure = owner.structure;
  if (!structure) return null;
  owner.structure = null;
  owner.structureProtectedCatId = null;
  state.discard.push(...owner.litter.splice(0));
  state.discard.push(structure);
  return structure;
}

function reorderForNextTurn(state: GameState): void {
  state.currentPlayerIndex = (state.currentPlayerIndex + 1) % state.players.length;
  if (state.currentPlayerIndex === 0) state.round += 1;
}

function expireAtStartOfTurn(state: GameState, player: PlayerState): void {
  state.activeEffects = state.activeEffects.filter((effect) => effect.expiresForPlayerId !== player.id);
  if (player.structure?.cardId === "structure-bed") {
    state.discard.push(player.structure);
    player.structure = null;
    player.structureProtectedCatId = null;
    addLog(state, `La Cama de Peluche de ${player.name} caduca.`);
  }

  for (const effect of player.purrEffects) {
    const stillOnSofa = effect.catInstanceIds.every((id) =>
      player.sofa.some((cat) => cat.instanceId === id),
    );
    if (stillOnSofa) player.purrPrestigeCatIds.push(...effect.catInstanceIds);
    state.discard.push(effect.card);
  }
  player.purrEffects = [];
}

function activeCatCount(player: PlayerState, cardId: string): number {
  return player.sofa.filter((cat) => cat.cardId === cardId).length;
}

function replenishToRuleLimit(state: GameState, player: PlayerState): void {
  if (player.hand.length >= 3) return;
  let target = 3;
  if (activeCatCount(player, "cat-foresight") > 0) target = 4;
  if (synergyIsActive(player, "inventory-control", state)) target = 5;
  while (player.hand.length < target) {
    if (drawCards(state, player, 1) === 0) break;
  }
}

function drawInitial(state: GameState, player: PlayerState, useRaccoon: boolean): void {
  if (useRaccoon) {
    if (activeCatCount(player, "cat-raccoon") === 0 || state.discard.length === 0) {
      throw new RuleError("No puedes sustituir el robo inicial con Mapache ahora.");
    }
    const instance = state.discard.pop();
    if (!instance) throw new RuleError("El descarte está vacío.");
    const definition = getCard(instance.cardId);
    queueDrawNotice(state, player, instance);
    if (definition.kind === "cat") {
      queueCatPlacement(state, player, instance);
    } else {
      player.hand.push(instance);
    }
  } else {
    const babyAlone = activeCatCount(player, "cat-baby") > 0 && player.sofa.length === 1;
    const feederBonus = player.structure?.cardId === "structure-feeder" ? 1 : 0;
    const babyBonus = hasActiveEffect(state, "nap") ? 0 : Number(babyAlone);
    drawCards(state, player, 1 + feederBonus + babyBonus);
  }
  replenishToRuleLimit(state, player);
  state.initialDrawChoicePlayerId = null;
  delete state.pendingChoices[player.id];
  state.phase = "action";
  state.actionsRemaining = 1;
  state.actionUsed = false;
  state.actionPhaseSkipped = false;
  addLog(state, `${player.name} ha completado el robo inicial.`);
  addLog(state, `${player.name} inicia su Fase de Acción.`);
  checkVictory(state, player.id);
}

function startCurrentTurn(state: GameState): void {
  let skipped = 0;
  while (skipped <= state.players.length) {
    const player = activePlayer(state);
    if (player.skipNextTurn) {
      player.skipNextTurn = false;
      state.discard.push(...player.skipCards.splice(0));
      addLog(state, `${player.name} pierde su turno completo.`);
      reorderForNextTurn(state);
      state.turnNumber += 1;
      skipped += 1;
      continue;
    }

    player.purrPrestigeCatIds = [];
    expireAtStartOfTurn(state, player);
    player.actionBonusPrestige = 0;
    player.scratcherArmed = false;
    player.scratcherUsed = false;
    player.extraMoves = 0;
    player.turnFlags = [];
    if (synergyIsActive(player, "why-me", state)) player.turnFlags.push("why-me-ready");
    state.actionPhaseSkipped = false;
    state.actionUsed = false;
    state.actionsRemaining = 0;
    state.turnNumber += 1;
    state.phase = "pre_action";
    addLog(state, `Empieza el turno de ${player.name}.`);

    if (checkVictory(state, player.id)) return;
    if (!hasActiveEffect(state, "nap") && activeCatCount(player, "cat-raccoon") > 0 && state.discard.length > 0) {
      state.initialDrawChoicePlayerId = player.id;
      state.pendingChoices[player.id] = "initial-draw";
      return;
    }
    drawInitial(state, player, false);
    return;
  }
  throw new RuleError("Se ha detectado una cadena inválida de turnos perdidos.");
}

function dealInitialHands(players: PlayerState[], deck: CardInstance[]): Record<string, CardInstance[]> {
  const initialCatChoices: Record<string, CardInstance[]> = {};
  for (const player of players) {
    let dealt: CardInstance[] = [];
    let attempt = 0;
    while (attempt < 100) {
      attempt += 1;
      dealt = [];
      for (let index = 0; index < 4; index += 1) {
        const instance = deck.pop();
        if (!instance) throw new RuleError("El mazo se agotó durante el reparto inicial.");
        dealt.push(instance);
      }
      const catCount = dealt.filter((instance) => getCard(instance.cardId).kind === "cat").length;
      if (catCount < 3) break;
      deck.push(...dealt);
      shuffle(deck);
    }
    if (attempt === 100) throw new RuleError(`No se pudo repartir una mano válida a ${player.name}.`);
    const cats: CardInstance[] = [];
    for (const instance of dealt) {
      if (getCard(instance.cardId).kind === "cat") {
        cats.push(instance);
      } else {
        player.hand.push(instance);
      }
    }
    if (cats.length > 0) initialCatChoices[player.id] = cats;
  }
  return initialCatChoices;
}

function startFirstTurn(state: GameState): void {
  const leastCats = Math.min(...state.players.map(countCats));
  const startingPlayers = state.players
    .map((player, index) => ({ player, index }))
    .filter(({ player }) => countCats(player) === leastCats);
  const firstPlayer = startingPlayers[Math.floor(Math.random() * startingPlayers.length)];
  if (!firstPlayer) throw new RuleError("No se pudo determinar quién empieza la partida.");
  state.currentPlayerIndex = firstPlayer.index;
  addLog(state, `Empieza ${firstPlayer.player.name}, que tenía menos gatos.`);
  startCurrentTurn(state);
}

function chooseInitialCats(
  state: GameState,
  playerId: string,
  command: Extract<GameCommand, { type: "choose-initial-cats" }>,
): void {
  const cats = state.initialCatChoices[playerId];
  if (state.phase !== "initial_placement" || !cats) {
    throw new RuleError("No tienes gatos iniciales pendientes de colocar.");
  }
  if (!Array.isArray(command.placements) || command.placements.length !== cats.length) {
    throw new RuleError("Elige un destino para cada gato inicial.");
  }

  const choices = new Map<string, Zone>();
  for (const placement of command.placements) {
    if (
      typeof placement !== "object" ||
      placement === null ||
      typeof placement.catInstanceId !== "string" ||
      (placement.to !== "sofa" && placement.to !== "salon") ||
      choices.has(placement.catInstanceId) ||
      !cats.some((cat) => cat.instanceId === placement.catInstanceId)
    ) {
      throw new RuleError("La elección de destino para los gatos iniciales no es válida.");
    }
    choices.set(placement.catInstanceId, placement.to);
  }
  if (choices.size !== cats.length) throw new RuleError("Elige un destino para cada gato inicial.");

  const player = getPlayer(state, playerId);
  for (const cat of cats) {
    const destination = choices.get(cat.instanceId);
    if (!destination) throw new RuleError("Elige un destino para cada gato inicial.");
    placeCat(player, { ...cat, ownerId: player.id, zone: destination }, destination);
  }
  delete state.initialCatChoices[playerId];
  addLog(state, `${player.name} ha colocado sus gatos iniciales.`);

  if (Object.keys(state.initialCatChoices).length === 0) startFirstTurn(state);
}

function chooseDrawnCats(
  state: GameState,
  playerId: string,
  command: Extract<GameCommand, { type: "choose-drawn-cats" }>,
): void {
  const cats = state.pendingCatPlacements[playerId];
  if (!cats) throw new RuleError("No tienes gatos pendientes de colocar.");
  if (!Array.isArray(command.placements) || command.placements.length !== cats.length) {
    throw new RuleError("Elige un destino para cada gato.");
  }

  const choices = new Map<string, Zone>();
  for (const placement of command.placements) {
    if (
      typeof placement !== "object" ||
      placement === null ||
      typeof placement.catInstanceId !== "string" ||
      (placement.to !== "sofa" && placement.to !== "salon") ||
      choices.has(placement.catInstanceId) ||
      !cats.some((cat) => cat.instanceId === placement.catInstanceId)
    ) {
      throw new RuleError("La elección de destino para los gatos no es válida.");
    }
    choices.set(placement.catInstanceId, placement.to);
  }
  if (choices.size !== cats.length) throw new RuleError("Elige un destino para cada gato.");

  const player = getPlayer(state, playerId);
  for (const cat of cats) {
    const destination = choices.get(cat.instanceId);
    if (!destination) throw new RuleError("Elige un destino para cada gato.");
    placeCat(player, { ...cat, ownerId: player.id, zone: destination }, destination);
  }
  delete state.pendingCatPlacements[playerId];
  delete state.pendingDrawNotices[playerId];
  addLog(state, `${player.name} ha colocado los gatos recibidos en su casa.`);
  const capturedCombatCat = state.combat?.attackerId === playerId &&
    cats.some((cat) => cat.instanceId === state.combat?.targetCardInstanceId);
  if (capturedCombatCat) {
    if (!state.pendingDiscard) finishCombat(state);
  } else if (checkVictory(state, playerId)) {
    state.pendingCatPlacements = {};
  }
}

export function createGame(roomId: string, seats: PlayerSeat[]): GameState {
  if (seats.length < 2 || seats.length > 5) throw new RuleError("La partida admite entre 2 y 5 jugadores.");
  if (new Set(seats.map((seat) => seat.id)).size !== seats.length) {
    throw new RuleError("No puede haber dos asientos con el mismo usuario.");
  }
  const players = seats.map(makePlayer);
  const deck = createDeck();
  const initialCatChoices = dealInitialHands(players, deck);
  const state: GameState = {
    id: randomUUID(),
    roomId,
    phase: "initial_placement",
    players,
    currentPlayerIndex: 0,
    round: 1,
    turnNumber: 0,
    actionsRemaining: 0,
    actionUsed: false,
    actionPhaseSkipped: false,
    deck,
    discard: [],
    activeEffects: [],
    responseWindow: null,
    combat: null,
    pendingGlobalChoice: null,
    pendingSalvage: null,
    pendingDiscard: null,
    pendingChoices: {},
    initialCatChoices,
    pendingCatPlacements: {},
    pendingDrawNotices: {},
    privatePeeks: {},
    initialDrawChoicePlayerId: null,
    winnerId: null,
    endedReason: null,
    log: [],
  };
  if (Object.keys(initialCatChoices).length === 0) startFirstTurn(state);
  return state;
}

function requireCurrentPlayer(state: GameState, playerId: string): PlayerState {
  const player = activePlayer(state);
  if (player.id !== playerId) throw new RuleError("No es tu turno.");
  return player;
}

function nextResponseOrder(state: GameState, afterPlayerId: string): string[] {
  const index = state.players.findIndex((player) => player.id === afterPlayerId);
  if (index < 0) throw new RuleError("No se encontró al jugador que inició la respuesta.");
  return state.players
    .slice(index + 1)
    .concat(state.players.slice(0, index))
    .map((player) => player.id);
}

function beginResponseWindow(state: GameState, pending: PendingEffect): void {
  state.responseWindow = {
    pending,
    stack: [],
    order: nextResponseOrder(state, pending.actorId),
    cursor: 0,
    expiresAt: Date.now() + RESPONSE_TIMEOUT_MS,
  };
  state.phase = "response";
}

function requireResponsePlayer(state: GameState, playerId: string): void {
  const window = state.responseWindow;
  if (!window) throw new RuleError("No hay una ventana de respuesta activa.");
  if (window.order[window.cursor] !== playerId) {
    throw new RuleError("No tienes prioridad para responder en este momento.");
  }
}

function moveChoice(state: GameState, actorId: string, movement: MoveChoice, extra = false): void {
  if (!movement.exchangeCatInstanceId) {
    moveCat(state, actorId, movement, extra);
  } else {
    const owner = getPlayer(state, movement.playerId);
    const first = findCat(owner, movement.catInstanceId);
    const second = findCat(owner, movement.exchangeCatInstanceId);
    if (!first || !second || first.instanceId === second.instanceId || first.zone === second.zone) {
      throw new RuleError("El intercambio necesita dos gatos distintos de zonas diferentes.");
    }
    if (first.zone === movement.to) throw new RuleError("El primer gato ya está en esa zona.");
    if (
      hasActiveEffect(state, "strike") ||
      findProtectedCat(owner, first.instanceId) ||
      findProtectedCat(owner, second.instanceId)
    ) {
      throw new RuleError("Un efecto activo impide intercambiar esos gatos.");
    }
    const firstFrom = first.zone === "sofa" ? owner.sofa : owner.salon;
    const secondFrom = second.zone === "sofa" ? owner.sofa : owner.salon;
    firstFrom.splice(firstFrom.findIndex((cat) => cat.instanceId === first.instanceId), 1);
    secondFrom.splice(secondFrom.findIndex((cat) => cat.instanceId === second.instanceId), 1);
    const firstZone = first.zone;
    const secondZone = second.zone;
    first.zone = secondZone;
    second.zone = firstZone;
    (first.zone === "sofa" ? owner.sofa : owner.salon).push(first);
    (second.zone === "sofa" ? owner.sofa : owner.salon).push(second);
    if (sofaOccupancy(owner) > 3) throw new RuleError("El intercambio supera la capacidad del Sofá.");
  }
  const owner = getPlayer(state, movement.playerId);
  if (owner.turnFlags.includes("why-me-drew")) {
    owner.turnFlags = owner.turnFlags.filter((flag) => flag !== "why-me-drew");
    drawCards(state, owner, 1);
    addLog(state, `${owner.name} roba 1 carta por ¿Por qué yo?.`);
  }
}

function activeEffectTargets(player: PlayerState, effect: string): boolean {
  return player.sofa.some((cat) => cat.cardId === effect);
}

function resolvePrivateChoice(state: GameState, playerId: string, choice: string | string[] | boolean): void {
  const pending = state.pendingChoices[playerId];
  const player = getPlayer(state, playerId);
  if (pending === "curious-keep") {
    if (typeof choice !== "string") throw new RuleError("Elige una de las cartas que miraste.");
    const peeked = state.privatePeeks[playerId] ?? [];
    const keptIndex = peeked.findIndex((card) => card.instanceId === choice);
    if (keptIndex < 0) throw new RuleError("La carta elegida no está entre las que miraste.");
    const [kept] = peeked.splice(keptIndex, 1);
    for (const card of peeked.reverse()) state.deck.push(card);
    delete state.privatePeeks[playerId];
    delete state.pendingChoices[playerId];
    if (getCard(kept.cardId).kind === "cat") {
      queueCatPlacement(state, player, kept);
    } else {
      player.hand.push(kept);
    }
    state.phase = "action";
    addLog(state, `${player.name} resuelve la habilidad de Curioso.`);
    checkVictory(state, player.id);
    return;
  }
  if (pending === "fat-peek") {
    if (choice !== "top" && choice !== "bottom") throw new RuleError("Elige dejar la carta arriba o ponerla al fondo.");
    const peeked = state.privatePeeks[playerId] ?? [];
    const card = peeked[0];
    if (card) {
      if (choice === "bottom") {
        const index = state.deck.findIndex((candidate) => candidate.instanceId === card.instanceId);
        if (index >= 0) state.deck.splice(index, 1);
        state.deck.unshift(card);
      }
    }
    delete state.privatePeeks[playerId];
    delete state.pendingChoices[playerId];
    state.phase = "movement";
    return;
  }
  if (pending === "salvage-structure") {
    const salvage = state.pendingSalvage;
    if (!salvage || salvage.playerId !== playerId) throw new RuleError("No hay una Estructura pendiente de recuperar.");
    if (choice !== "pass") {
      if (typeof choice !== "string" || !choice.startsWith("pay:")) {
        throw new RuleError("Elige descartar una carta o pasar.");
      }
      const paymentId = choice.slice("pay:".length);
      const payment = player.hand.find((card) => card.instanceId === paymentId);
      const structureIndex = state.discard.findIndex(
        (card) => card.instanceId === salvage.structureCard.instanceId,
      );
      if (!payment || structureIndex < 0) throw new RuleError("No se puede completar la recuperación de la Estructura.");
      player.hand.splice(player.hand.indexOf(payment), 1);
      state.discard.push(payment);
      player.hand.push(state.discard.splice(structureIndex, 1)[0]);
      addLog(state, `${player.name} recupera una Estructura descartando una carta.`);
    }
    state.pendingSalvage = null;
    delete state.pendingChoices[playerId];
    finishCombat(state);
    return;
  }
  if (state.pendingGlobalChoice) {
    resolveGlobalChoice(state, playerId, choice);
    return;
  }
  throw new RuleError("No tienes una elección pendiente.");
}

function activatePreaction(
  state: GameState,
  player: PlayerState,
  command: Extract<GameCommand, { type: "activate-preaction" }>,
): void {
  const nap = hasActiveEffect(state, "nap");
  if (command.ability === "scratcher") {
    if (nap || player.structure?.cardId !== "structure-scratcher") {
      throw new RuleError("No tienes un Rascador activo o tus habilidades están anuladas.");
    }
    if (player.scratcherArmed || player.scratcherUsed) throw new RuleError("El Rascador solo se activa una vez por turno.");
    const cardId = command.cards?.[0];
    if (!cardId) throw new RuleError("Elige una carta para descartar como coste.");
    discardFromHand(state, player, removeFromHand(player, cardId), true);
    player.scratcherArmed = true;
    addLog(state, `${player.name} prepara el Rascador de Sisal.`);
    return;
  }

  if (command.ability === "curious") {
    if (nap || !activeEffectTargets(player, "cat-curious")) throw new RuleError("No tienes un Gato Curioso activo.");
    if (player.turnFlags.includes("curious-used")) throw new RuleError("Curioso ya se ha activado este turno.");
    if (player.hand.length === 0) throw new RuleError("No tienes una carta para pagar el coste de Curioso.");
    const partner = synergyIsActive(player, "information-partners", state);
    const costId = command.cards?.[0];
    if (!costId) throw new RuleError("Elige la carta que descartas con Curioso.");
    discardFromHand(state, player, removeFromHand(player, costId), true);
    const count = partner ? 4 : 3;
    const peeked: CardInstance[] = [];
    for (let index = 0; index < count; index += 1) {
      const card = takeTopCard(state);
      if (!card) break;
      peeked.push(card);
    }
    if (peeked.length === 0) throw new RuleError("No hay cartas disponibles para mirar.");
    state.privatePeeks[player.id] = peeked;
    state.pendingChoices[player.id] = "curious-keep";
    player.turnFlags.push("curious-used");
    state.phase = "choice";
    return;
  }

  if (command.ability === "triplets") {
    if (nap || activeCatCount(player, "cat-triplet-1") + activeCatCount(player, "cat-triplet-2") + activeCatCount(player, "cat-triplet-3") === 0) {
      throw new RuleError("No tienes un Trillizo activo.");
    }
    if (player.turnFlags.includes("triplets-used")) throw new RuleError("Los Trillizos ya se han activado este turno.");
    const count = player.sofa.filter((cat) => getCard(cat.cardId).effect === "triplet").length;
    const cards = command.cards ?? [];
    if (cards.length !== count) throw new RuleError(`Debes descartar exactamente ${count} carta(s).`);
    const discarded = cards.map((id) => removeFromHand(player, id));
    for (const card of discarded) discardFromHand(state, player, card, true);
    drawCards(state, player, count);
    player.turnFlags.push("triplets-used");
    addLog(state, `${player.name} activa Los Trillizos y roba ${count} carta(s).`);
    checkVictory(state, player.id);
    return;
  }

  if (command.ability === "hyperactive") {
    if (nap || !activeEffectTargets(player, "cat-hyperactive")) throw new RuleError("No tienes un Gato Hiperactivo activo.");
    if (player.turnFlags.includes("hyperactive-used")) throw new RuleError("Hiperactivo ya se ha activado este turno.");
    if (!command.movement) throw new RuleError("Elige un movimiento para Hiperactivo.");
    moveChoice(state, player.id, command.movement, true);
    player.turnFlags.push("hyperactive-used");
    addLog(state, `${player.name} activa Hiperactivo.`);
    checkVictory(state, player.id);
  }
}

function skipActionPhase(state: GameState, player: PlayerState): void {
  if (state.phase !== "action" || state.actionUsed) {
    throw new RuleError("Solo puedes saltar la Fase de Acción antes de realizar una acción.");
  }
  state.actionPhaseSkipped = true;
  if (!hasActiveEffect(state, "nap") && activeEffectTargets(player, "cat-fat")) {
    const top = takeTopCard(state);
    if (top) {
      state.deck.push(top);
      state.privatePeeks[player.id] = [top];
      state.pendingChoices[player.id] = "fat-peek";
      state.phase = "choice";
      return;
    }
  }
  state.phase = "movement";
}

function activatePurr(
  state: GameState,
  player: PlayerState,
  card: CardInstance,
  choices: PendingEffect["choices"],
): void {
  const ids = choices.catInstanceIds;
  if (!Array.isArray(ids) || ids.length !== 2) throw new RuleError("Elige exactamente 2 gatos del Sofá para Ronroneo.");
  if (new Set(ids).size !== 2 || ids.some((id) => !player.sofa.some((cat) => cat.instanceId === id))) {
    throw new RuleError("Ronroneo solo puede cubrir dos gatos distintos de tu Sofá.");
  }
  player.purrEffects.push({
    card,
    ownerId: player.id,
    catInstanceIds: [...ids],
    expiresForPlayerId: player.id,
  });
  addLog(state, `${player.name} deja un Ronroneo sobre dos gatos.`);
}

function chooseTargetPlayer(state: GameState, actorId: string, value: unknown): PlayerState {
  if (typeof value !== "string" || !value) throw new RuleError("Elige un jugador objetivo.");
  if (value === actorId) throw new RuleError("No puedes elegirte como objetivo.");
  return getPlayer(state, value);
}

function randomRemove<T>(items: T[], amount: number): T[] {
  const removed: T[] = [];
  for (let index = 0; index < amount && items.length > 0; index += 1) {
    const randomIndex = Math.floor(Math.random() * items.length);
    removed.push(items.splice(randomIndex, 1)[0]);
  }
  return removed;
}

function addPendingChoice(
  state: GameState,
  kind: "toy-exchange" | "neighbor-dog" | "veterinary",
  actorId: string,
  card: CardInstance,
): void {
  const actorIndex = state.players.findIndex((player) => player.id === actorId);
  const ordered = state.players.slice(actorIndex).concat(state.players.slice(0, actorIndex));
  state.pendingGlobalChoice = {
    kind,
    actorId,
    card,
    playerIds: ordered.map((player) => player.id),
    cursor: 0,
    choices: {},
  };
  state.phase = "choice";
}

function blockedByCatProtection(state: GameState, pending: PendingEffect): boolean {
  const definition = getCard(pending.card.cardId);
  if (!definition.cancelable || definition.kind !== "action") return false;
  const targetCatId =
    pending.choices.targetCatInstanceId ??
    (pending.choices.ownerId && pending.choices.catInstanceId ? pending.choices.catInstanceId : undefined);
  if (typeof targetCatId !== "string") return false;
  const targetPlayerId =
    typeof pending.choices.targetPlayerId === "string"
      ? pending.choices.targetPlayerId
      : typeof pending.choices.ownerId === "string"
        ? pending.choices.ownerId
        : undefined;
  if (!targetPlayerId || targetPlayerId === pending.actorId) return false;
  const target = getPlayer(state, targetPlayerId);
  const targetCat = findCat(target, targetCatId);
  if (!targetCat) return false;
  if (target.structure?.cardId === "structure-fortress") return true;
  return (
    !hasActiveEffect(state, "nap") &&
    targetCat.cardId === "cat-loner" &&
    targetCat.zone === "sofa" &&
    target.sofa.length === 1
  );
}

function resolveCardEffect(state: GameState, pending: PendingEffect): void {
  const actor = getPlayer(state, pending.actorId);
  const definition = getCard(pending.card.cardId);
  const choices = pending.choices;
  let keepCardOnBoard = false;

  if (blockedByCatProtection(state, pending)) {
    state.discard.push(pending.card);
    state.phase = "action";
    addLog(state, `${definition.name} no afecta al gato protegido.`);
    checkVictory(state, actor.id);
    return;
  }

  switch (definition.effect) {
    case "skip_turn": {
      const target = chooseTargetPlayer(state, actor.id, choices.targetPlayerId);
      target.skipNextTurn = true;
      target.skipCards.push(pending.card);
      keepCardOnBoard = true;
      addLog(state, `${target.name} perderá su próximo turno completo.`);
      break;
    }
    case "prestige_action":
      actor.actionBonusPrestige += 1;
      state.actionsRemaining += 1;
      addLog(state, `${actor.name} obtiene +1 de prestigio y una acción.`);
      break;
    case "extra_actions":
      state.actionsRemaining += 2;
      addLog(state, `${actor.name} obtiene 2 acciones adicionales.`);
      break;
    case "purr":
      activatePurr(state, actor, pending.card, choices);
      keepCardOnBoard = true;
      break;
    case "redirect_attack": {
      const combat = state.combat;
      const targetPlayerId = choices.targetPlayerId;
      const targetCardInstanceId = choices.targetCardInstanceId;
      if (!combat || typeof targetPlayerId !== "string" || typeof targetCardInstanceId !== "string") {
        throw new RuleError("No hay un ataque que se pueda desviar.");
      }
      validateTarget(state, combat.attackerId, targetPlayerId, targetCardInstanceId);
      combat.targetPlayerId = targetPlayerId;
      combat.targetCardInstanceId = targetCardInstanceId;
      combat.redirectPlayerId = targetPlayerId;
      combat.defenseExpiresAt = Date.now() + DEFENSE_TIMEOUT_MS;
      combat.redirectedPlayers.push(pending.actorId);
      combat.spentResponseCards.push(pending.card);
      state.phase = "combat";
      addLog(state, `${actor.name} desvía el ataque con Ratón con Hierba Gatuna.`);
      keepCardOnBoard = true;
      break;
    }
    case "spy": {
      if (!state.combat) throw new RuleError("Espía de Ventana solo se usa durante un combate.");
      state.combat.revealed = true;
      state.combat.spentResponseCards.push(pending.card);
      if (choices.combatAfterSpy === true) {
        keepCardOnBoard = true;
        resolveCombat(state);
      }
      break;
    }
    case "cancel":
      throw new RuleError("Esta carta solo se puede usar como respuesta.");
    case "random_discard": {
      const target = chooseTargetPlayer(state, actor.id, choices.targetPlayerId);
      const amount = target.hand.length === 0 ? 0 : Math.max(1, Math.floor(target.hand.length / 2));
      const discarded = randomRemove(target.hand, amount);
      for (const card of discarded) discardFromHand(state, target, card, true);
      addLog(state, `${target.name} descarta ${discarded.length} carta(s) al azar.`);
      break;
    }
    case "steal_random": {
      const target = chooseTargetPlayer(state, actor.id, choices.targetPlayerId);
      const count = definition.id === "action-table" ? 2 : 1;
      const threshold = definition.id === "action-table" ? 6 : 4;
      if (target.hand.length < threshold) throw new RuleError(`El objetivo necesita al menos ${threshold} cartas en mano.`);
      actor.hand.push(...randomRemove(target.hand, count));
      addLog(state, `${actor.name} roba cartas al azar de la mano de ${target.name}.`);
      break;
    }
    case "swap_cats":
      swapCats(state, actor, choices);
      addLog(state, `${actor.name} usa Puerta Gatera para intercambiar gatos.`);
      break;
    case "steal_living_room_cat":
      stealSalonCat(state, actor, choices);
      break;
    case "move_cat":
      moveWithLaser(state, actor, choices);
      break;
    case "search_cat": {
      const index = state.deck.findIndex((card) => getCard(card.cardId).kind === "cat");
      if (index >= 0) {
        const [cat] = state.deck.splice(index, 1);
        queueCatPlacement(state, actor, cat);
        shuffle(state.deck);
        addLog(state, `${actor.name} encuentra un gato con ¡Pspspsps!.`);
      } else {
        shuffle(state.deck);
        drawCards(state, actor, 1);
        addLog(state, `${actor.name} no encuentra gatos y roba una carta.`);
      }
      break;
    }
    case "sabotage": {
      const target = chooseTargetPlayer(state, actor.id, choices.targetPlayerId);
      if (!target.structure) throw new RuleError("Ese jugador no tiene una Estructura que destruir.");
      const destroyed = discardStructure(state, target);
      if (destroyed) addLog(state, `${actor.name} destruye la Estructura de ${target.name}.`);
      break;
    }
    case "retrieve_discard": {
      const instanceId = choices.discardCardInstanceId;
      if (typeof instanceId !== "string") throw new RuleError("Elige una carta del descarte común.");
      const index = state.discard.findIndex((card) => card.instanceId === instanceId);
      if (index < 0) throw new RuleError("La carta ya no está en el descarte común.");
      const [recovered] = state.discard.splice(index, 1);
      if (getCard(recovered.cardId).kind === "cat") {
        queueCatPlacement(state, actor, recovered);
      } else {
        actor.hand.push(recovered);
      }
      addLog(state, `${actor.name} recupera una carta con Ovillo de Lana.`);
      break;
    }
    case "nap":
    case "strike":
      state.activeEffects.push({ kind: definition.effect, expiresForPlayerId: actor.id });
      addLog(state, `${actor.name} activa ${definition.name}.`);
      break;
    case "neighbor_dog":
      addPendingChoice(state, "neighbor-dog", actor.id, pending.card);
      keepCardOnBoard = true;
      break;
    case "toy_exchange":
      addPendingChoice(state, "toy-exchange", actor.id, pending.card);
      keepCardOnBoard = true;
      break;
    case "vet":
      addPendingChoice(state, "veterinary", actor.id, pending.card);
      keepCardOnBoard = true;
      break;
    case "draw_one_action":
      drawCards(state, actor, 1);
      state.actionsRemaining += 1;
      break;
    case "draw_two":
      drawCards(state, actor, 2);
      break;
    case "draw_three":
      drawCards(state, actor, 3);
      break;
    case "group_draw": {
      const start = state.players.findIndex((player) => player.id === actor.id);
      for (let offset = 0; offset < state.players.length; offset += 1) {
        drawCards(state, state.players[(start + offset) % state.players.length], 1);
      }
      drawCards(state, actor, 1);
      break;
    }
    case "box":
    case "fortress":
    case "feeder":
    case "scratcher":
    case "litter":
      playStructure(state, actor, pending.card, choices);
      keepCardOnBoard = true;
      break;
    case "bed":
      playStructure(state, actor, pending.card, choices);
      keepCardOnBoard = true;
      break;
    case "underfed":
    case "fat":
    case "neighborhood":
    case "territorial":
    case "nosy":
    case "curious":
    case "foresight":
    case "hoarder":
    case "envious":
    case "mama":
    case "baby":
    case "diurnal":
    case "nocturnal":
    case "triplet":
    case "loner":
    case "hyperactive":
    case "raccoon":
    case "victim":
    case "attack":
    case "support":
      throw new RuleError("Esta carta no tiene un efecto jugable en la Fase de Acción.");
  }

  if (!keepCardOnBoard) state.discard.push(pending.card);
  if (state.phase !== "choice" && state.phase !== "combat") state.phase = "action";
  if (Object.keys(state.pendingCatPlacements).length === 0) checkVictory(state, actor.id);
}

function playStructure(
  state: GameState,
  owner: PlayerState,
  card: CardInstance,
  choices: PendingEffect["choices"],
): void {
  const definition = getCard(card.cardId);
  if (definition.effect === "bed") {
    const targetId = choices.protectedCatInstanceId;
    if (typeof targetId !== "string" || !owner.sofa.some((cat) => cat.instanceId === targetId)) {
      throw new RuleError("Elige un gato de tu Sofá para proteger con la Cama.");
    }
  }
  if (owner.structure) discardStructure(state, owner);
  owner.structure = card;
  owner.structureProtectedCatId =
    definition.effect === "bed" && typeof choices.protectedCatInstanceId === "string"
      ? choices.protectedCatInstanceId
      : null;
  addLog(state, `${owner.name} juega ${definition.name}.`);
}

function swapCats(
  state: GameState,
  actor: PlayerState,
  choices: PendingEffect["choices"],
): void {
  const target = chooseTargetPlayer(state, actor.id, choices.targetPlayerId);
  const ownId = choices.ownCatInstanceId;
  const targetId = choices.targetCatInstanceId;
  if (typeof ownId !== "string" || typeof targetId !== "string") throw new RuleError("Elige un gato de cada casa.");
  const ownCat = findCat(actor, ownId);
  const targetCat = findCat(target, targetId);
  if (!ownCat || !targetCat) throw new RuleError("Uno de los gatos elegidos ya no está en su casa.");
  if (findProtectedCat(actor, ownCat.instanceId) || findProtectedCat(target, targetCat.instanceId)) {
    throw new RuleError("La Cama de Peluche impide intercambiar al gato protegido.");
  }
  removeCat(actor, ownCat);
  removeCat(target, targetCat);
  const targetCatZone = targetCat.zone === "sofa" && canFitInSofa(actor, targetCat.cardId) ? "sofa" : "salon";
  const ownCatZone = ownCat.zone === "sofa" && canFitInSofa(target, ownCat.cardId) ? "sofa" : "salon";
  placeCat(actor, { ...targetCat, ownerId: actor.id, zone: targetCatZone }, targetCatZone);
  placeCat(target, { ...ownCat, ownerId: target.id, zone: ownCatZone }, ownCatZone);
}

function removeCat(owner: PlayerState, cat: PlayerState["sofa"][number]): void {
  if (findProtectedCat(owner, cat.instanceId)) {
    throw new RuleError("La Cama de Peluche protege a ese gato y evita que se retire.");
  }
  const collection = cat.zone === "sofa" ? owner.sofa : owner.salon;
  const index = collection.findIndex((candidate) => candidate.instanceId === cat.instanceId);
  if (index < 0) throw new RuleError("No se pudo retirar el gato de su zona.");
  collection.splice(index, 1);
}

function stealSalonCat(
  state: GameState,
  actor: PlayerState,
  choices: PendingEffect["choices"],
): void {
  const target = chooseTargetPlayer(state, actor.id, choices.targetPlayerId);
  const catId = choices.targetCatInstanceId;
  if (typeof catId !== "string") throw new RuleError("Elige un gato del Salón rival.");
  const cat = target.salon.find((candidate) => candidate.instanceId === catId);
  if (!cat) throw new RuleError("Robo Felino solo puede robar un gato del Salón.");
  removeCat(target, cat);
  queueCatPlacement(state, actor, { instanceId: cat.instanceId, cardId: cat.cardId });
  addLog(state, `${actor.name} roba un gato del Salón de ${target.name} y elige dónde colocarlo.`);
}

function moveWithLaser(state: GameState, actor: PlayerState, choices: PendingEffect["choices"]): void {
  validateLaserChoices(state, actor, choices);
  const ownerId = typeof choices.ownerId === "string" ? choices.ownerId : actor.id;
  const owner = getPlayer(state, ownerId);
  const catId = choices.catInstanceId;
  const to = choices.to;
  if (typeof catId !== "string" || (to !== "sofa" && to !== "salon")) {
    throw new RuleError("Elige un gato y la zona de destino.");
  }
  moveChoice(state, actor.id, { playerId: owner.id, catInstanceId: catId, to });
}

function validateLaserChoices(
  state: GameState,
  actor: PlayerState,
  choices: PendingEffect["choices"],
): void {
  const ownerId = typeof choices.ownerId === "string" ? choices.ownerId : actor.id;
  const owner = state.players.find((player) => player.id === ownerId);
  if (!owner) throw new RuleError("Elige una casa válida para el Láser Infrarrojo.");
  if (owner.sofa.length + owner.salon.length === 0) {
    throw new RuleError("El Láser Infrarrojo solo puede afectar a una casa que tenga gatos.");
  }
  const catId = choices.catInstanceId;
  const cat = typeof catId === "string" ? findCat(owner, catId) : null;
  if (!cat) throw new RuleError("Elige un gato de la casa seleccionada.");
  if (choices.to !== "sofa" && choices.to !== "salon") {
    throw new RuleError("Elige una zona de destino para el gato.");
  }
  if (cat.zone === choices.to) throw new RuleError("Elige la otra zona para mover al gato.");
  moveCat(structuredClone(state), actor.id, {
    playerId: owner.id,
    catInstanceId: cat.instanceId,
    to: choices.to,
  });
}

function resolveGlobalChoice(
  state: GameState,
  playerId: string,
  choice: string | string[] | boolean,
): void {
  const pending = state.pendingGlobalChoice;
  if (!pending) throw new RuleError("No hay una elección global pendiente.");
  if (pending.playerIds[pending.cursor] !== playerId) throw new RuleError("Espera tu turno para elegir.");
  const player = getPlayer(state, playerId);
  if (pending.kind === "toy-exchange") {
    if (choice !== "" && (typeof choice !== "string" || !player.hand.some((card) => card.instanceId === choice))) {
      throw new RuleError("Elige una carta de tu mano o pasa si no tienes ninguna.");
    }
    if (choice === "" && player.hand.length > 0) throw new RuleError("Tienes que elegir una carta para pasar.");
    pending.choices[playerId] = choice === "" ? null : choice as string;
  } else if (pending.kind === "neighbor-dog") {
    if (choice !== "" && (typeof choice !== "string" || !player.sofa.some((cat) => cat.instanceId === choice))) {
      throw new RuleError("Elige un gato del Sofá o pasa si no puedes mover ninguno.");
    }
    if (typeof choice === "string" && choice !== "") {
      const cat = player.sofa.find((candidate) => candidate.instanceId === choice);
      if (cat && !canMoveBetweenZones(state, player, cat)) throw new RuleError("No puedes mover ese gato ahora.");
    }
    pending.choices[playerId] = choice === "" ? null : choice as string;
  } else {
    if (!Array.isArray(choice) || choice.some((id) => typeof id !== "string")) {
      throw new RuleError("Selecciona las cartas que debes descartar.");
    }
    const catCount = countCats(player);
    const required = catCount === 0 ? 0 : catCount < 4 ? 1 : 2;
    const actualRequired = Math.min(required, player.hand.length);
    if (choice.length !== actualRequired || new Set(choice).size !== choice.length) {
      throw new RuleError(`Debes seleccionar ${actualRequired} carta(s) para el Veterinario.`);
    }
    if (choice.some((id) => !player.hand.some((card) => card.instanceId === id))) {
      throw new RuleError("Una de las cartas elegidas ya no está en tu mano.");
    }
    pending.choices[playerId] = [...choice];
  }

  pending.cursor += 1;
  if (pending.cursor < pending.playerIds.length) return;

  if (pending.kind === "toy-exchange") {
    const chosen = new Map<string, CardInstance>();
    for (const [ownerId, cardId] of Object.entries(pending.choices)) {
      if (typeof cardId !== "string") continue;
      chosen.set(ownerId, removeFromHand(getPlayer(state, ownerId), cardId));
    }
    for (let index = 0; index < state.players.length; index += 1) {
      const giver = state.players[index];
      const receiver = state.players[(index + 1) % state.players.length];
      const card = chosen.get(giver.id);
      if (card) receiver.hand.push(card);
    }
    addLog(state, "Todos pasan una carta de su mano a la izquierda.");
  } else if (pending.kind === "neighbor-dog") {
    for (const ownerId of pending.playerIds) {
      const catId = pending.choices[ownerId];
      if (typeof catId !== "string") continue;
      const owner = getPlayer(state, ownerId);
      const cat = owner.sofa.find((candidate) => candidate.instanceId === catId);
      if (cat && canMoveBetweenZones(state, owner, cat)) {
        moveCat(state, ownerId, { playerId: ownerId, catInstanceId: catId, to: "salon" });
      }
    }
    addLog(state, "Cada jugador mueve un gato del Sofá al Salón si puede.");
  } else {
    for (const [ownerId, selected] of Object.entries(pending.choices)) {
      if (!Array.isArray(selected)) continue;
      const owner = getPlayer(state, ownerId);
      for (const instanceId of selected) {
        discardFromHand(state, owner, removeFromHand(owner, instanceId), true);
      }
    }
    addLog(state, "La Visita al Veterinario resuelve sus descartes.");
  }

  state.discard.push(pending.card);
  state.pendingGlobalChoice = null;
  state.phase = "action";
  checkVictory(state, pending.actorId);
}

function finishResponseWindow(state: GameState): void {
  const window = state.responseWindow;
  if (!window) throw new RuleError("No hay una respuesta que resolver.");
  const cancelled = window.stack.length % 2 === 1;
  const canceler = cancelled ? window.stack[window.stack.length - 1]?.playerId ?? null : null;
  state.discard.push(...window.stack.map((item) => item.card));
  state.responseWindow = null;
  state.phase = state.combat ? "combat" : "action";

  if (cancelled) {
    state.discard.push(window.pending.card);
    const owner = getPlayer(state, window.pending.actorId);
    const hasVictim = !hasActiveEffect(state, "nap") && activeEffectTargets(owner, "cat-victim");
    if (
      canceler &&
      hasVictim &&
      getCard(window.pending.card.cardId).kind === "action" &&
      owner.id !== canceler
    ) {
      const cancelingPlayer = getPlayer(state, canceler);
      if (cancelingPlayer.hand.length > 0) {
        const card = cancelingPlayer.hand.pop();
        if (card) discardFromHand(state, cancelingPlayer, card, true);
        addLog(state, `${cancelingPlayer.name} descarta 1 carta por Victimista.`);
      }
    }
    const actor = getPlayer(state, window.pending.actorId);
    const cardName = getCard(window.pending.card.cardId).name;
    const cancellingPlayer = canceler ? getPlayer(state, canceler) : null;
    addLog(
      state,
      cancellingPlayer
        ? `${actor.name} juega ${cardName}, pero ${cancellingPlayer.name} la cancela con Flús-Flús de Agua.`
        : `${actor.name} juega ${cardName}, pero queda cancelada por Flús-Flús de Agua.`,
    );
    if (state.combat && getCard(window.pending.card.cardId).effect === "redirect_attack") {
      state.combat.defenseExpiresAt = Date.now() + DEFENSE_TIMEOUT_MS;
    }
    if (state.combat && window.pending.choices.combatAfterSpy === true) resolveCombat(state);
    return;
  }

  resolveCardEffect(state, window.pending);
}

function startPlayedCard(state: GameState, actor: PlayerState, card: CardInstance, choices: PendingEffect["choices"]): void {
  const definition = getCard(card.cardId);
  const pending: PendingEffect = { id: randomUUID(), actorId: actor.id, card, choices };
  if (definition.cancelable && definition.effect !== "cancel") {
    beginResponseWindow(state, pending);
    return;
  }
  resolveCardEffect(state, pending);
}

function playCard(
  state: GameState,
  player: PlayerState,
  command: Extract<GameCommand, { type: "play-card" }>,
): void {
  if (state.phase !== "action" || state.actionsRemaining < 1) throw new RuleError("No tienes una acción disponible.");
  const card = player.hand.find((candidate) => candidate.instanceId === command.cardInstanceId);
  if (!card) throw new RuleError("Esa carta no está en tu mano.");
  const definition = getCard(card.cardId);
  if (
    definition.kind === "cat" ||
    definition.kind === "attack" ||
    definition.kind === "support" ||
    definition.kind === "response" ||
    (definition.kind === "object" && definition.effect !== "retrieve_discard") ||
    definition.effect === "spy"
  ) {
    throw new RuleError("Esa carta no se puede jugar como acción principal.");
  }
  const choices = command.choices ?? {};
  if (definition.effect === "move_cat") validateLaserChoices(state, player, choices);
  removeFromHand(player, card.instanceId);
  state.actionsRemaining -= 1;
  state.actionUsed = true;
  startPlayedCard(state, player, card, choices);
}

function resolvePassResponse(state: GameState, playerId: string): void {
  requireResponsePlayer(state, playerId);
  const window = state.responseWindow;
  if (!window) throw new RuleError("No hay respuesta pendiente.");
  window.cursor += 1;
  if (window.cursor >= window.order.length) {
    finishResponseWindow(state);
  } else {
    window.expiresAt = Date.now() + RESPONSE_TIMEOUT_MS;
  }
}

function resolveFlush(state: GameState, playerId: string, instanceId: string): void {
  requireResponsePlayer(state, playerId);
  const window = state.responseWindow;
  if (!window) throw new RuleError("No hay una carta pendiente de respuesta.");
  if (Date.now() >= window.expiresAt) {
    resolvePassResponse(state, playerId);
    return;
  }
  const player = getPlayer(state, playerId);
  const card = player.hand.find((candidate) => candidate.instanceId === instanceId);
  if (!card || getCard(card.cardId).effect !== "cancel") throw new RuleError("Elige un Flús-Flús de tu mano.");
  const target = window.stack.length > 0 ? window.stack[window.stack.length - 1].card : window.pending.card;
  if (!getCard(target.cardId).cancelable) throw new RuleError("Esa carta no se puede cancelar.");
  player.hand.splice(player.hand.findIndex((candidate) => candidate.instanceId === instanceId), 1);
  window.stack.push({ playerId, card });
  window.order = nextResponseOrder(state, playerId);
  window.cursor = 0;
  window.expiresAt = Date.now() + RESPONSE_TIMEOUT_MS;
  addLog(state, `${player.name} juega Flús-Flús de Agua.`);
}

function validateTarget(
  state: GameState,
  attackerId: string,
  targetPlayerId: string,
  targetCardInstanceId: string,
): void {
  if (attackerId === targetPlayerId) throw new RuleError("No puedes atacar tu propia casa.");
  const owner = getPlayer(state, targetPlayerId);
  const cat = findCat(owner, targetCardInstanceId);
  if (cat) {
    if (findProtectedCat(owner, cat.instanceId)) throw new RuleError("La Cama de Peluche protege a ese gato.");
    if (owner.structure?.cardId === "structure-box" || owner.structure?.cardId === "structure-fortress") {
      throw new RuleError("Una Estructura protege a los gatos de los ataques directos.");
    }
    return;
  }
  if (owner.structure?.instanceId === targetCardInstanceId) {
    if (owner.structure.cardId === "structure-bed") throw new RuleError("La Cama no puede ser objetivo de un ataque.");
    return;
  }
  throw new RuleError("El objetivo elegido ya no existe.");
}

function declareAttack(
  state: GameState,
  attacker: PlayerState,
  command: Extract<GameCommand, { type: "declare-attack" }>,
): void {
  if (state.phase !== "action" || state.actionsRemaining < 1) throw new RuleError("No tienes una acción disponible.");
  validateTarget(state, attacker.id, command.targetPlayerId, command.targetCardInstanceId);
  const attack = attacker.hand.find((card) => card.instanceId === command.attackInstanceId);
  if (!attack || getCard(attack.cardId).kind !== "attack") throw new RuleError("Elige una carta de Ataque.");
  const supports = command.supportInstanceIds.map((id) => {
    const card = attacker.hand.find((candidate) => candidate.instanceId === id);
    if (!card || getCard(card.cardId).kind !== "support") throw new RuleError("Cada Apoyo debe estar en tu mano.");
    return card;
  });
  if (new Set(command.supportInstanceIds).size !== command.supportInstanceIds.length) {
    throw new RuleError("No puedes usar el mismo Apoyo dos veces.");
  }
  removeFromHand(attacker, attack.instanceId);
  for (const support of supports) removeFromHand(attacker, support.instanceId);
  state.actionsRemaining -= 1;
  state.actionUsed = true;
  const target = getPlayer(state, command.targetPlayerId);
  state.combat = {
    attackerId: attacker.id,
    initialTargetId: target.id,
    targetPlayerId: target.id,
    targetCardInstanceId: command.targetCardInstanceId,
    redirectPlayerId: target.id,
    attack,
    attackSupports: supports,
    defense: null,
    defenseSupports: [],
    defenseExpiresAt: Date.now() + DEFENSE_TIMEOUT_MS,
    revealed: false,
    redirectedPlayers: [],
    spentResponseCards: [],
  };
  if (attacker.scratcherArmed && !attacker.scratcherUsed) attacker.scratcherUsed = true;
  state.phase = "combat";
  addLog(state, `${attacker.name} declara un ataque contra ${target.name}.`);
}

function getCombatBase(card: CardInstance, owner: PlayerState, opponent: PlayerState): number {
  const definition = getCard(card.cardId);
  if (definition.damage === "own-cat-count") return countCats(owner);
  if (definition.damage === "opponent-cat-count") return countCats(opponent);
  return definition.damage ?? 0;
}

function supportPower(cards: CardInstance[]): number {
  return cards.reduce((sum, card) => sum + (getCard(card.cardId).bonus ?? 0), 0);
}

function resolveCombat(state: GameState): void {
  const combat = state.combat;
  if (!combat) throw new RuleError("No hay un combate activo.");
  const attacker = getPlayer(state, combat.attackerId);
  const defender = getPlayer(state, combat.targetPlayerId);
  const targetCat = findCat(defender, combat.targetCardInstanceId);
  const targetIsStructure = defender.structure?.instanceId === combat.targetCardInstanceId;
  if (!targetCat && !targetIsStructure) throw new RuleError("El objetivo del combate ya no existe.");
  const attackBase = getCombatBase(combat.attack, attacker, defender);
  const attackBonus =
    (!hasActiveEffect(state, "nap") && activeEffectTargets(attacker, "cat-neighborhood") && !synergyIsActive(attacker, "neighborhood-veterans", state) ? 1 : 0) +
    (!hasActiveEffect(state, "nap") && targetIsStructure && activeEffectTargets(attacker, "cat-envious") ? 1 : 0) +
    (attacker.scratcherUsed && attacker.scratcherArmed ? 1 : 0);
  const attackPower = attackBase + supportPower(combat.attackSupports) + attackBonus;
  const defensePower = combat.defense
    ? getCombatBase(combat.defense, defender, attacker) +
      supportPower(combat.defenseSupports) +
      (!hasActiveEffect(state, "nap") && activeEffectTargets(defender, "cat-territorial") && !synergyIsActive(defender, "neighborhood-veterans", state) ? 1 : 0)
    : null;
  const succeeded = defensePower === null || attackPower > defensePower;
  const targetZone = targetCat?.zone;
  let destroyedStructure: CardInstance | null = null;
  const defenderHasTriggeredCat =
    targetZone === "sofa" &&
    !hasActiveEffect(state, "nap") &&
    activeEffectTargets(defender, succeeded ? "cat-diurnal" : "cat-nocturnal");

  if (succeeded) {
    if (targetCat) {
      removeCat(defender, targetCat);
      queueCatPlacement(state, attacker, { instanceId: targetCat.instanceId, cardId: targetCat.cardId });
      addLog(state, `${attacker.name} captura un gato de ${defender.name} y elige dónde colocarlo.`);
    } else {
      destroyedStructure = discardStructure(state, defender);
      addLog(state, `${attacker.name} destruye la Estructura de ${defender.name}.`);
    }
  } else {
    addLog(state, `${defender.name} detiene el ataque.`);
  }

  if (defenderHasTriggeredCat && attacker.hand.length > 0) {
    state.pendingDiscard = {
      playerIds: [attacker.id],
      cursor: 0,
      countByPlayer: { [attacker.id]: 1 },
      reason: `habilidad de ${defender.name}`,
      next: "finish_combat",
      toLitter: true,
    };
    state.phase = "discard";
    addLog(state, `${attacker.name} debe descartar 1 carta por una habilidad de ${defender.name}.`);
    return;
  }

  if (
    succeeded &&
    destroyedStructure &&
    attacker.hand.length > 0 &&
    !hasActiveEffect(state, "nap") &&
    synergyIsActive(attacker, "envious-raiders", state)
  ) {
    state.pendingSalvage = { playerId: attacker.id, structureCard: destroyedStructure };
    state.pendingChoices[attacker.id] = "salvage-structure";
    state.phase = "choice";
    addLog(state, `${attacker.name} puede pagar una carta para recuperar la Estructura.`);
    return;
  }

  if (succeeded && targetCat) return;
  finishCombat(state);
}

function acceptExpiredDefense(state: GameState, playerId: string): void {
  const combat = state.combat;
  if (!combat || combat.targetPlayerId !== playerId) {
    throw new RuleError("No hay un ataque pendiente para aceptar.");
  }
  const defender = getPlayer(state, playerId);
  combat.defense = null;
  combat.defenseSupports = [];
  combat.defenseExpiresAt = null;
  combat.revealed = true;
  resolveCombat(state);
  addLog(state, `${defender.name} no respondió en 30 segundos y acepta el ataque sin defenderse.`);
}

function finishCombat(state: GameState): void {
  const combat = state.combat;
  if (!combat) throw new RuleError("No hay un combate que terminar.");
  const attacker = getPlayer(state, combat.attackerId);
  const defender = getPlayer(state, combat.targetPlayerId);
  state.discard.push(combat.attack, ...combat.attackSupports);
  if (combat.defense) state.discard.push(combat.defense);
  state.discard.push(...combat.defenseSupports, ...combat.spentResponseCards);
  state.combat = null;
  state.phase = "action";
  if (!checkVictory(state, attacker.id)) checkVictory(state, defender.id);
}

function chooseDefense(
  state: GameState,
  player: PlayerState,
  command: Extract<GameCommand, { type: "choose-defense" }>,
): void {
  const combat = state.combat;
  if (state.phase !== "combat" || !combat || combat.targetPlayerId !== player.id) {
    throw new RuleError("No eres quien debe elegir la defensa.");
  }
  const defense = command.defenseInstanceId
    ? player.hand.find((card) => card.instanceId === command.defenseInstanceId) ?? null
    : null;
  if (command.defenseInstanceId && (!defense || getCard(defense.cardId).kind !== "attack")) {
    throw new RuleError("La defensa debe ser una carta de Ataque de tu mano.");
  }
  const supports = command.supportInstanceIds.map((id) => {
    const card = player.hand.find((candidate) => candidate.instanceId === id);
    if (!card || getCard(card.cardId).kind !== "support") throw new RuleError("Cada Apoyo de defensa debe estar en tu mano.");
    return card;
  });
  if (!defense && supports.length > 0) throw new RuleError("Los Apoyos no pueden defender por sí solos.");
  if (new Set(command.supportInstanceIds).size !== command.supportInstanceIds.length) {
    throw new RuleError("No puedes usar el mismo Apoyo dos veces.");
  }
  if (defense) removeFromHand(player, defense.instanceId);
  for (const support of supports) removeFromHand(player, support.instanceId);
  combat.defense = defense;
  combat.defenseSupports = supports;
  combat.defenseExpiresAt = null;
  combat.revealed = true;
  if (command.spyInstanceId) {
    const spy = player.hand.find((card) => card.instanceId === command.spyInstanceId);
    if (!spy || spy.cardId !== "action-spy") throw new RuleError("Espía de Ventana no está en tu mano.");
    removeFromHand(player, spy.instanceId);
    beginResponseWindow(state, {
      id: randomUUID(),
      actorId: player.id,
      card: spy,
      choices: { combatAfterSpy: true },
    });
    return;
  }
  resolveCombat(state);
}

function redirectAttack(
  state: GameState,
  player: PlayerState,
  command: Extract<GameCommand, { type: "redirect-attack" }>,
): void {
  const combat = state.combat;
  if (state.phase !== "combat" || !combat || combat.redirectPlayerId !== player.id) {
    throw new RuleError("No puedes desviar este ataque ahora.");
  }
  if (combat.redirectedPlayers.includes(player.id)) {
    throw new RuleError("Ya has decidido qué hacer con este ataque.");
  }
  const card = player.hand.find((candidate) => candidate.instanceId === command.cardInstanceId);
  if (!card || card.cardId !== "object-mouse") throw new RuleError("Ratón con Hierba Gatuna no está en tu mano.");
  validateTarget(state, combat.attackerId, command.targetPlayerId, command.targetCardInstanceId);
  removeFromHand(player, card.instanceId);
  const pending: PendingEffect = {
    id: randomUUID(),
    actorId: player.id,
    card,
    choices: {
      targetPlayerId: command.targetPlayerId,
      targetCardInstanceId: command.targetCardInstanceId,
    },
  };
  beginResponseWindow(state, pending);
}

function passRedirect(state: GameState, player: PlayerState): void {
  const combat = state.combat;
  if (
    state.phase !== "combat" ||
    !combat ||
    combat.redirectPlayerId !== player.id ||
    combat.targetPlayerId !== player.id ||
    combat.redirectedPlayers.includes(player.id)
  ) {
    throw new RuleError("No puedes pasar el desvío de este ataque ahora.");
  }
  if (!player.hand.some((card) => card.cardId === "object-mouse")) {
    throw new RuleError("No tienes un Ratón con Hierba Gatuna para decidir si lo usas.");
  }
  combat.redirectedPlayers.push(player.id);
}

function revealAttack(
  state: GameState,
  player: PlayerState,
  command: Extract<GameCommand, { type: "reveal-attack" }>,
): void {
  const combat = state.combat;
  if (state.phase !== "combat" || !combat || combat.targetPlayerId !== player.id) {
    throw new RuleError("Solo el defensor puede consultar este ataque.");
  }
  if (command.method === "nosy") {
    if (hasActiveEffect(state, "nap") || !activeEffectTargets(player, "cat-nosy")) {
      throw new RuleError("No tienes un Gato Cotilla activo.");
    }
    if (!synergyIsActive(player, "information-partners", state)) {
      if (!command.cardInstanceId) throw new RuleError("Cotilla necesita descartar una carta.");
      discardFromHand(state, player, removeFromHand(player, command.cardInstanceId));
    }
  } else {
    throw new RuleError("Espía se juega junto con la elección de defensa.");
  }
  combat.revealed = true;
  addLog(state, `${player.name} revela el Ataque y sus Apoyos.`);
}

function finishMovement(state: GameState): void {
  const player = activePlayer(state);
  if (player.structure?.cardId === "structure-litter" && player.litter.length >= 3) {
    state.phase = "litter";
    return;
  }
  state.phase = "discard";
  checkHandLimit(state);
}

function handLimit(state: GameState, player: PlayerState): number {
  return !hasActiveEffect(state, "nap") && activeEffectTargets(player, "cat-hoarder") ? 9 : 7;
}

function closeTurn(state: GameState): void {
  const player = activePlayer(state);
  player.actionBonusPrestige = 0;
  player.purrPrestigeCatIds = [];
  player.turnFlags = [];
  if (checkVictory(state, player.id)) return;
  reorderForNextTurn(state);
  startCurrentTurn(state);
}

function checkHandLimit(state: GameState): void {
  const player = activePlayer(state);
  const excess = Math.max(0, player.hand.length - handLimit(state, player));
  if (excess > 0) {
    state.pendingDiscard = {
      playerIds: [player.id],
      cursor: 0,
      countByPlayer: { [player.id]: excess },
      reason: "límite de mano",
      next: "end_turn",
      toLitter: false,
    };
    state.phase = "discard";
  } else {
    closeTurn(state);
  }
}

function resolveDiscard(state: GameState, playerId: string, instanceIds: string[]): void {
  const pending = state.pendingDiscard;
  if (!pending || pending.playerIds[pending.cursor] !== playerId) {
    throw new RuleError("No tienes un descarte pendiente.");
  }
  const player = getPlayer(state, playerId);
  const required = pending.countByPlayer[playerId] ?? 0;
  if (instanceIds.length !== required || new Set(instanceIds).size !== instanceIds.length) {
    throw new RuleError(`Debes descartar exactamente ${required} carta(s).`);
  }
  if (instanceIds.some((id) => !player.hand.some((card) => card.instanceId === id))) {
    throw new RuleError("Una de las cartas elegidas ya no está en tu mano.");
  }
  for (const id of instanceIds) {
    const card = removeFromHand(player, id);
    if (pending.toLitter) discardFromHand(state, player, card, true);
    else state.discard.push(card);
  }
  pending.cursor += 1;
  if (pending.cursor < pending.playerIds.length) return;
  const next = pending.next;
  state.pendingDiscard = null;
  if (next === "end_turn") closeTurn(state);
  else if (next === "finish_combat") finishCombat(state);
  else state.phase = "action";
}

function resolveLitter(state: GameState, player: PlayerState, recoverId: string | null): void {
  if (state.phase !== "litter" || player.structure?.cardId !== "structure-litter") {
    throw new RuleError("No tienes una ventana de Arenero pendiente.");
  }
  if (recoverId) {
    const index = player.litter.findIndex((card) => card.instanceId === recoverId);
    if (index < 0) throw new RuleError("La carta elegida no está sobre el Arenero.");
    player.hand.push(player.litter.splice(index, 1)[0]);
    state.discard.push(...player.litter.splice(0));
    addLog(state, `${player.name} recupera una carta del Arenero.`);
  } else {
    addLog(state, `${player.name} deja las cartas en el Arenero.`);
  }
  state.phase = "discard";
  checkHandLimit(state);
}

function resolveCurrentCommand(state: GameState, playerId: string, command: GameCommand): void {
  if (state.phase === "finished") throw new RuleError("La partida ya ha terminado.");

  const drawNotice = state.pendingDrawNotices[playerId];
  if (drawNotice?.length) {
    if (command.type === "acknowledge-draw") {
      delete state.pendingDrawNotices[playerId];
      return;
    }
    if (command.type !== "choose-drawn-cats") {
      throw new RuleError("Confirma primero las cartas que has robado.");
    }
  } else if (command.type === "acknowledge-draw") {
    throw new RuleError("No tienes cartas robadas pendientes de confirmar.");
  }

  if (state.phase === "initial_placement") {
    if (command.type !== "choose-initial-cats") {
      throw new RuleError("Elige dónde colocar tus gatos iniciales antes de continuar.");
    }
    return chooseInitialCats(state, playerId, command);
  }

  if (Object.keys(state.pendingCatPlacements).length > 0) {
    if (command.type !== "choose-drawn-cats") {
      throw new RuleError("Elige dónde colocar los gatos recibidos antes de continuar.");
    }
    return chooseDrawnCats(state, playerId, command);
  }
  if (command.type === "choose-drawn-cats") {
    throw new RuleError("No tienes gatos pendientes de colocar.");
  }

  if (state.responseWindow) {
    if (command.type === "respond-flush") return resolveFlush(state, playerId, command.cardInstanceId);
    if (command.type === "pass-response") return resolvePassResponse(state, playerId);
    throw new RuleError("Resuelve la ventana de Flús-Flús antes de continuar.");
  }

  if (
    state.combat &&
    state.combat.defenseExpiresAt !== null &&
    state.combat.defenseExpiresAt <= Date.now()
  ) {
    acceptExpiredDefense(state, state.combat.targetPlayerId);
    return;
  }

  if (command.type === "resolve-choice") {
    return resolvePrivateChoice(state, playerId, command.choice);
  }
  if (state.pendingDiscard) {
    if (command.type !== "discard-cards") throw new RuleError("Resuelve el descarte pendiente antes de continuar.");
    return resolveDiscard(state, playerId, command.cardInstanceIds);
  }
  if (state.pendingGlobalChoice) {
    throw new RuleError("Resuelve la elección global antes de continuar.");
  }

  if (command.type === "choose-initial-draw") {
    if (state.phase !== "pre_action" || state.initialDrawChoicePlayerId !== playerId) {
      throw new RuleError("No tienes que elegir el robo inicial.");
    }
    drawInitial(state, getPlayer(state, playerId), command.useRaccoon);
    return;
  }
  if (state.initialDrawChoicePlayerId) {
    throw new RuleError("Elige primero el robo inicial.");
  }
  if (command.type === "choose-defense") {
    return chooseDefense(state, getPlayer(state, playerId), command);
  }
  if (command.type === "redirect-attack") {
    return redirectAttack(state, getPlayer(state, playerId), command);
  }
  if (command.type === "pass-redirect") {
    return passRedirect(state, getPlayer(state, playerId));
  }
  if (command.type === "reveal-attack") {
    return revealAttack(state, getPlayer(state, playerId), command);
  }

  const player = requireCurrentPlayer(state, playerId);
  switch (command.type) {
    case "skip-action-phase":
      skipActionPhase(state, player);
      return;
    case "activate-preaction":
      if (state.phase !== "action" || state.actionUsed) {
        throw new RuleError("Las habilidades previas solo se usan antes de tu primera acción.");
      }
      activatePreaction(state, player, command);
      return;
    case "play-card":
      playCard(state, player, command);
      return;
    case "declare-attack":
      declareAttack(state, player, command);
      return;
    case "move":
      if (state.phase !== "movement") throw new RuleError("El movimiento habitual se realiza después de la Fase de Acción.");
      if (player.turnFlags.includes("regular-move-used")) throw new RuleError("Ya has realizado el movimiento gatuno de este turno.");
      moveChoice(state, player.id, command.movement);
      player.turnFlags.push("regular-move-used");
      checkVictory(state, player.id);
      return;
    case "finish-movement":
      if (state.phase !== "movement") throw new RuleError("No estás en la fase de movimiento.");
      finishMovement(state);
      return;
    case "resolve-litter":
      return resolveLitter(state, player, command.recoverCardInstanceId);
    case "discard-cards":
      if (!state.pendingDiscard) throw new RuleError("No tienes un descarte pendiente.");
      return resolveDiscard(state, player.id, command.cardInstanceIds);
    case "respond-flush":
    case "pass-response":
      throw new RuleError("No hay una elección pendiente de ese tipo.");
  }
}

export function applyGameCommand(state: GameState, playerId: string, command: GameCommand): GameState {
  const next = structuredClone(state);
  resolveCurrentCommand(next, playerId, command);
  const currentPlayerId = next.players[next.currentPlayerIndex]?.id;
  if (
    next.phase === "action" &&
    next.actionUsed &&
    next.actionsRemaining === 0 &&
    (!currentPlayerId || !next.pendingDrawNotices[currentPlayerId])
  ) {
    next.phase = "movement";
  }
  return next;
}

export function expireCombatDefense(
  state: GameState,
  playerId: string,
  expectedExpiresAt: number,
): GameState | null {
  const combat = state.combat;
  if (
    !combat ||
    state.responseWindow ||
    combat.targetPlayerId !== playerId ||
    combat.defenseExpiresAt !== expectedExpiresAt ||
    expectedExpiresAt > Date.now()
  ) {
    return null;
  }
  const next = structuredClone(state);
  acceptExpiredDefense(next, playerId);
  return next;
}
