import { describe, expect, it } from "vitest";
import { drawCards, takeTopCard } from "./deck.js";
import { applyGameCommand, createGame } from "./game-engine.js";
import { projectPrivateState, projectPublicState } from "./projections.js";

describe("card draws and discard reshuffles", () => {
  it("asks the owner to place a drawn cat and keeps it private until then", () => {
    const state = createGame("test-room", [
      { id: "player-1", name: "gato1" },
      { id: "player-2", name: "gato2" },
    ]);
    const player = state.players[0];
    if (!player) throw new Error("The test game needs a player.");
    const cat = { instanceId: "drawn-cat", cardId: "cat-underfed" };
    state.phase = "action";
    state.initialCatChoices = {};
    state.pendingCatPlacements = {};
    state.pendingDrawNotices = {};
    state.deck = [cat];
    state.discard = [];

    expect(drawCards(state, player, 1)).toBe(1);
    expect(state.pendingCatPlacements[player.id]).toEqual([cat]);
    expect(player.sofa).not.toContainEqual(expect.objectContaining({ instanceId: cat.instanceId }));
    expect(player.salon).not.toContainEqual(expect.objectContaining({ instanceId: cat.instanceId }));
    expect(JSON.stringify(projectPublicState(state))).not.toContain(cat.instanceId);
    expect(projectPrivateState(state, player.id).pendingCatPlacements).toEqual([cat]);

    const placed = applyGameCommand(state, player.id, {
      type: "choose-drawn-cats",
      placements: [{ catInstanceId: cat.instanceId, to: "sofa" }],
    });
    expect(placed.players[0]?.sofa).toContainEqual(expect.objectContaining({ instanceId: cat.instanceId }));
    expect(placed.pendingCatPlacements).toEqual({});
  });

  it("leaves the newest discard card in the discard pile when rebuilding the deck", () => {
    const state = createGame("test-room", [
      { id: "player-1", name: "gato1" },
      { id: "player-2", name: "gato2" },
    ]);
    const older = { instanceId: "old-discard", cardId: "object-mouse" };
    const newest = { instanceId: "top-discard", cardId: "action-skip" };
    state.deck = [];
    state.discard = [older, newest];

    expect(takeTopCard(state, () => 0)).toEqual(older);
    expect(state.discard).toEqual([newest]);
    expect(state.deck).toEqual([]);

    state.discard = [newest];
    expect(takeTopCard(state, () => 0)).toBeNull();
    expect(state.discard).toEqual([newest]);
  });

  it("ends the action phase automatically after the last action is spent", () => {
    const state = createGame("test-room", [
      { id: "player-1", name: "gato1" },
      { id: "player-2", name: "gato2" },
    ]);
    const player = state.players[0];
    if (!player) throw new Error("The test game needs a player.");
    state.phase = "action";
    state.initialCatChoices = {};
    state.pendingCatPlacements = {};
    state.pendingDrawNotices = {};
    state.currentPlayerIndex = 0;
    state.actionsRemaining = 1;
    state.actionUsed = false;
    player.hand = [{ instanceId: "draw-two", cardId: "consumable-tuna" }];
    state.deck = [
      { instanceId: "drawn-object-1", cardId: "object-mouse" },
      { instanceId: "drawn-object-2", cardId: "object-mouse" },
    ];

    const next = applyGameCommand(state, player.id, {
      type: "play-card",
      cardInstanceId: "draw-two",
    });
    expect(next.phase).toBe("action");
    expect(next.actionsRemaining).toBe(0);
    expect(next.actionUsed).toBe(true);

    const firstConfirmed = applyGameCommand(next, player.id, { type: "acknowledge-draw" });
    expect(firstConfirmed.phase).toBe("action");
    expect(projectPrivateState(firstConfirmed, player.id).pendingDrawNotice?.card.instanceId).toBe("drawn-object-1");

    const confirmed = applyGameCommand(firstConfirmed, player.id, { type: "acknowledge-draw" });
    expect(confirmed.phase).toBe("movement");
  });

  it("does not allow skipping after an action has already been used", () => {
    const state = createGame("test-room", [
      { id: "player-1", name: "gato1" },
      { id: "player-2", name: "gato2" },
    ]);
    const player = state.players[0];
    if (!player) throw new Error("The test game needs a player.");
    state.phase = "action";
    state.currentPlayerIndex = 0;
    state.pendingCatPlacements = {};
    state.pendingDrawNotices = {};
    state.actionUsed = true;
    state.actionsRemaining = 1;

    expect(() => applyGameCommand(state, player.id, { type: "skip-action-phase" })).toThrow(
      "Solo puedes saltar la Fase de Acción antes de realizar una acción.",
    );
  });

  it("allows the Sisal Scratcher to be armed only in a turn after it was played", () => {
    const state = createGame("test-room", [
      { id: "player-1", name: "gato1" },
      { id: "player-2", name: "gato2" },
    ]);
    const player = state.players[0];
    if (!player) throw new Error("The test game needs a player.");
    state.phase = "action";
    state.currentPlayerIndex = 0;
    state.initialCatChoices = {};
    state.pendingCatPlacements = {};
    state.pendingDrawNotices = {};
    state.pendingPrivateNotices = {};
    state.initialDrawChoicePlayerId = null;
    state.actionsRemaining = 1;
    state.actionUsed = false;
    player.hand = [{ instanceId: "scratcher-card", cardId: "structure-scratcher" }];

    const played = applyGameCommand(state, player.id, {
      type: "play-card",
      cardInstanceId: "scratcher-card",
    });
    expect(played.phase).toBe("movement");
    expect(played.players[0]?.scratcherArmed).toBe(false);

    const nextTurnPlayer = played.players[0];
    if (!nextTurnPlayer) throw new Error("The test game needs a player.");
    played.phase = "action";
    played.actionUsed = false;
    played.actionsRemaining = 1;
    nextTurnPlayer.hand.push({ instanceId: "cost-card", cardId: "object-mouse" });
    const nextTurn = applyGameCommand(played, player.id, {
      type: "activate-preaction",
      ability: "scratcher",
      cards: ["cost-card"],
    });
    expect(nextTurn.players[0]?.scratcherArmed).toBe(true);
  });
});
