import type {
  GameState,
  PrivateGameState,
  PublicGameState,
} from "../../shared/game-types.js";
import { SYNERGIES } from "../../shared/synergies.js";
import { findProtectedCat, getPrestige, synergyIsActive, targetPrestige } from "./rules.js";

function hasLegalRedirectTarget(state: GameState, targetPlayerId: string): boolean {
  const combat = state.combat;
  if (!combat) return false;
  return state.players.some((owner) => {
    if (owner.id === combat.attackerId) return false;
    const hasCatTarget =
      owner.structure?.cardId !== "structure-box" &&
      owner.structure?.cardId !== "structure-fortress" &&
      [...owner.sofa, ...owner.salon].some((cat) =>
        !findProtectedCat(owner, cat.instanceId) &&
        !(owner.id === combat.targetPlayerId && cat.instanceId === combat.targetCardInstanceId),
      );
    const hasStructureTarget =
      owner.structure !== null &&
      owner.structure.cardId !== "structure-bed" &&
      !(owner.id === combat.targetPlayerId && owner.structure.instanceId === combat.targetCardInstanceId);
    return hasCatTarget || hasStructureTarget;
  });
}

function waitingPlayerIds(state: GameState): string[] {
  if (state.phase === "initial_placement") return Object.keys(state.initialCatChoices);
  if (Object.keys(state.pendingPrivateNotices).length > 0) return Object.keys(state.pendingPrivateNotices);
  if (Object.keys(state.pendingDrawNotices).length > 0) return Object.keys(state.pendingDrawNotices);
  if (Object.keys(state.pendingCatPlacements).length > 0) return Object.keys(state.pendingCatPlacements);
  if (state.responseWindow) {
    const playerId = state.responseWindow.order[state.responseWindow.cursor];
    return playerId ? [playerId] : [];
  }
  if (state.pendingDiscard) {
    const playerId = state.pendingDiscard.playerIds[state.pendingDiscard.cursor];
    return playerId ? [playerId] : [];
  }
  if (state.pendingGlobalChoice) {
    const playerId = state.pendingGlobalChoice.playerIds[state.pendingGlobalChoice.cursor];
    return playerId ? [playerId] : [];
  }
  if (state.pendingChoices) {
    const playerIds = Object.keys(state.pendingChoices);
    if (playerIds.length > 0) return playerIds;
  }
  if (state.combat) return [state.combat.targetPlayerId];
  if (state.initialDrawChoicePlayerId) return [state.initialDrawChoicePlayerId];
  if (state.phase === "finished" || state.phase === "lobby") return [];
  const currentPlayerId = state.players[state.currentPlayerIndex]?.id;
  return currentPlayerId ? [currentPlayerId] : [];
}

