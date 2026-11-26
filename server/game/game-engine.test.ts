import { describe, expect, it } from "vitest";
import { applyGameCommand, createGame, expireCombatDefense } from "./game-engine.js";
import { projectPrivateState, projectPublicState } from "./projections.js";

describe("game state projections", () => {
  it("keeps every player's hand private while showing its size to the table", () => {
    const state = createGame("test-room", [
      { id: "player-1", name: "gato1" },
      { id: "player-2", name: "gato2" },
    ]);
    const publicState = projectPublicState(state);
    const serializedPublicState = JSON.stringify(publicState);

    for (const player of state.players) {
      const publicPlayer = publicState.players.find((candidate) => candidate.id === player.id);
      expect(publicPlayer?.handCount).toBe(player.hand.length);
      expect(publicPlayer).not.toHaveProperty("hand");
      for (const card of player.hand) {
        expect(serializedPublicState).not.toContain(card.instanceId);
      }
      expect(projectPrivateState(state, player.id).hand).toEqual(player.hand);
    }
  });

  it("reports active synergies from public sofa cats and suspends them during Siesta", () => {
    const state = createTestGame("test-room", [
      { id: "player-1", name: "gato1" },
      { id: "player-2", name: "gato2" },
    ]);
    const player = state.players[0];
    if (!player) throw new Error("The test game needs a player.");
    player.sofa = [
      { instanceId: "mama", cardId: "cat-mama", ownerId: player.id, zone: "sofa" },
      { instanceId: "baby", cardId: "cat-baby", ownerId: player.id, zone: "sofa" },
    ];

    expect(projectPublicState(state).players[0]?.activeSynergies).toContain("favorite-child");
    state.activeEffects = [{ kind: "nap", expiresForPlayerId: state.players[1]!.id }];
    expect(projectPublicState(state).players[0]?.activeSynergies).not.toContain("favorite-child");
  });

  it("rejects games outside the supported player range", () => {
    expect(() => createGame("test-room", [{ id: "player-1", name: "gato1" }])).toThrow(
      "La partida admite entre 2 y 5 jugadores.",
    );
  });

  it("keeps initial cats private and waits for every player to choose their zones", () => {
    const state = createGame("test-room", [
      { id: "player-1", name: "gato1" },
      { id: "player-2", name: "gato2" },
    ]);
    const [first, second] = state.players;
    if (!first || !second) throw new Error("The test game needs two players.");
    const firstCat = { instanceId: "initial-cat-1", cardId: "cat-underfed" };
    const secondCat = { instanceId: "initial-cat-2", cardId: "cat-loner" };
    state.phase = "initial_placement";
    state.pendingDrawNotices = {};
    state.initialCatChoices = {
      [first.id]: [firstCat],
      [second.id]: [secondCat],
    };

    const publicState = projectPublicState(state);
    const serializedPublicState = JSON.stringify(publicState);
    expect(publicState.currentPlayerId).toBeNull();
    expect(publicState.players.every((player) => !player.isCurrentPlayer)).toBe(true);
    expect(serializedPublicState).not.toContain(firstCat.instanceId);
    expect(projectPrivateState(state, first.id).initialPlacementCats).toEqual([firstCat]);

    const firstChoice = applyGameCommand(state, first.id, {
      type: "choose-initial-cats",
      placements: [{ catInstanceId: firstCat.instanceId, to: "sofa" }],
    });
    expect(firstChoice.phase).toBe("initial_placement");
    expect(firstChoice.players[0]?.sofa).toContainEqual(expect.objectContaining({ instanceId: firstCat.instanceId }));

    const completed = applyGameCommand(firstChoice, second.id, {
      type: "choose-initial-cats",
      placements: [{ catInstanceId: secondCat.instanceId, to: "salon" }],
    });
    expect(completed.phase).toBe("action");
    expect(completed.players[1]?.salon).toContainEqual(expect.objectContaining({ instanceId: secondCat.instanceId }));
    expect(state.players[0]?.sofa).not.toContainEqual(expect.objectContaining({ instanceId: firstCat.instanceId }));
  });

  it("rejects incomplete or invalid initial cat placement without changing the state", () => {
    const state = createGame("test-room", [
      { id: "player-1", name: "gato1" },
      { id: "player-2", name: "gato2" },
    ]);
    const [player] = state.players;
    if (!player) throw new Error("The test game needs a player.");
    const cat = { instanceId: "initial-cat", cardId: "cat-underfed" };
    state.phase = "initial_placement";
    state.pendingDrawNotices = {};
    state.initialCatChoices = { [player.id]: [cat] };

    expect(() => applyGameCommand(state, player.id, {
      type: "choose-initial-cats",
      placements: [],
    })).toThrow("Elige un destino para cada gato inicial.");
    expect(() => applyGameCommand(state, player.id, {
      type: "choose-initial-cats",
      placements: [{ catInstanceId: "another-player-cat", to: "sofa" }],
    })).toThrow("La elección de destino para los gatos iniciales no es válida.");
    expect(state.initialCatChoices[player.id]).toEqual([cat]);
    expect(player.sofa).not.toContainEqual(expect.objectContaining({ instanceId: cat.instanceId }));
  });

  it("only offers attack redirection to the target holding Ratón con Hierba Gatuna", () => {
    const state = createCombatFixture();
    const defender = state.players[1];
    const other = state.players[2];
    if (!defender || !other) throw new Error("The test game needs three players.");
    defender.hand = [];

    expect(projectPrivateState(state, defender.id).redirectAvailable).toBe(false);
    expect(() => applyGameCommand(state, defender.id, {
      type: "redirect-attack",
      cardInstanceId: "missing-mouse",
      targetPlayerId: other.id,
      targetCardInstanceId: "other-cat",
    })).toThrow("Ratón con Hierba Gatuna no está en tu mano.");

    defender.hand.push({ instanceId: "mouse-card", cardId: "object-mouse" });
    expect(projectPrivateState(state, defender.id).redirectAvailable).toBe(true);
    other.sofa = [];
    expect(projectPrivateState(state, defender.id).redirectAvailable).toBe(false);
  });

  it("allows Espía de Ventana to reveal the attack before the defender chooses", () => {
    const state = createCombatFixture();
    const attacker = state.players[0];
    const defender = state.players[1];
    const other = state.players[2];
    if (!attacker || !defender || !other) throw new Error("The test game needs three players.");
    defender.hand = [{ instanceId: "spy-card", cardId: "action-spy" }];
    expect(projectPrivateState(state, attacker.id).privateCombatCards).toEqual([
      { instanceId: "attack-card", cardId: "attack-hiss" },
    ]);
    expect(projectPrivateState(state, defender.id).privateCombatCards).toEqual([]);
    expect(projectPublicState(state).combat?.attackCardIds).toEqual([]);
    expect(projectPublicState(state).combat?.attackDamage).toBeNull();

    const revealedWindow = applyGameCommand(state, defender.id, {
      type: "reveal-attack",
      method: "spy",
      cardInstanceId: "spy-card",
    });
    expect(revealedWindow.phase).toBe("response");
    expect(revealedWindow.combat?.revealed).toBe(false);
    expect(projectPublicState(revealedWindow).responseWindow?.pendingCardId).toBe("action-spy");

    const passedByOther = applyGameCommand(revealedWindow, other.id, { type: "pass-response" });
    const spyResolved = applyGameCommand(passedByOther, attacker.id, { type: "pass-response" });
    expect(spyResolved.phase).toBe("combat");
    expect(spyResolved.combat?.revealed).toBe(true);
    expect(projectPublicState(spyResolved).combat?.attackDamage).toBe(1);
    expect(spyResolved.lastCombatResult).toBeNull();

    const resolved = applyGameCommand(spyResolved, defender.id, {
      type: "choose-defense",
      defenseInstanceId: null,
      supportInstanceIds: [],
    });
    expect(resolved.lastCombatResult).toMatchObject({
      attackerId: attacker.id,
      defenderId: defender.id,
      attackCardId: "attack-hiss",
      attackDamage: 1,
      defenseCardId: null,
      succeeded: true,
    });
    expect(projectPublicState(resolved).lastCombatResult?.targetCardId).toBe("cat-underfed");
  });

  it("rejects redirecting to the current target but allows redirecting to another own cat", () => {
    const state = createCombatFixture();
    const defender = state.players[1];
    if (!defender) throw new Error("The test game needs a defender.");
    defender.hand = [{ instanceId: "mouse-card", cardId: "object-mouse" }];
    defender.salon = [{ instanceId: "own-cat", cardId: "cat-loner", ownerId: defender.id, zone: "salon" }];

    expect(() => applyGameCommand(state, defender.id, {
      type: "redirect-attack",
      cardInstanceId: "mouse-card",
      targetPlayerId: defender.id,
      targetCardInstanceId: "target-cat",
    })).toThrow("Elige otro objetivo distinto del que ya estaba siendo atacado.");

    const redirected = applyGameCommand(state, defender.id, {
      type: "redirect-attack",
      cardInstanceId: "mouse-card",
      targetPlayerId: defender.id,
      targetCardInstanceId: "own-cat",
    });
    expect(redirected.responseWindow?.pending.card.cardId).toBe("object-mouse");
  });

  it("waits for the defender to accept an undefended attack and hides the redirect pass publicly", () => {
    const state = createCombatFixture();
    const attacker = state.players[0];
    const defender = state.players[1];
    if (!attacker || !defender) throw new Error("The test game needs two players.");
    defender.hand = [{ instanceId: "mouse-card", cardId: "object-mouse" }];

    const passed = applyGameCommand(state, defender.id, { type: "pass-redirect" });
    expect(passed.combat?.redirectedPlayers).toContain(defender.id);
    expect(passed.combat).not.toBeNull();
    expect(passed.players[1]?.sofa).toContainEqual(expect.objectContaining({ instanceId: "target-cat" }));
    expect(projectPrivateState(passed, defender.id).redirectAvailable).toBe(false);
    expect(projectPublicState(passed).combat?.redirectPlayerId).toBe(defender.id);
    expect(projectPublicState(passed).combat).not.toHaveProperty("redirectedPlayers");

    const accepted = applyGameCommand(passed, defender.id, {
      type: "choose-defense",
      defenseInstanceId: null,
      supportInstanceIds: [],
    });
    expect(accepted.combat).not.toBeNull();
    expect(accepted.pendingCatPlacements[attacker.id]).toContainEqual(expect.objectContaining({ instanceId: "target-cat" }));

    const captured = applyGameCommand(accepted, attacker.id, {
      type: "choose-drawn-cats",
      placements: [{ catInstanceId: "target-cat", to: "sofa" }],
    });
    expect(captured.combat).toBeNull();
    expect(captured.players[0]?.sofa).toContainEqual(expect.objectContaining({ instanceId: "target-cat" }));
  });

  it("lets the player choose a zone for a cat stolen with Robo Felino", () => {
    const state = createGame("test-room", [
      { id: "player-1", name: "gato1" },
      { id: "player-2", name: "gato2" },
    ]);
    const [actor, target] = state.players;
    if (!actor || !target) throw new Error("The test game needs two players.");
    actor.hand = [{ instanceId: "burglar-card", cardId: "action-cat-burglar" }];
    target.salon = [{ instanceId: "stolen-cat", cardId: "cat-loner", ownerId: target.id, zone: "salon" }];
    state.pendingDrawNotices = {};
    state.pendingCatPlacements = {};
    state.pendingPrivateNotices = {};
    state.initialCatChoices = {};
    state.initialDrawChoicePlayerId = null;
    state.pendingChoices = {};
    state.phase = "action";
    state.currentPlayerIndex = 0;
    state.actionsRemaining = 1;

    const started = applyGameCommand(state, actor.id, {
      type: "play-card",
      cardInstanceId: "burglar-card",
      choices: { targetPlayerId: target.id, targetCatInstanceId: "stolen-cat" },
    });
    const stolen = applyGameCommand(started, target.id, { type: "pass-response" });
    expect(stolen.pendingCatPlacements[actor.id]).toContainEqual(expect.objectContaining({ instanceId: "stolen-cat" }));

    const placed = applyGameCommand(stolen, actor.id, {
      type: "choose-drawn-cats",
      placements: [{ catInstanceId: "stolen-cat", to: "salon" }],
    });
    expect(placed.players[0]?.salon).toContainEqual(expect.objectContaining({ instanceId: "stolen-cat" }));
    expect(placed.players[1]?.salon).toHaveLength(0);
  });

  it("shows drawn cards privately and waits for confirmation before ending the action", () => {
    const state = createGame("test-room", [
      { id: "player-1", name: "gato1" },
      { id: "player-2", name: "gato2" },
    ]);
    const [actor] = state.players;
    if (!actor) throw new Error("The test game needs a player.");
    actor.hand = [{ instanceId: "tuna-card", cardId: "consumable-tuna" }];
    state.pendingDrawNotices = {};
    state.deck = [
      { instanceId: "draw-one", cardId: "action-skip" },
      { instanceId: "draw-two", cardId: "consumable-churu" },
    ];
    state.pendingCatPlacements = {};
    state.phase = "action";
    state.currentPlayerIndex = 0;
    state.actionsRemaining = 1;
    state.actionUsed = false;

    const drawn = applyGameCommand(state, actor.id, {
      type: "play-card",
      cardInstanceId: "tuna-card",
    });

    expect(drawn.phase).toBe("action");
    expect(drawn.actionsRemaining).toBe(0);
    expect(projectPrivateState(drawn, actor.id).pendingDrawNotice).toEqual({
      card: { instanceId: "draw-two", cardId: "consumable-churu" },
      reason: "Lata de Atún: robo de 2 cartas",
    });
    expect(projectPrivateState(drawn, state.players[1]!.id).pendingDrawNotice).toBeNull();
    expect(projectPublicState(drawn).pendingDrawNoticePlayerIds).toEqual([actor.id]);
    expect(JSON.stringify(projectPublicState(drawn))).not.toContain("draw-one");
    expect(JSON.stringify(projectPublicState(drawn))).not.toContain("draw-two");

    const acknowledged = applyGameCommand(drawn, actor.id, { type: "acknowledge-draw" });
    expect(projectPrivateState(acknowledged, actor.id).pendingDrawNotice).toEqual({
      card: { instanceId: "draw-one", cardId: "action-skip" },
      reason: "Lata de Atún: robo de 2 cartas",
    });
    expect(acknowledged.phase).toBe("action");
    const allAcknowledged = applyGameCommand(acknowledged, actor.id, { type: "acknowledge-draw" });
    expect(allAcknowledged.phase).toBe("movement");
    expect(allAcknowledged.pendingDrawNotices[actor.id]).toBeUndefined();
  });

  it("combines a drawn-cat notice with its placement confirmation", () => {
    const state = createGame("test-room", [
      { id: "player-1", name: "gato1" },
      { id: "player-2", name: "gato2" },
    ]);
    const [actor] = state.players;
    if (!actor) throw new Error("The test game needs a player.");
    actor.hand = [{ instanceId: "tuna-card", cardId: "consumable-tuna" }];
    state.pendingDrawNotices = {};
    state.deck = [
      { instanceId: "draw-action", cardId: "action-skip" },
      { instanceId: "draw-cat", cardId: "cat-underfed" },
    ];
    state.pendingCatPlacements = {};
    state.phase = "action";
    state.currentPlayerIndex = 0;
    state.actionsRemaining = 1;
    state.actionUsed = false;

    const drawn = applyGameCommand(state, actor.id, {
      type: "play-card",
      cardInstanceId: "tuna-card",
    });
    expect(projectPrivateState(drawn, actor.id).pendingDrawNotice).toEqual({
      card: { instanceId: "draw-cat", cardId: "cat-underfed" },
      reason: "Lata de Atún: robo de 2 cartas",
    });
    expect(projectPrivateState(drawn, actor.id).pendingCatPlacements).toEqual([
      { instanceId: "draw-cat", cardId: "cat-underfed" },
    ]);

    const placed = applyGameCommand(drawn, actor.id, {
      type: "choose-drawn-cats",
      placements: [{ catInstanceId: "draw-cat", to: "salon" }],
    });
    expect(placed.players[0]?.salon).toContainEqual(expect.objectContaining({ instanceId: "draw-cat" }));
    expect(projectPrivateState(placed, actor.id).pendingDrawNotice).toEqual({
      card: { instanceId: "draw-action", cardId: "action-skip" },
      reason: "Lata de Atún: robo de 2 cartas",
    });
    expect(placed.phase).toBe("action");
    const acknowledged = applyGameCommand(placed, actor.id, { type: "acknowledge-draw" });
    expect(acknowledged.pendingDrawNotices[actor.id]).toBeUndefined();
    expect(acknowledged.phase).toBe("movement");
  });

  it("only lets an attack winner choose the Sofa when it has capacity", () => {
    const state = createCombatFixture();
    const attacker = state.players[0];
    const defender = state.players[1];
    if (!attacker || !defender) throw new Error("The test game needs two players.");
    attacker.sofa = ["occupied-1", "occupied-2", "occupied-3"].map((instanceId) => ({
      instanceId,
      cardId: "cat-loner",
      ownerId: attacker.id,
      zone: "sofa" as const,
    }));

    const captured = applyGameCommand(state, defender.id, {
      type: "choose-defense",
      defenseInstanceId: null,
      supportInstanceIds: [],
    });
    expect(() => applyGameCommand(captured, attacker.id, {
      type: "choose-drawn-cats",
      placements: [{ catInstanceId: "target-cat", to: "sofa" }],
    })).toThrow("No hay espacio suficiente en el Sofá.");

    const placed = applyGameCommand(captured, attacker.id, {
      type: "choose-drawn-cats",
      placements: [{ catInstanceId: "target-cat", to: "salon" }],
    });
    expect(placed.players[0]?.salon).toContainEqual(expect.objectContaining({ instanceId: "target-cat" }));
  });

  it("passes an expired Flús-Flús response without consuming the card", () => {
    const state = createCombatFixture();
    const [receiver, nextResponder] = state.players;
    if (!receiver || !nextResponder) throw new Error("The test game needs two players.");
    receiver.hand = [{ instanceId: "flush-card", cardId: "response-flush-1" }];
    state.responseWindow = {
      pending: {
        id: "pending-laser",
        actorId: nextResponder.id,
        card: { instanceId: "pending-laser-card", cardId: "action-laser" },
        choices: {},
      },
      stack: [],
      order: [receiver.id, nextResponder.id],
      cursor: 0,
      expiresAt: Date.now() - 1,
    };
    state.phase = "response";

    const passed = applyGameCommand(state, receiver.id, {
      type: "respond-flush",
      cardInstanceId: "flush-card",
    });

    expect(passed.players[0]?.hand).toContainEqual({ instanceId: "flush-card", cardId: "response-flush-1" });
    expect(passed.responseWindow?.cursor).toBe(1);
    expect(passed.responseWindow?.expiresAt).toBeGreaterThan(Date.now());
  });

  it("shows the latest Flús-Flús in the public response window", () => {
    const state = createCombatFixture();
    const [actor, responder, nextResponder] = state.players;
    if (!actor || !responder || !nextResponder) throw new Error("The test game needs three players.");
    state.responseWindow = {
      pending: {
        id: "pending-laser",
        actorId: actor.id,
        card: { instanceId: "pending-laser-card", cardId: "action-laser" },
        choices: {},
      },
      stack: [{
        playerId: responder.id,
        card: { instanceId: "flush-card", cardId: "response-flush-2" },
      }],
      order: [nextResponder.id, actor.id],
      cursor: 0,
      expiresAt: Date.now() + 15_000,
    };

    expect(projectPublicState(state).responseWindow).toMatchObject({
      actorId: responder.id,
      cardId: "response-flush-2",
    });
  });

  it("logs both the player who played a card and the player who cancelled it", () => {
    const state = createCombatFixture();
    const [actor, canceler] = state.players;
    if (!actor || !canceler) throw new Error("The test game needs two players.");
    state.responseWindow = {
      pending: {
        id: "pending-catnip",
        actorId: actor.id,
        card: { instanceId: "catnip-card", cardId: "action-catnip" },
        choices: {},
      },
      stack: [{
        playerId: canceler.id,
        card: { instanceId: "flush-card", cardId: "response-flush-1" },
      }],
      order: [actor.id],
      cursor: 0,
      expiresAt: Date.now() + 15_000,
    };
    state.phase = "response";

    const resolved = applyGameCommand(state, actor.id, { type: "pass-response" });
    expect(resolved.log.at(-1)?.text).toBe(
      `${actor.name} juega Sobredosis de Catnip, pero ${canceler.name} la cancela con Flús-Flús de Agua.`,
    );
  });

  it("makes a Flús-Flús player choose the Victimista penalty discard", () => {
    const state = createCombatFixture();
    const [actor, canceler] = state.players;
    if (!actor || !canceler) throw new Error("The test game needs two players.");
    actor.sofa.push({ instanceId: "victim-cat", cardId: "cat-victim", ownerId: actor.id, zone: "sofa" });
    canceler.hand = [{ instanceId: "extra-card", cardId: "object-mouse" }];
    state.responseWindow = {
      pending: {
        id: "pending-catnip",
        actorId: actor.id,
        card: { instanceId: "catnip-card", cardId: "action-catnip" },
        choices: {},
      },
      stack: [{
        playerId: canceler.id,
        card: { instanceId: "flush-card", cardId: "response-flush-1" },
      }],
      order: [actor.id],
      cursor: 0,
      expiresAt: Date.now() + 15_000,
    };
    state.phase = "response";

    const cancelled = applyGameCommand(state, actor.id, { type: "pass-response" });
    expect(cancelled.phase).toBe("discard");
    expect(cancelled.pendingDiscard).toMatchObject({
      playerIds: [canceler.id],
      countByPlayer: { [canceler.id]: 1 },
      reason: `Victimista de ${actor.name}`,
    });
    expect(cancelled.players[1]?.hand).toEqual([{ instanceId: "extra-card", cardId: "object-mouse" }]);

    const discarded = applyGameCommand(cancelled, canceler.id, {
      type: "discard-cards",
      cardInstanceIds: ["extra-card"],
    });
    expect(discarded.players[1]?.hand).toHaveLength(0);
    expect(discarded.phase).toBe("combat");
  });

  it("automatically accepts a defense that expires after 30 seconds", () => {
    const state = createCombatFixture();
    const attacker = state.players[0];
    const defender = state.players[1];
    if (!attacker || !defender || !state.combat) throw new Error("The test game needs an active combat.");
    const expiresAt = Date.now() - 1;
    state.combat.defenseExpiresAt = expiresAt;

    const resolved = expireCombatDefense(state, defender.id, expiresAt);
    expect(resolved?.combat).not.toBeNull();
    expect(resolved?.pendingCatPlacements[attacker.id]).toContainEqual(
      expect.objectContaining({ instanceId: "target-cat" }),
    );
    expect(resolved?.log.at(-1)?.text).toContain("no respondió en 30 segundos");
  });

  it("rejects invalid Laser moves before spending the card", () => {
    const state = createGame("test-room", [
      { id: "player-1", name: "gato1" },
      { id: "player-2", name: "gato2" },
    ]);
    const [actor, emptyHouse] = state.players;
    if (!actor || !emptyHouse) throw new Error("The test game needs two players.");
    actor.hand = [{ instanceId: "laser-card", cardId: "action-laser" }];
    actor.sofa = [{ instanceId: "laser-cat", cardId: "cat-underfed", ownerId: actor.id, zone: "sofa" }];
    state.phase = "action";
    state.currentPlayerIndex = 0;
    state.pendingDrawNotices = {};
    state.actionsRemaining = 1;
    const actionsRemaining = state.actionsRemaining;

    expect(() => applyGameCommand(state, actor.id, {
      type: "play-card",
      cardInstanceId: "laser-card",
      choices: { ownerId: emptyHouse.id, catInstanceId: "laser-cat", to: "salon" },
    })).toThrow("El Láser Infrarrojo solo puede afectar a una casa que tenga gatos.");
    expect(actor.hand).toContainEqual({ instanceId: "laser-card", cardId: "action-laser" });
    expect(state.actionsRemaining).toBe(actionsRemaining);

    state.activeEffects = [{ kind: "strike", expiresForPlayerId: emptyHouse.id }];
    expect(() => applyGameCommand(state, actor.id, {
      type: "play-card",
      cardInstanceId: "laser-card",
      choices: { ownerId: actor.id, catInstanceId: "laser-cat", to: "salon" },
    })).toThrow("Un efecto activo impide mover ese gato entre zonas.");
    expect(actor.hand).toContainEqual({ instanceId: "laser-card", cardId: "action-laser" });
  });

  it("publishes which cat the Bed protects and blocks every movement route", () => {
    const { state, owner } = createBedFixture();
    expect(projectPublicState(state).players[0]?.structureProtectedCatId).toBe("protected-cat");

    expect(() => applyGameCommand(state, owner.id, {
      type: "move",
      movement: { playerId: owner.id, catInstanceId: "protected-cat", to: "salon" },
    })).toThrow("Un efecto activo impide mover ese gato entre zonas.");

    state.phase = "action";
    expect(() => applyGameCommand(state, owner.id, {
      type: "activate-preaction",
      ability: "hyperactive",
      movement: { playerId: owner.id, catInstanceId: "protected-cat", to: "salon" },
    })).toThrow("Un efecto activo impide mover ese gato entre zonas.");

    owner.hand = [{ instanceId: "laser-card", cardId: "action-laser" }];
    expect(() => applyGameCommand(state, owner.id, {
      type: "play-card",
      cardInstanceId: "laser-card",
      choices: { ownerId: owner.id, catInstanceId: "protected-cat", to: "salon" },
    })).toThrow("Un efecto activo impide mover ese gato entre zonas.");

    state.phase = "choice";
    state.pendingGlobalChoice = {
      kind: "neighbor-dog",
      actorId: owner.id,
      card: { instanceId: "dog-card", cardId: "event-dog" },
      playerIds: [owner.id],
      cursor: 0,
      choices: {},
    };
    expect(() => applyGameCommand(state, owner.id, {
      type: "resolve-choice",
      choice: "protected-cat",
    })).toThrow("No puedes mover ese gato ahora.");
  });

  it("rejects Puerta Gatera and Robo Felino when either would remove a protected cat", () => {
    const { state, owner, opponent } = createBedFixture();
    const otherCat = {
      instanceId: "other-cat",
      cardId: "cat-underfed",
      ownerId: opponent.id,
      zone: "sofa" as const,
    };
    opponent.sofa = [otherCat];
    owner.hand = [{ instanceId: "door-card", cardId: "action-cat-door" }];
    state.phase = "action";
    state.actionsRemaining = 1;

    expect(() => passResponseWindow(applyGameCommand(state, owner.id, {
      type: "play-card",
      cardInstanceId: "door-card",
      choices: {
        targetPlayerId: opponent.id,
        ownCatInstanceId: "protected-cat",
        targetCatInstanceId: "other-cat",
      },
    }))).toThrow("La Cama de Peluche impide intercambiar al gato protegido.");

    owner.structure = null;
    owner.structureProtectedCatId = null;
    opponent.structure = { instanceId: "opponent-bed", cardId: "structure-bed" };
    opponent.structureProtectedCatId = "other-cat";
    owner.sofa = [{
      instanceId: "owner-cat",
      cardId: "cat-underfed",
      ownerId: owner.id,
      zone: "sofa",
    }];
    opponent.sofa = [otherCat];
    expect(() => passResponseWindow(applyGameCommand(state, owner.id, {
      type: "play-card",
      cardInstanceId: "door-card",
      choices: {
        targetPlayerId: opponent.id,
        ownCatInstanceId: "owner-cat",
        targetCatInstanceId: "other-cat",
      },
    }))).toThrow("La Cama de Peluche impide intercambiar al gato protegido.");

    opponent.structureProtectedCatId = "opponent-cat";
    opponent.salon = [{
      instanceId: "opponent-cat",
      cardId: "cat-loner",
      ownerId: opponent.id,
      zone: "salon",
    }];
    owner.hand = [{ instanceId: "burglar-card", cardId: "action-cat-burglar" }];
    state.currentPlayerIndex = 0;
    state.phase = "action";
    state.actionsRemaining = 1;

    expect(() => passResponseWindow(applyGameCommand(state, owner.id, {
      type: "play-card",
      cardInstanceId: "burglar-card",
      choices: { targetPlayerId: opponent.id, targetCatInstanceId: "opponent-cat" },
    }))).toThrow("La Cama de Peluche protege a ese gato y evita que se retire.");
  });

  it("does not allow attacks against a protected cat or the Bed itself", () => {
    const { state, owner, opponent } = createBedFixture();
    opponent.hand = [{ instanceId: "attack-card", cardId: "attack-hiss" }];
    state.currentPlayerIndex = 1;
    state.phase = "action";
    state.actionsRemaining = 1;

    expect(() => applyGameCommand(state, opponent.id, {
      type: "declare-attack",
      targetPlayerId: owner.id,
      targetCardInstanceId: "protected-cat",
      attackInstanceId: "attack-card",
      supportInstanceIds: [],
    })).toThrow("La Cama de Peluche protege a ese gato.");

    expect(() => applyGameCommand(state, opponent.id, {
      type: "declare-attack",
      targetPlayerId: owner.id,
      targetCardInstanceId: "bed-card",
      attackInstanceId: "attack-card",
      supportInstanceIds: [],
    })).toThrow("La Cama no puede ser objetivo de un ataque.");
  });
});