export function projectPublicState(state: GameState): PublicGameState {
  const currentPlayerId =
    state.phase === "initial_placement" ? null : state.players[state.currentPlayerIndex]?.id ?? null;
  const combat = state.combat;
  const revealed = combat?.revealed ?? false;
  const responseWindow = state.responseWindow;
  const lastFlush = responseWindow?.stack[responseWindow.stack.length - 1];

  return {
    id: state.id,
    roomId: state.roomId,
    phase: state.phase,
    players: state.players.map((player, index) => ({
      id: player.id,
      name: player.name,
      handCount: player.hand.length,
      sofa: structuredClone(player.sofa),
      salon: structuredClone(player.salon),
      structure: player.structure ? structuredClone(player.structure) : null,
      structureProtectedCatId: player.structure?.cardId === "structure-bed"
        ? player.structureProtectedCatId
        : null,
      litterCount: player.litter.length,
      prestige: getPrestige(player, state),
      targetPrestige: targetPrestige(state.players.length),
      isCurrentPlayer: state.phase !== "initial_placement" && index === state.currentPlayerIndex,
      skipNextTurn: player.skipNextTurn,
      activeSynergies: SYNERGIES
        .filter((synergy) => synergyIsActive(player, synergy.id, state))
        .map((synergy) => synergy.id),
    })),
    currentPlayerId,
    round: state.round,
    turnNumber: state.turnNumber,
    actionsRemaining: state.actionsRemaining,
    actionUsed: state.actionUsed,
    initialPlacementPlayerIds: Object.keys(state.initialCatChoices),
    pendingCatPlacementPlayerIds: Object.keys(state.pendingCatPlacements),
    pendingDrawNoticePlayerIds: Object.keys(state.pendingDrawNotices),
    pendingPrivateNoticePlayerIds: Object.keys(state.pendingPrivateNotices),
    waitingPlayerIds: waitingPlayerIds(state),
    initialDrawChoicePlayerId: state.initialDrawChoicePlayerId,
    deckCount: state.deck.length,
    discardCount: state.discard.length,
    discard: structuredClone(state.discard),
    activeEffects: structuredClone(state.activeEffects),
    responseWindow: responseWindow
      ? {
          actorId: lastFlush?.playerId ?? responseWindow.pending.actorId,
          cardId: lastFlush?.card.cardId ?? responseWindow.pending.card.cardId,
          recipientIds: [...responseWindow.order],
          cursor: responseWindow.cursor,
          stackLength: responseWindow.stack.length,
          expiresAt: responseWindow.expiresAt,
          pendingActorId: responseWindow.pending.actorId,
          pendingCardId: responseWindow.pending.card.cardId,
        }
      : null,
    combat: combat
      ? {
          attackerId: combat.attackerId,
          initialTargetId: combat.initialTargetId,
          targetPlayerId: combat.targetPlayerId,
          targetCardInstanceId: combat.targetCardInstanceId,
          revealed,
          attackCardIds: revealed
            ? [combat.attack.cardId, ...combat.attackSupports.map((card) => card.cardId)]
            : [],
          defenseCardId: revealed ? combat.defense?.cardId ?? null : null,
          defenseSupportCardIds: revealed ? combat.defenseSupports.map((card) => card.cardId) : [],
          attackDamage: revealed ? combat.attackDamage : null,
          defenseDamage: revealed ? combat.defenseDamage : null,
          redirectPlayerId: combat.redirectPlayerId,
          defenseExpiresAt: combat.defenseExpiresAt,
        }
      : null,
    pendingGlobalChoice: state.pendingGlobalChoice
      ? {
          kind: state.pendingGlobalChoice.kind,
          actorId: state.pendingGlobalChoice.actorId,
          playerIds: [...state.pendingGlobalChoice.playerIds],
          cursor: state.pendingGlobalChoice.cursor,
        }
      : null,
    pendingDiscard: state.pendingDiscard ? structuredClone(state.pendingDiscard) : null,
    announcement: state.announcement ? structuredClone(state.announcement) : null,
    lastCombatResult: state.lastCombatResult ? structuredClone(state.lastCombatResult) : null,
    winnerId: state.winnerId,
    endedReason: state.endedReason,
    log: structuredClone(state.log),
  };
}

export function projectPrivateState(state: GameState, playerId: string): PrivateGameState {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new Error("Cannot project private state for an unknown player.");

  return {
    playerId,
    hand: structuredClone(player.hand),
    litter: structuredClone(player.litter),
    initialPlacementCats: structuredClone(state.initialCatChoices[playerId] ?? []),
    pendingCatPlacements: structuredClone(state.pendingCatPlacements[playerId] ?? []),
    pendingDrawNotice: structuredClone(state.pendingDrawNotices[playerId]?.[0] ?? null),
    pendingPrivateNotice: structuredClone(state.pendingPrivateNotices[playerId]?.[0] ?? null),
    privateCombatCards: state.combat?.attackerId === playerId
      ? structuredClone([state.combat.attack, ...state.combat.attackSupports])
      : [],
    privateAttackDamage: state.combat?.attackerId === playerId
      ? state.combat.attackDamage
      : null,
    yourTurn:
      state.players[state.currentPlayerIndex]?.id === playerId ||
      Boolean(state.initialCatChoices[playerId]) ||
      Boolean(state.pendingCatPlacements[playerId]) ||
      Boolean(state.pendingDrawNotices[playerId]?.length) ||
      Boolean(state.pendingPrivateNotices[playerId]?.length) ||
      state.pendingDiscard?.playerIds[state.pendingDiscard.cursor] === playerId ||
      state.pendingGlobalChoice?.playerIds[state.pendingGlobalChoice.cursor] === playerId ||
      state.responseWindow?.order[state.responseWindow.cursor] === playerId ||
      state.combat?.redirectPlayerId === playerId ||
      state.combat?.targetPlayerId === playerId,
    availableActions: [],
    pendingChoice: state.pendingChoices[playerId] ?? null,
    redirectAvailable: Boolean(
      state.phase === "combat" &&
        state.combat?.redirectPlayerId === playerId &&
        state.combat.targetPlayerId === playerId &&
        !state.combat.redirectedPlayers.includes(playerId) &&
        player.hand.some((card) => card.cardId === "object-mouse") &&
        hasLegalRedirectTarget(state, playerId),
    ),
    peekedCards: structuredClone(state.privatePeeks[playerId] ?? []),
  };
}