function createBedFixture() {
  const state = createGame("test-room", [
    { id: "player-1", name: "gato1" },
    { id: "player-2", name: "gato2" },
  ]);
  const owner = state.players[0];
  const opponent = state.players[1];
  if (!owner || !opponent) throw new Error("The test game needs two players.");
  owner.structure = { instanceId: "bed-card", cardId: "structure-bed" };
  owner.structureProtectedCatId = "protected-cat";
  owner.sofa = [{
    instanceId: "protected-cat",
    cardId: "cat-hyperactive",
    ownerId: owner.id,
    zone: "sofa",
  }];
  state.pendingDrawNotices = {};
  state.pendingCatPlacements = {};
  state.currentPlayerIndex = 0;
  state.phase = "movement";
  state.actionsRemaining = 1;
  return { state, owner, opponent };
}

function passResponseWindow(state: ReturnType<typeof createGame>): ReturnType<typeof createGame> {
  let next = state;
  while (next.responseWindow) {
    const responderId = next.responseWindow.order[next.responseWindow.cursor];
    if (!responderId) throw new Error("The response window has no current responder.");
    next = applyGameCommand(next, responderId, { type: "pass-response" });
  }
  return next;
}

function createCombatFixture() {
  const state = createGame("test-room", [
    { id: "player-1", name: "gato1" },
    { id: "player-2", name: "gato2" },
    { id: "player-3", name: "gato3" },
  ]);
  const attacker = state.players[0];
  const defender = state.players[1];
  const other = state.players[2];
  if (!attacker || !defender || !other) throw new Error("The test game needs three players.");
  state.pendingDrawNotices = {};
  state.pendingCatPlacements = {};
  defender.sofa = [{ instanceId: "target-cat", cardId: "cat-underfed", ownerId: defender.id, zone: "sofa" }];
  other.sofa = [{ instanceId: "other-cat", cardId: "cat-loner", ownerId: other.id, zone: "sofa" }];
  state.phase = "combat";
  state.combat = {
    attackerId: attacker.id,
    initialTargetId: defender.id,
    targetPlayerId: defender.id,
    targetCardInstanceId: "target-cat",
    redirectPlayerId: defender.id,
    attack: { instanceId: "attack-card", cardId: "attack-hiss" },
    attackSupports: [],
    defense: null,
    defenseSupports: [],
    attackDamage: null,
    defenseDamage: null,
    defenseExpiresAt: Date.now() + 30_000,
    revealed: false,
    redirectedPlayers: [],
    spentResponseCards: [],
  };
  return state;
}

function createTestGame(
  roomId: string,
  seats: Array<{ id: string; name: string }>,
) {
  const state = createGame(roomId, seats);
  state.pendingCatPlacements = {};
  state.pendingDrawNotices = {};
  return state;
}
