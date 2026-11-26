import { Client, type Room } from "colyseus.js";
import { CARD_BY_ID } from "../shared/card-catalog.js";
import { SYNERGIES } from "../shared/synergies.js";
import type {
  GameCommand,
  PrivateGameState,
  PublicGameState,
  PublicPlayerState,
} from "../shared/game-types.js";
import "./style.css";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Missing #app root element.");
const cardPreview = (() => {
  const dialog = document.querySelector<HTMLDialogElement>("#card-preview");
  const image = document.querySelector<HTMLImageElement>("#card-preview-image");
  const title = document.querySelector<HTMLHeadingElement>("#card-preview-title");
  const description = document.querySelector<HTMLParagraphElement>("#card-preview-description");
  if (!dialog || !image || !title || !description) throw new Error("Missing card preview dialog.");
  return { dialog, image, title, description };
})();
const discardUi = (() => {
  const dialog = document.querySelector<HTMLDialogElement>("#discard-dialog");
  const list = document.querySelector<HTMLDivElement>("#discard-list");
  if (!dialog || !list) throw new Error("Missing discard pile dialog.");
  return { dialog, list };
})();
const synergyUi = (() => {
  const dialog = document.querySelector<HTMLDialogElement>("#synergy-dialog");
  const title = document.querySelector<HTMLHeadingElement>("#synergy-title");
  const list = document.querySelector<HTMLDivElement>("#synergy-list");
  if (!dialog || !title || !list) throw new Error("Missing synergy dialog.");
  return { dialog, title, list };
})();

const apiUrl = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:2568";
const socketUrl = import.meta.env.VITE_GAME_URL ?? "ws://127.0.0.1:2567";
let account: { id: string; username: string; elo: number; gamesPlayed: number; theme: "light" | "dark" } | null = null;
let token: string | null = null;
let room: Room | null = null;
let lobby: { players: Array<{ id: string; name: string }>; hostId: string | null } | null = null;
let publicState: PublicGameState | null = null;
let privateState: PrivateGameState | null = null;
let selectedCardId = "";
let selectedSupportIds = new Set<string>();
let placementChoices = new Map<string, "sofa" | "salon">();
let errorMessage = "";
let noticeMessage = "";
let responseCountdownInterval: number | null = null;
let presenceInterval: number | null = null;
let idleSinceByPlayer: Record<string, number> = {};
let matchHistory: Array<{ id: string; playedAt: string; winnerName: string; playerNames: string[] }> = [];

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);

function cardName(cardId: string): string {
  return CARD_BY_ID.get(cardId)?.name ?? cardId;
}

function cardImage(cardId: string): string {
  return CARD_BY_ID.get(cardId)?.image ?? "";
}

function cardPreviewTrigger(cardId: string, name: string, className = ""): string {
  return `<img class="card-preview-trigger ${className}" data-card-preview="${escapeHtml(cardId)}"
    src="${escapeHtml(cardImage(cardId))}" alt="" role="button" tabindex="0"
    aria-label="Ampliar carta: ${escapeHtml(name)}" aria-haspopup="dialog" loading="lazy" />`;
}

function showCardPreview(cardId: string): void {
  const definition = CARD_BY_ID.get(cardId);
  if (!definition) {
    setError(new Error("No se encontró la definición de esta carta."));
    return;
  }
  cardPreview.image.src = cardImage(cardId);
  cardPreview.image.alt = definition.name;
  cardPreview.title.textContent = definition.name;
  cardPreview.description.textContent = definition.description;
  if (!cardPreview.dialog.open) cardPreview.dialog.showModal();
}

function showDiscardPile(): void {
  if (!publicState) return;
  const cards = [...publicState.discard].reverse();
  discardUi.list.innerHTML = cards.length
    ? cards.map((card) => cardTile(card.cardId, cardName(card.cardId))).join("")
    : `<p class="empty">La pila de descartes está vacía.</p>`;
  if (!discardUi.dialog.open) discardUi.dialog.showModal();
}

function showSynergies(playerId: string): void {
  const player = publicState?.players.find((candidate) => candidate.id === playerId);
  if (!player) return;
  const active = SYNERGIES.filter((synergy) => player.activeSynergies.includes(synergy.id));
  synergyUi.title.textContent = `Sinergias activas de ${playerId === account?.id ? "tu casa" : player.name}`;
  synergyUi.list.innerHTML = active.length
    ? active.map((synergy) => {
      const cats = player.sofa.filter((cat) => synergy.cats.includes(cat.cardId));
      return `<article class="synergy-card">
        <h3>${escapeHtml(synergy.name)}</h3>
        <p>${escapeHtml(synergy.description)}</p>
        <div class="synergy-cats">${cats.map((cat) => cardTile(cat.cardId, cardName(cat.cardId))).join("")}</div>
      </article>`;
    }).join("")
    : `<p class="empty">No tiene sinergias activas en este momento.</p>`;
  if (!synergyUi.dialog.open) synergyUi.dialog.showModal();
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function updatePresenceBadges(): void {
  for (const badge of root!.querySelectorAll<HTMLElement>("[data-presence-player]")) {
    const playerId = badge.dataset.presencePlayer ?? "";
    const idleSince = idleSinceByPlayer[playerId];
    if (idleSince === undefined || Date.now() - idleSince < 60_000) {
      badge.hidden = true;
      badge.textContent = "";
      continue;
    }
    badge.hidden = false;
    badge.textContent = `AFK · ${formatElapsed(Date.now() - idleSince)}`;
  }
}

function playerName(playerId: string): string {
  return publicState?.players.find((player) => player.id === playerId)?.name ?? playerId;
}

function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
}

async function toggleTheme(): Promise<void> {
  if (!account || !token) {
    setError(new Error("Inicia sesión para cambiar tu tema."));
    return;
  }
  const previousTheme = account.theme;
  const nextTheme = previousTheme === "dark" ? "light" : "dark";
  account.theme = nextTheme;
  applyTheme(nextTheme);
  render();
  try {
    const response = await fetch(`${apiUrl}/api/preferences/theme`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, theme: nextTheme }),
    });
    const result = await response.json() as { error?: string; theme?: string };
    if (!response.ok || result.theme !== nextTheme) {
      throw new Error(result.error ?? "No se pudo guardar el tema.");
    }
  } catch (error) {
    if (account) account.theme = previousTheme;
    applyTheme(previousTheme);
    setError(error);
  }
}

function selectedDefinitionFor(instanceId: string) {
  const card = privateState?.hand.find((candidate) => candidate.instanceId === instanceId);
  return card ? CARD_BY_ID.get(card.cardId) : undefined;
}

function renderLogin(): void {
  root!.innerHTML = `
    <main class="login-shell">
      <section class="login-card">
        <p class="eyebrow">Partidas locales · 2–5 jugadores</p>
        <h1>¡Ese gato es mío!</h1>
        <p>Entra con uno de los perfiles de prueba para crear o unirte a la sala.</p>
        <form id="login-form">
          <label>Perfil
            <select name="username">
              <option value="gato1">Cargando perfiles…</option>
            </select>
          </label>
          <label>Contraseña
            <input name="password" type="password" value="gato123" required autocomplete="current-password" />
          </label>
          <button class="primary" type="submit">Entrar en la sala</button>
        </form>
        <p class="hint">Perfiles de prueba: gato1–gato5 · contraseña: gato123</p>
        ${renderMessages()}
      </section>
    </main>`;

  void fetch(`${apiUrl}/api/accounts`)
    .then(async (response) => {
      if (!response.ok) throw new Error("No se pudieron cargar los perfiles de prueba.");
      return response.json() as Promise<{ accounts: Array<{ username: string; elo: number }> }>;
    })
    .then(({ accounts }) => {
      const select = root!.querySelector<HTMLSelectElement>('select[name="username"]');
      if (!select) return;
      select.innerHTML = accounts
        .map((item) => `<option value="${escapeHtml(item.username)}">${escapeHtml(item.username)} · ELO ${item.elo}</option>`)
        .join("");
    })
    .catch((error: unknown) => setError(error));
}

function renderMessages(): string {
  return `${errorMessage ? `<p class="message error">${escapeHtml(errorMessage)}</p>` : ""}
    ${noticeMessage ? `<p class="message">${escapeHtml(noticeMessage)}</p>` : ""}`;
}

function renderLobby(): void {
  if (!lobby || !account) return;
  root!.innerHTML = `
    <main class="lobby-shell">
      <header class="topbar"><h1>¡Ese gato es mío!</h1>
        <div class="profile"><button data-action="toggle-theme" class="quiet">Tema ${account.theme === "dark" ? "oscuro" : "claro"} · cambiar</button>
          <button data-action="logout" class="quiet">Salir</button></div></header>
      <section class="panel">
        <p class="eyebrow">Sala local</p>
        <h2>Jugadores (${lobby.players.length}/5)</h2>
        <ul class="player-list">${lobby.players.map((player, index) =>
          `<li><span>${escapeHtml(player.name)}${player.id === lobby!.hostId ? " · anfitrión" : ""}</span><b>${index + 1}</b></li>`,
        ).join("")}</ul>
        <p class="hint">Abre esta dirección en otros navegadores o dispositivos de la red local y entra con otro perfil.</p>
        ${lobby.hostId === account.id
          ? `<button class="primary" data-action="start" ${lobby.players.length < 2 ? "disabled" : ""}>Empezar partida</button>`
          : `<p class="hint">El anfitrión empezará cuando todos estén listos.</p>`}
        ${renderMessages()}
      </section>
    </main>`;
}

function cardTile(cardId: string, name: string): string {
  return `<div class="card-tile">
    ${cardPreviewTrigger(cardId, name)}
    <div><b>${escapeHtml(name)}</b><small>${escapeHtml(CARD_BY_ID.get(cardId)?.description ?? "")}</small></div>
  </div>`;
}

function canFitCatOnSofa(player: PublicPlayerState, cardId: string, pendingSofaCats: string[] = []): boolean {
  const catIds = [...player.sofa.map((cat) => cat.cardId), ...pendingSofaCats, cardId];
  const incoming = CARD_BY_ID.get(cardId);
  if (!incoming || incoming.kind !== "cat") return false;
  const sofaSpaces = catIds.reduce(
    (total, id) => total + (CARD_BY_ID.get(id)?.sofaSpaces ?? 1),
    0,
  );
  const hasFat = catIds.includes("cat-fat");
  const hasUnderfed = catIds.includes("cat-underfed");
  return sofaSpaces - Number(hasFat && hasUnderfed) <= 3;
}

function interactionPopup(content: string, className = ""): string {
  return `<dialog class="interaction-popup response-popup ${className}" aria-label="Decisión pendiente">
    ${content}</dialog>`;
}

function renderCatPlacementFields(
  formId: string,
  cats: PrivateGameState["pendingCatPlacements"],
  canPlaceOnSofa: (cat: PrivateGameState["pendingCatPlacements"][number]) => boolean = () => true,
  confirmLabel = "Confirmar gatos",
): string {
  const catIds = new Set(cats.map((cat) => cat.instanceId));
  for (const id of placementChoices.keys()) {
    if (!catIds.has(id)) placementChoices.delete(id);
  }
  const pendingSofaCats: string[] = [];
  const cards = cats.map((cat) => {
    const sofaAllowed = canPlaceOnSofa(cat) && canFitCatOnSofa(
      publicState!.players.find((player) => player.id === account?.id)!,
      cat.cardId,
      pendingSofaCats,
    );
    let destination = placementChoices.get(cat.instanceId);
    if (destination === "sofa" && !sofaAllowed) {
      placementChoices.delete(cat.instanceId);
      destination = undefined;
    }
    if (destination === "sofa") pendingSofaCats.push(cat.cardId);
    return `
      <div class="initial-placement-card">
        ${cardTile(cat.cardId, cardName(cat.cardId))}
        <label>Destino de ${escapeHtml(cardName(cat.cardId))}
          <select name="destination-${escapeHtml(cat.instanceId)}" required>
            <option value="" ${destination ? "" : "selected"} disabled>Elige dónde va</option>
            ${sofaAllowed ? `<option value="sofa" ${destination === "sofa" ? "selected" : ""}>Sofá</option>` : ""}
            <option value="salon" ${destination === "salon" ? "selected" : ""}>Salón</option>
          </select>
        </label>
      </div>`;
  }).join("");
  return `<form id="${formId}">
    <div class="initial-placement-list">${cards}</div>
    <button class="primary" type="submit">${confirmLabel}</button>
  </form>`;
}

function renderCatPlacementPanel(
  title: string,
  description: string,
  formId: string,
  cats: PrivateGameState["pendingCatPlacements"],
  canPlaceOnSofa: (cat: PrivateGameState["pendingCatPlacements"][number]) => boolean = () => true,
): string {
  return `<section class="panel"><h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(description)}</p>
    ${renderCatPlacementFields(formId, cats, canPlaceOnSofa)}</section>`;
}

function renderBoardPlayer(player: PublicPlayerState): string {
  const zone = (title: string, className: string, cats: PublicPlayerState["sofa"]) =>
    `<div class="zone ${className}"><h4>${title}</h4>${cats.length
      ? cats.map((cat) => cardTile(cat.cardId, cardName(cat.cardId))).join("")
      : `<p class="empty">Vacío</p>`}</div>`;
  return `<article class="board-player ${player.isCurrentPlayer ? "active" : ""}">
    <header><div><h3>${escapeHtml(player.name)}${player.isCurrentPlayer ? " · turno" : ""}</h3>
      <span>${player.prestige}/${player.targetPrestige} prestigio · ${player.handCount} cartas</span></div>
      <div class="board-player-tools">
        <span class="presence-badge" data-presence-player="${escapeHtml(player.id)}" hidden></span>
        <button class="quiet synergy-button" data-action="show-synergies" data-player-id="${escapeHtml(player.id)}"
          ${player.activeSynergies.length === 0 ? "disabled" : ""}>
          Sinergias · ${player.activeSynergies.length}</button>
      </div></header>
    <div class="board-zones">
      ${zone("Sofá", "sofa-zone", player.sofa)}
      <div class="zone structure-zone"><h4>Estructura</h4>${player.structure
        ? cardTile(player.structure.cardId, cardName(player.structure.cardId))
        : `<p class="empty">Vacía</p>`}</div>
      ${zone("Salón", "salon-zone", player.salon)}
    </div>
  </article>`;
}

function selectOptions(items: Array<{ id: string; label: string }>, emptyLabel: string): string {
  return `<option value="">${emptyLabel}</option>${items.map((item) =>
    `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`,
  ).join("")}`;
}

function renderActionPanel(): string {
  if (!publicState || !privateState || !account) return "";
  const state = publicState;
  const me = state.players.find((player) => player.id === account!.id);
  if (!me) return "";
  const opponents = state.players.filter((player) => player.id !== account!.id);
  const myCats = [...me.sofa, ...me.salon];
  const selectedCard = privateState.hand.find((card) => card.instanceId === selectedCardId);
  const selectedDefinition = selectedCard ? CARD_BY_ID.get(selectedCard.cardId) : undefined;
  const selectedOpponentId = opponents[0]?.id ?? "";
  const targetPlayerOptions = selectOptions(opponents.map((player) => ({ id: player.id, label: player.name })), "Jugador objetivo");
  const targetCats = (playerId: string) => {
    const target = state.players.find((player) => player.id === playerId);
    if (!target) return [];
    return [...target.sofa, ...target.salon].map((cat) => ({ id: cat.instanceId, label: `${cardName(cat.cardId)} · ${cat.zone === "sofa" ? "Sofá" : "Salón"}` }));
  };
  const laserOwners = laserEligibleOwners(state);
  const sofaOptions = selectOptions(me.sofa.map((cat) => ({ id: cat.instanceId, label: cardName(cat.cardId) })), "Gato del Sofá");
  const handControls = `<div class="hand">${privateState.hand.map((card) => {
    const definition = CARD_BY_ID.get(card.cardId);
    const canSelect =
      definition?.kind !== "support" &&
      definition?.kind !== "response" &&
      definition?.kind !== "cat" &&
      !(definition?.kind === "object" && definition.effect !== "retrieve_discard") &&
      definition?.effect !== "spy" &&
      !(definition?.effect === "move_cat" && laserOwners.length === 0);
    return `<label class="hand-card ${selectedCardId === card.instanceId ? "chosen" : ""}">
      <input class="hand-choice" type="radio" name="selected-card" value="${escapeHtml(card.instanceId)}"
        ${selectedCardId === card.instanceId ? "checked" : ""} ${canSelect ? "" : "disabled"} />
      ${cardPreviewTrigger(card.cardId, cardName(card.cardId))}
      <b>${escapeHtml(cardName(card.cardId))}</b>
      <small>${escapeHtml(definition?.description ?? "")}</small>
      ${definition?.kind === "support" ? `<span class="support-tag">Apoyo de combate</span>` : ""}
    </label>`;
  }).join("")}</div>`;

  if (privateState.pendingDrawNotice.length > 0) {
    const cats = privateState.pendingCatPlacements;
    const drawSummary = `<h2>Has robado ${privateState.pendingDrawNotice.length} carta${privateState.pendingDrawNotice.length === 1 ? "" : "s"}</h2>
      <div class="drawn-cards">${privateState.pendingDrawNotice.map((card) =>
        cardTile(card.cardId, cardName(card.cardId)),
      ).join("")}</div>`;
    if (cats.length > 0) {
      return interactionPopup(`${drawSummary}
        <p>Elige dónde colocar cada gato. La acción continuará al confirmar.</p>
        ${renderCatPlacementFields(
          "drawn-cat-placement-form",
          cats,
          (cat) => canFitCatOnSofa(me, cat.cardId),
          "Confirmar cartas y colocación",
        )}`, "draw-popup");
    }
    return interactionPopup(`${drawSummary}
      <p>Confirma para continuar con tu turno.</p>
      <button class="primary" data-action="acknowledge-draw">Aceptar</button>`, "draw-popup");
  }

  if (state.pendingCatPlacementPlayerIds.length > 0) {
    if (privateState.pendingCatPlacements.length > 0) {
      const capturedCatId = state.combat?.attackerId === account.id
        ? state.combat.targetCardInstanceId
        : "";
      const isAttackCapture = privateState.pendingCatPlacements.some((cat) => cat.instanceId === capturedCatId);
      if (isAttackCapture) {
        return interactionPopup(renderCatPlacementPanel(
          "Ataque victorioso: elige dónde colocar al gato",
          "Puedes elegir el Sofá si tiene espacio o colocar el gato en el Salón.",
          "drawn-cat-placement-form",
          privateState.pendingCatPlacements,
          (cat) => canFitCatOnSofa(me, cat.cardId),
        ), "cat-placement-popup");
      }
      return interactionPopup(renderCatPlacementPanel(
        `Has recibido ${privateState.pendingCatPlacements.length === 1 ? "un gato" : "gatos"}`,
        "Elige para cada uno el Sofá o el Salón. La acción continúa al confirmar.",
        "drawn-cat-placement-form",
        privateState.pendingCatPlacements,
        privateState.pendingCatPlacements.length === 1
          ? (cat) => canFitCatOnSofa(me, cat.cardId)
          : undefined,
      ), "cat-placement-popup");
    }
    const waitingFor = state.pendingCatPlacementPlayerIds.map(playerName).join(", ");
    return interactionPopup(`<h2>Colocación de gatos pendiente</h2>
      <p>Esperando a que ${escapeHtml(waitingFor)} elija dónde colocar los gatos.</p>`, "cat-placement-popup");
  }

  if (state.phase === "initial_placement") {
    if (privateState.initialPlacementCats.length === 0) {
      const waitingFor = state.initialPlacementPlayerIds.map(playerName).join(", ");
      return interactionPopup(`<h2>Colocación inicial</h2>
        <p>Esperando a que ${escapeHtml(waitingFor)} elija dónde colocar sus gatos.</p>`, "cat-placement-popup");
    }
    return interactionPopup(`${renderCatPlacementPanel(
      "Coloca tus gatos iniciales",
      "Elige para cada gato si empieza en el Sofá o en el Salón. Puedes ampliar una carta para leer sus reglas.",
      "initial-placement-form",
      privateState.initialPlacementCats,
    )}
      <section class="initial-hand">
        <h3>Tu mano inicial</h3>
        <div class="drawn-cards">${privateState.hand.map((card) =>
          cardTile(card.cardId, cardName(card.cardId)),
        ).join("")}</div>
      </section>`, "cat-placement-popup");
  }

  if (!privateState.yourTurn) {
    return `<section class="panel"><h3>Espera tu turno</h3>${handControls}</section>`;
  }

  if (state.pendingDiscard?.playerIds[state.pendingDiscard.cursor] === account.id) {
    const needed = state.pendingDiscard.countByPlayer[account.id] ?? 0;
    return interactionPopup(`<section class="panel"><h3>Descarta ${needed} carta(s)</h3><p>${escapeHtml(state.pendingDiscard.reason)}</p>
      ${renderMultiHandControls(privateState.hand)}<button class="primary" data-action="discard">Confirmar descarte</button></section>`,
    "choice-popup");
  }

  if (state.pendingGlobalChoice?.playerIds[state.pendingGlobalChoice.cursor] === account.id) {
    const pending = state.pendingGlobalChoice;
    if (pending.kind === "toy-exchange") {
      return interactionPopup(`<section class="panel"><h3>Pasa una carta a la izquierda</h3>
        <label>Carta<select name="toy-card">${selectOptions(privateState.hand.map((card) => ({ id: card.instanceId, label: cardName(card.cardId) })), "No pasar carta")}</select></label>
        <button class="primary" data-action="global-choice" data-choice-kind="toy">Pasar carta seleccionada</button></section>`,
      "choice-popup");
    }
    if (pending.kind === "neighbor-dog") {
      return interactionPopup(`<section class="panel"><h3>El perro del vecino</h3><label>Gato que baja al Salón
        <select name="choice-cat">${sofaOptions}</select></label>
        <button class="primary" data-action="global-choice" data-choice-kind="dog">Confirmar</button>
        <button class="quiet" data-action="global-choice" data-choice-kind="dog-pass">No puedo mover</button></section>`,
      "choice-popup");
    }
    return interactionPopup(`<section class="panel"><h3>Visita al Veterinario</h3><p>Elige las cartas que descartas.</p>
      ${renderMultiHandControls(privateState.hand)}<button class="primary" data-action="global-choice" data-choice-kind="vet">Confirmar descarte</button></section>`,
    "choice-popup");
  }
  if (state.pendingGlobalChoice) {
    return interactionPopup(`<h2>Elección pendiente</h2>
      <p>Esperando a ${escapeHtml(playerName(state.pendingGlobalChoice.playerIds[state.pendingGlobalChoice.cursor] ?? ""))}.</p>`,
    "choice-popup");
  }

  if (privateState.pendingChoice) {
    const choice = privateState.pendingChoice;
    if (choice === "curious-keep") {
      return interactionPopup(`<section class="panel"><h3>Gato Curioso: conserva una carta</h3>
        ${privateState.peekedCards.map((card) => `<label class="choice-card"><input type="radio" name="peek-card" value="${escapeHtml(card.instanceId)}" />
          ${cardTile(card.cardId, cardName(card.cardId))}</label>`).join("")}
        <button class="primary" data-action="curious-keep">Quedarme la carta elegida</button></section>`,
      "choice-popup");
    }
    if (choice === "fat-peek") {
      return interactionPopup(`<section class="panel"><h3>Gato Gordo: primera carta del mazo</h3>
        ${privateState.peekedCards.map((card) => cardTile(card.cardId, cardName(card.cardId))).join("")}
        <button class="primary" data-action="fat-top">Dejar arriba</button>
        <button class="quiet" data-action="fat-bottom">Poner al fondo</button></section>`,
      "choice-popup");
    }
    if (choice === "salvage-structure") {
      return interactionPopup(`<section class="panel"><h3>Recuperar la Estructura</h3>
        <p>Descarta una carta para recuperarla del descarte.</p>
        <label>Carta de pago<select name="salvage-card">${selectOptions(privateState.hand.map((card) => ({ id: card.instanceId, label: cardName(card.cardId) })), "Elige una carta")}</select></label>
        <button class="primary" data-action="salvage-pay">Descartar y recuperar</button>
        <button class="quiet" data-action="salvage-pass">Pasar</button></section>`,
      "choice-popup");
    }
  }

  if (state.responseWindow) {
    const window = state.responseWindow;
    const canRespond = window.recipientIds[window.cursor] === account.id;
    if (!canRespond && window.pendingActorId === account.id) {
      return interactionPopup(`<h2>Flús-Flús pendiente 💦</h2>
        <p>Has jugado ${escapeHtml(cardName(window.pendingCardId))}. Esperando la respuesta de ${escapeHtml(playerName(window.recipientIds[window.cursor] ?? ""))}.</p>
        <p class="response-countdown">Tiempo para responder: <strong data-countdown="${window.expiresAt}">15</strong> s</p>`,
      "flush-popup");
    }
    if (!canRespond) return `<section class="panel"><h3>Ventana de Flús-Flús</h3><p>Esperando respuestas…</p></section>`;
    const flush = privateState.hand.filter((card) => CARD_BY_ID.get(card.cardId)?.effect === "cancel");
    const remaining = Math.max(0, Math.ceil((window.expiresAt - Date.now()) / 1000));
    return `<dialog id="response-popup" class="interaction-popup response-popup flush-popup ${state.combat?.targetPlayerId === account.id ? "attack-popup" : ""}" aria-labelledby="response-popup-title">
      <h2 id="response-popup-title">Respuesta de Flús-Flús 💦</h2>
      <p>${escapeHtml(playerName(window.actorId))} ha jugado ${escapeHtml(cardName(window.cardId))}. Puedes cancelarla antes de que se resuelva.</p>
      <p class="response-countdown">Tiempo para responder: <strong data-countdown="${window.expiresAt}">${remaining}</strong> s</p>
      ${flush.length
        ? `<div class="response-options">${flush.map((card) =>
          `<button class="primary" data-action="flush" data-card="${escapeHtml(card.instanceId)}">Cancelar con Flús-Flús</button>`,
        ).join("")}</div>`
        : `<p class="response-no-card">No tienes Flús-Flús en la mano. Puedes pasar ahora o dejar que se agote el tiempo.</p>`}
      <button class="quiet" data-action="pass-response">Pasar sin gastar carta</button></dialog>`;
  }

  if (state.combat) {
    if (privateState.redirectAvailable) {
      const mouse = privateState.hand.find((card) => card.cardId === "object-mouse");
      return `<dialog id="response-popup" class="interaction-popup response-popup attack-popup" aria-labelledby="response-popup-title">
        <h2 id="response-popup-title">¡Te están atacando!</h2>
        <p>Un rival ataca tu ${escapeHtml(cardName(findTargetCard(state, state.combat.targetCardInstanceId)?.cardId ?? ""))}. Puedes cambiar el objetivo con Ratón con Hierba Gatuna o pasar a la defensa.</p>
        ${renderTargetControls(opponents, state, selectedOpponentId)}
        ${mouse ? `<button class="primary" data-action="redirect" data-card="${escapeHtml(mouse.instanceId)}">Desviar con Ratón con Hierba Gatuna</button>` : ""}
        <p class="response-countdown">Responde antes de <strong data-countdown="${state.combat.defenseExpiresAt}">30</strong> s.</p>
        <button class="quiet" data-action="pass-redirect">Pasar a la defensa</button></dialog>`;
    }
    if (state.combat.targetPlayerId === account.id) {
      const attacks = privateState.hand.filter((card) => CARD_BY_ID.get(card.cardId)?.kind === "attack");
      const supports = privateState.hand.filter((card) => CARD_BY_ID.get(card.cardId)?.kind === "support");
      const spy = privateState.hand.find((card) => card.cardId === "action-spy");
      const nosy = me.sofa.some((cat) => cat.cardId === "cat-nosy");
      return `<dialog id="response-popup" class="interaction-popup response-popup attack-popup" aria-labelledby="response-popup-title">
        <h2 id="response-popup-title">¡Te están atacando!</h2>
        <p>Un rival ataca tu ${escapeHtml(cardName(findTargetCard(state, state.combat.targetCardInstanceId)?.cardId ?? ""))}.</p>
        ${attacks.length
          ? `<label>Defensa<select name="defense-card">${selectOptions(attacks.map((card) => ({ id: card.instanceId, label: cardName(card.cardId) })), "Aceptar ataque sin defenderte")}</select></label>
            ${supports.map((card) => `<label class="inline"><input type="checkbox" name="defense-support" value="${escapeHtml(card.instanceId)}" />${escapeHtml(cardName(card.cardId))}</label>`).join("")}
            ${spy ? `<label class="inline"><input type="checkbox" name="use-spy" />Usar Espía después de elegir</label>` : ""}`
          : `<p class="attack-unavailable">No tienes una carta de Ataque para defenderte. Elige cuándo aceptar el ataque.</p>`}
        ${nosy ? `<label class="inline"><input type="checkbox" name="use-nosy" />Revelar el ataque con Cotilla</label>
          <label>Coste de Cotilla<select name="nosy-cost">${selectOptions(privateState.hand.map((card) => ({ id: card.instanceId, label: cardName(card.cardId) })), "Carta a descartar")}</select></label>` : ""}
        <p class="response-countdown">Responde antes de <strong data-countdown="${state.combat.defenseExpiresAt}">30</strong> s.</p>
        <button class="primary" data-action="defend">${attacks.length ? "Confirmar respuesta" : "Aceptar ataque"}</button></dialog>`;
    }
    if (state.combat.attackerId === account.id) {
      return interactionPopup(`<h2>Ataque en curso</h2>
        <p>Tu ataque contra ${escapeHtml(playerName(state.combat.targetPlayerId))} está esperando una respuesta.</p>
        <p class="response-countdown">La respuesta vence en <strong data-countdown="${state.combat.defenseExpiresAt}">30</strong> s.</p>`,
      "attack-popup");
    }
    return `<section class="panel"><h3>Combate en curso</h3><p>Esperando a ${escapeHtml(playerName(state.combat.targetPlayerId))}.</p></section>`;
  }

  if (state.phase === "pre_action" && state.initialDrawChoicePlayerId === account.id) {
    return interactionPopup(`<section class="panel"><h3>Robo inicial</h3>
      <button class="primary" data-action="initial-draw" data-use-raccoon="false">Robar del mazo</button>
      <button class="quiet" data-action="initial-draw" data-use-raccoon="true">Usar Gato Mapache</button></section>`,
    "draw-popup");
  }

  if (state.phase === "litter") {
    return interactionPopup(`<section class="panel"><h3>Arenero</h3><p>Elige una carta para recuperar o deja todo.</p>
      ${privateState.litter.map((card) => `<label class="choice-card"><input type="radio" name="litter-card" value="${escapeHtml(card.instanceId)}" />
        ${cardTile(card.cardId, cardName(card.cardId))}</label>`).join("")}
      <button class="primary" data-action="recover-litter">Recuperar selección</button>
      <button class="quiet" data-action="leave-litter">Dejar en el Arenero</button></section>`,
    "choice-popup");
  }

  let phaseControls = "";
  if (state.phase === "action") {
    const canPrepare = !state.actionUsed;
    const canCurious = canPrepare && me.sofa.some((cat) => cat.cardId === "cat-curious") && privateState.hand.length > 0;
    const tripletCount = me.sofa.filter((cat) => cat.cardId.startsWith("cat-triplet-")).length;
    const canTriplets = canPrepare && tripletCount > 0;
    const canHyperactive = canPrepare && me.sofa.some((cat) => cat.cardId === "cat-hyperactive");
    const canScratcher = canPrepare && me.structure?.cardId === "structure-scratcher" && privateState.hand.length > 0;
    phaseControls = `<div class="controls">
      ${canCurious ? `<button class="quiet" data-action="preaction" data-ability="curious">Activar Curioso (descarta seleccionada)</button>` : ""}
      ${canCurious ? `<label>Coste de Curioso<select name="preaction-cost">${selectOptions(privateState.hand.map((card) => ({ id: card.instanceId, label: cardName(card.cardId) })), "Elige una carta")}</select></label>` : ""}
      ${canTriplets ? `<button class="quiet" data-action="preaction" data-ability="triplets">Activar Trillizos (descarta seleccionadas)</button>` : ""}
      ${canTriplets ? `<fieldset><legend>Cartas para Trillizos (${tripletCount})</legend>${privateState.hand.map((card) =>
        `<label class="inline"><input type="checkbox" name="triplet-card" value="${escapeHtml(card.instanceId)}" />${escapeHtml(cardName(card.cardId))}</label>`,
      ).join("")}</fieldset>` : ""}
      ${canHyperactive ? `<label>Gato para Hiperactivo<select name="hyper-cat">${selectOptions(myCats.map((cat) => ({ id: cat.instanceId, label: cardName(cat.cardId) })), "Elige un gato")}</select></label>
        <label>Destino<select name="hyper-to"><option value="salon">Salón</option><option value="sofa">Sofá</option></select></label>
        <button class="quiet" data-action="preaction" data-ability="hyperactive">Activar Hiperactivo</button>` : ""}
      ${canScratcher ? `<button class="quiet" data-action="preaction" data-ability="scratcher">Activar Rascador (descarta seleccionada)</button>` : ""}
      ${canScratcher ? `<label>Coste del Rascador<select name="preaction-cost">${selectOptions(privateState.hand.map((card) => ({ id: card.instanceId, label: cardName(card.cardId) })), "Elige una carta")}</select></label>` : ""}
      ${canPrepare ? `<button class="quiet" data-action="skip-actions">Saltar Fase de Acción</button>` : ""}
    </div>`;
  } else if (state.phase === "movement") {
    phaseControls = `<div class="controls">
      <label>Gato<select name="move-cat">${selectOptions(myCats.map((cat) => ({ id: cat.instanceId, label: cardName(cat.cardId) })), "Elige un gato")}</select></label>
      <label>Destino<select name="move-to"><option value="salon">Salón</option><option value="sofa">Sofá</option></select></label>
      <button class="quiet" data-action="move">Mover gato</button>
      <button class="primary" data-action="finish-movement">Terminar movimiento</button>
    </div>`;
  }

  const actionFields = selectedDefinition
    ? renderSelectedCardForm(selectedDefinition.effect, opponents, state, me, targetPlayerOptions, sofaOptions)
    : `<p class="hint">Elige una carta de acción o ataque de tu mano.</p>`;
  const actionPopup = selectedCard && selectedDefinition
    ? interactionPopup(`<header class="action-popup-header">
        <div>${cardTile(selectedCard.cardId, cardName(selectedCard.cardId))}</div>
        <button class="quiet" data-action="cancel-selection">Cancelar</button>
      </header>
      ${actionFields}
      ${selectedDefinition.kind === "attack" ? renderSupportChoices(privateState.hand) : ""}`,
    "card-action-popup")
    : "";
  return `<section class="panel action-panel">
    <h3>${phaseLabel(state.phase)}${state.phase === "action" ? ` · ${state.actionsRemaining} acción(es)` : ""}</h3>
    ${phaseControls}
    ${state.phase === "action" ? `<h4>Mano</h4>${handControls}${actionPopup}` : ""}
    ${state.phase === "movement" ? handControls : ""}
  </section>`;
}

function renderTargetControls(opponents: PublicPlayerState[], state: PublicGameState, defaultTarget: string): string {
  return `<label>Jugador objetivo<select name="target-player">${selectOptions(opponents.map((player) => ({ id: player.id, label: player.name })), "Elige rival")}</select></label>
    <label>Objetivo<select name="target-card" data-default-target="${escapeHtml(defaultTarget)}">
      ${selectOptions(targetCats(state, defaultTarget), "Gato o Estructura")}</select></label>`;
}

function renderMultiHandControls(hand: PrivateGameState["hand"]): string {
  return `<div class="hand">${hand.map((card) => `<label class="hand-card">
    <input type="checkbox" name="selected-card" value="${escapeHtml(card.instanceId)}" />
    ${cardPreviewTrigger(card.cardId, cardName(card.cardId))}
    <b>${escapeHtml(cardName(card.cardId))}</b></label>`).join("")}</div>`;
}

function targetCats(state: PublicGameState, playerId: string): Array<{ id: string; label: string }> {
  const target = state.players.find((player) => player.id === playerId);
  if (!target) return [];
  const cats = [...target.sofa, ...target.salon].map((cat) => ({
    id: cat.instanceId,
    label: `${cardName(cat.cardId)} · ${cat.zone === "sofa" ? "Sofá" : "Salón"}`,
  }));
  if (target.structure) cats.push({ id: target.structure.instanceId, label: cardName(target.structure.cardId) });
  return cats;
}

function catOptionsForPlayer(state: PublicGameState, playerId: string): Array<{ id: string; label: string }> {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) return [];
  return [...player.sofa, ...player.salon].map((cat) => ({
    id: cat.instanceId,
    label: `${cardName(cat.cardId)} · ${cat.zone === "sofa" ? "Sofá" : "Salón"}`,
  }));
}

function laserEligibleOwners(state: PublicGameState): PublicPlayerState[] {
  if (state.activeEffects.some((effect) => effect.kind === "strike")) return [];
  return state.players.filter((player) => player.sofa.length + player.salon.length > 0);
}

function laserDestinationOptions(state: PublicGameState, ownerId: string, catId: string): string {
  const owner = state.players.find((player) => player.id === ownerId);
  const cat = owner ? [...owner.sofa, ...owner.salon].find((candidate) => candidate.instanceId === catId) : undefined;
  if (!cat) return `<option value="" selected disabled>Elige primero un gato</option>`;
  const destination = cat.zone === "sofa" ? "salon" : "sofa";
  return `<option value="${destination}" selected>${destination === "sofa" ? "Sofá" : "Salón"}</option>`;
}

function salonCatOptions(state: PublicGameState, playerId: string): Array<{ id: string; label: string }> {
  const player = state.players.find((candidate) => candidate.id === playerId);
  return player?.salon.map((cat) => ({ id: cat.instanceId, label: cardName(cat.cardId) })) ?? [];
}

function renderSelectedCardForm(
  effect: string,
  opponents: PublicPlayerState[],
  state: PublicGameState,
  me: PublicPlayerState,
  targetPlayerOptions: string,
  sofaOptions: string,
): string {
  const targetPlayer = opponents[0]?.id ?? "";
  const allCats = [...me.sofa, ...me.salon].map((cat) => ({ id: cat.instanceId, label: cardName(cat.cardId) }));
  const otherCards = privateState!.hand.filter((card) => card.instanceId !== selectedCardId);
  const targetEffects = ["skip_turn", "random_discard", "steal_random", "swap_cats", "steal_living_room_cat", "sabotage"];
  let fields = "";

  if (effect === "attack") {
    fields += `<label>Rival<select name="targetPlayerId">${targetPlayerOptions}</select></label>
      <label>Gato o Estructura<select name="targetCardInstanceId">${selectOptions(
        targetCats(state, targetPlayer),
        "Elige el objetivo",
      )}</select></label>`;
  }
  if (targetEffects.includes(effect)) fields += `<label>Rival<select name="targetPlayerId">${targetPlayerOptions}</select></label>`;
  if (effect === "steal_living_room_cat") {
    fields += `<label>Gato del Salón rival<select name="targetCatInstanceId">${selectOptions(salonCatOptions(state, targetPlayer), "Elige el gato")}</select></label>`;
  }
  if (effect === "swap_cats") {
    fields += `<label>Gato rival<select name="targetCatInstanceId">${selectOptions(targetCats(state, targetPlayer), "Elige el gato")}</select></label>`;
  }
  if (effect === "swap_cats") {
    fields += `<label>Tu gato<select name="ownCatInstanceId">${selectOptions(allCats, "Elige tu gato")}</select></label>`;
  }
  if (effect === "move_cat") {
    const laserOwners = laserEligibleOwners(state);
    if (laserOwners.length === 0) {
      const message = state.activeEffects.some((activeEffect) => activeEffect.kind === "strike")
        ? "La Huelga bloquea los movimientos entre el Sofá y el Salón."
        : "No hay gatos en ninguna casa para mover con el Láser.";
      fields += `<p class="hint">${message}</p>`;
    } else {
      const owner = laserOwners.find((player) => player.id === me.id) ?? laserOwners[0]!;
      fields += `<p class="hint">Tú eliges la casa, el gato y su destino.</p>
        <label>Casa<select name="ownerId">${laserOwners.map((player) =>
          `<option value="${escapeHtml(player.id)}" ${player.id === owner.id ? "selected" : ""}>${player.id === me.id ? "Tu casa" : escapeHtml(player.name)}</option>`,
        ).join("")}</select></label>
        <label>Gato<select name="catInstanceId">${selectOptions(catOptionsForPlayer(state, owner.id), "Elige un gato")}</select></label>
        <label>Destino<select name="to">${laserDestinationOptions(state, owner.id, "")}</select></label>`;
    }
  }
  if (effect === "bed") fields += `<label>Gato protegido<select name="protectedCatInstanceId">${sofaOptions}</select></label>`;
  if (effect === "purr") {
    fields += `<fieldset><legend>Gatos para Ronroneo</legend>${me.sofa.map((cat) =>
      `<label class="inline"><input type="checkbox" name="purr-cat" value="${escapeHtml(cat.instanceId)}" />${escapeHtml(cardName(cat.cardId))}</label>`,
    ).join("")}</fieldset>`;
  }
  if (effect === "retrieve_discard") {
    fields += `<label>Recuperar del descarte<select name="discardCardInstanceId">${selectOptions(
      state.discard.map((card) => ({ id: card.instanceId, label: cardName(card.cardId) })),
      "Elige carta del descarte",
    )}</select></label>`;
  }
  if (effect === "sabotage") {
    fields += `<label>Estructura rival<select name="targetStructureId">${selectOptions(
      opponents.filter((player) => player.structure).map((player) => ({ id: player.id, label: `${player.name}: ${cardName(player.structure!.cardId)}` })),
      "Elige rival con Estructura",
    )}</select></label>`;
  }
  if (["curious", "scratcher"].includes(effect)) {
    fields += `<label>Descartar como coste<select name="cost-card">${selectOptions(otherCards.map((card) => ({ id: card.instanceId, label: cardName(card.cardId) })), "Carta a descartar")}</select></label>`;
  }
  if (effect === "hyperactive") {
    fields += `<label>Gato<select name="movement-cat">${selectOptions(allCats, "Elige un gato")}</select></label>
      <label>Destino<select name="movement-to"><option value="sofa">Sofá</option><option value="salon">Salón</option></select></label>`;
  }
  if (effect === "triplet") {
    fields += `<fieldset><legend>Cartas para intercambiar por robo</legend>${otherCards.map((card) =>
      `<label class="inline"><input type="checkbox" name="triplet-card" value="${escapeHtml(card.instanceId)}" />${escapeHtml(cardName(card.cardId))}</label>`,
    ).join("")}</fieldset>`;
  }
  if (effect === "nosy") {
    fields += `<label>Descartar para revelar<select name="nosy-cost">${selectOptions(privateState!.hand.map((card) => ({ id: card.instanceId, label: cardName(card.cardId) })), "Carta a descartar")}</select></label>`;
  }

  if (!fields) fields = `<p class="hint">No hacen falta elecciones adicionales.</p>`;
  const laserUnavailable = effect === "move_cat" && laserEligibleOwners(state).length === 0;
  return `<form id="action-form" data-effect="${escapeHtml(effect)}">${fields}
    <button class="primary" type="submit" ${laserUnavailable ? "disabled" : ""}>Jugar carta</button></form>`;
}

function renderSupportChoices(hand: PrivateGameState["hand"]): string {
  const supports = hand.filter((card) => CARD_BY_ID.get(card.cardId)?.kind === "support");
  return `<fieldset><legend>Apoyos opcionales</legend>${supports.map((card) =>
    `<label class="inline"><input type="checkbox" class="support-choice" value="${escapeHtml(card.instanceId)}"
      ${selectedSupportIds.has(card.instanceId) ? "checked" : ""} />${escapeHtml(cardName(card.cardId))}</label>`,
  ).join("")}</fieldset>`;
}

function findTargetCard(state: PublicGameState, instanceId: string): { cardId: string } | undefined {
  for (const player of state.players) {
    const found = [...player.sofa, ...player.salon, ...(player.structure ? [player.structure] : [])]
      .find((card) => card.instanceId === instanceId);
    if (found) return found;
  }
  return undefined;
}

function phaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    pre_action: "Preparación",
    initial_placement: "Colocación inicial",
    action: "Fase de Acción",
    movement: "Movimiento",
    litter: "Arenero",
    discard: "Descarte",
    response: "Respuesta",
    choice: "Elección",
    combat: "Combate",
    finished: "Partida terminada",
  };
  return labels[phase] ?? phase;
}

function renderGame(): void {
  if (!publicState || !privateState || !account) return;
  const me = publicState.players.find((player) => player.id === account!.id);
  if (!me) return;
  const opponents = publicState.players.filter((player) => player.id !== me.id);
  const topDiscard = publicState.discard[publicState.discard.length - 1];
  root!.innerHTML = `
    <main class="game-shell ${publicState.combat && !publicState.responseWindow && publicState.combat.targetPlayerId === account.id ? "attack-pending" : ""}">
      <header class="topbar">
        <div><p class="eyebrow">Ronda ${publicState.round} · ${publicState.deckCount} cartas en el mazo · ${publicState.discardCount} en descarte</p>
          <h1>¡Ese gato es mío!</h1></div>
        <div class="profile">${escapeHtml(account.username)} · ELO ${account.elo}
          <button data-action="toggle-theme" class="quiet">Tema ${account.theme === "dark" ? "oscuro" : "claro"} · cambiar</button>
          <button data-action="logout" class="quiet">Salir</button></div>
      </header>
      ${publicState.activeEffects.map((effect) => `<p class="effect-banner">${effect.kind === "nap" ? "Hora de la Siesta: habilidades anuladas" : "Huelga: movimientos bloqueados"}</p>`).join("")}
      ${publicState.winnerId ? `<section class="winner">🏆 ${escapeHtml(playerName(publicState.winnerId))} gana la partida</section>` : ""}
      <section class="discard-summary panel">
        <div><h3>Descarte · ${publicState.discardCount}</h3>
          ${topDiscard
            ? cardTile(topDiscard.cardId, cardName(topDiscard.cardId))
            : `<p class="empty">Todavía no hay cartas descartadas.</p>`}
        </div>
        <button class="quiet" data-action="show-discard" ${publicState.discard.length === 0 ? "disabled" : ""}>Ver pila completa</button>
      </section>
      ${opponents.length ? `<section class="opponents-board"><h2>Rivales</h2>
        <div class="opponents-grid">${opponents.map(renderBoardPlayer).join("")}</div></section>` : ""}
      <section class="own-board"><h2>Tu tablero</h2>${renderBoardPlayer(me)}</section>
      ${renderActionPanel()}
      <section class="panel"><h3>Registro de partida</h3><ol class="log">${publicState.log.slice(-12).reverse().map((entry) => `<li>${escapeHtml(entry.text)}</li>`).join("")}</ol></section>
      ${publicState.winnerId ? `<section class="panel"><h3>Partidas recientes</h3>${matchHistory.map((match) =>
        `<p>${escapeHtml(match.playedAt.slice(0, 10))} · ${escapeHtml(match.winnerName)} ganó (${match.playerNames.map(escapeHtml).join(", ")})</p>`,
      ).join("") || `<p class="hint">Cargando historial…</p>`}</section>` : ""}
      ${renderMessages()}
    </main>`;
  const popup = root!.querySelector<HTMLDialogElement>(".interaction-popup");
  if (popup) {
    popup.addEventListener("cancel", (event) => event.preventDefault());
    if (!popup.open) popup.showModal();
  }
  updatePresenceBadges();
}

function render(): void {
  root!.classList.toggle(
    "attack-pending",
    Boolean(publicState?.combat && !publicState.responseWindow && publicState.combat.targetPlayerId === account?.id),
  );
  if (!account) renderLogin();
  else if (!publicState) renderLobby();
  else renderGame();
  if (responseCountdownInterval !== null) window.clearInterval(responseCountdownInterval);
  responseCountdownInterval = null;
  const countdowns = [...root!.querySelectorAll<HTMLElement>("[data-countdown]")];
  if (countdowns.length > 0) {
    const updateCountdown = () => {
      for (const element of root!.querySelectorAll<HTMLElement>("[data-countdown]")) {
        const expiresAt = Number(element.dataset.countdown);
        element.textContent = String(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1_000)));
      }
    };
    updateCountdown();
    responseCountdownInterval = window.setInterval(updateCountdown, 250);
  }
  if (presenceInterval === null) {
    presenceInterval = window.setInterval(updatePresenceBadges, 1_000);
  }
}

function setError(error: unknown): void {
  errorMessage = error instanceof Error ? error.message : "Ha ocurrido un error inesperado.";
  render();
}

function send(command: GameCommand): void {
  if (!room) {
    setError(new Error("No hay una conexión activa con la sala."));
    return;
  }
  errorMessage = "";
  room.send("command", command);
}

async function enterRoom(loginToken: string): Promise<void> {
  const client = new Client(socketUrl);
  room = await client.joinOrCreate("game", { token: loginToken });
  room.onMessage("lobby", (message: typeof lobby) => {
    if (message) lobby = message;
    publicState = null;
    privateState = null;
    render();
  });
  room.onMessage("public-state", (message: PublicGameState) => {
    const justFinished = Boolean(message.winnerId && !publicState?.winnerId);
    publicState = message;
    lobby = null;
    render();
    if (justFinished) {
      void fetch(`${apiUrl}/api/history`)
        .then(async (response) => {
          if (!response.ok) throw new Error("No se pudo cargar el historial.");
          const result = await response.json() as { matches: typeof matchHistory };
          matchHistory = result.matches;
          render();
        })
        .catch(setError);
    }
  });
  room.onMessage("private-state", (message: PrivateGameState) => {
    privateState = message;
    render();
  });
  room.onMessage("presence", (message: { idleSinceByPlayer: Record<string, number> }) => {
    idleSinceByPlayer = message.idleSinceByPlayer;
    updatePresenceBadges();
  });
  room.onMessage("error", (message: string) => {
    errorMessage = message;
    render();
  });
  room.onMessage("notice", (message: string) => {
    noticeMessage = message;
    render();
  });
  room.send("refresh");
  lobby = { players: [], hostId: null };
  renderLobby();
}

function field(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value : "";
}

function fieldFromRoot(name: string): string {
  const element = root!.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`);
  return element?.value ?? "";
}

root.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  if (form.id === "login-form") {
    event.preventDefault();
    const data = new FormData(form);
    errorMessage = "";
    void fetch(`${apiUrl}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: field(data, "username"), password: field(data, "password") }),
    })
      .then(async (response) => {
        const result = await response.json() as { error?: string; token?: string; account?: typeof account };
        if (!response.ok || !result.token || !result.account) throw new Error(result.error ?? "No se pudo iniciar sesión.");
        token = result.token;
        account = result.account;
        applyTheme(account.theme);
        await enterRoom(token);
      })
      .catch(setError);
    return;
  }

  if (form.id === "initial-placement-form") {
    event.preventDefault();
    const data = new FormData(form);
    const placements: Array<{ catInstanceId: string; to: "sofa" | "salon" }> = [];
    for (const cat of privateState?.initialPlacementCats ?? []) {
      const to = field(data, `destination-${cat.instanceId}`);
      if (to !== "sofa" && to !== "salon") {
        form.reportValidity();
        return;
      }
      placements.push({ catInstanceId: cat.instanceId, to });
    }
    if (placements.length > 0) send({ type: "choose-initial-cats", placements });
    return;
  }

  if (form.id === "drawn-cat-placement-form") {
    event.preventDefault();
    const data = new FormData(form);
    const placements: Array<{ catInstanceId: string; to: "sofa" | "salon" }> = [];
    for (const cat of privateState?.pendingCatPlacements ?? []) {
      const to = field(data, `destination-${cat.instanceId}`);
      if (to !== "sofa" && to !== "salon") {
        form.reportValidity();
        return;
      }
      placements.push({ catInstanceId: cat.instanceId, to });
    }
    if (placements.length > 0) send({ type: "choose-drawn-cats", placements });
    return;
  }

  if (form.id === "action-form") {
    event.preventDefault();
    if (!selectedCardId || !publicState || !account) return;
    const data = new FormData(form);
    const effect = form.dataset.effect;
    const choices: Record<string, string | string[] | boolean | undefined> = {};
    for (const key of ["targetPlayerId", "targetCatInstanceId", "ownCatInstanceId", "ownerId", "catInstanceId", "to", "protectedCatInstanceId", "discardCardInstanceId"]) {
      const value = field(data, key);
      if (value) choices[key] = value;
    }
    if (effect === "sabotage") choices.targetPlayerId = field(data, "targetStructureId");
    if (effect === "purr") choices.catInstanceIds = data.getAll("purr-cat").map(String);
    if (effect === "triplet") choices.cards = data.getAll("triplet-card").map(String);
    if (effect === "curious" || effect === "scratcher") choices.costCardInstanceId = field(data, "cost-card");
    if (effect === "nosy") {
      const cost = field(data, "nosy-cost");
      send({ type: "reveal-attack", method: "nosy", cardInstanceId: cost });
      selectedCardId = "";
      render();
      return;
    }
    if (selectedDefinitionFor(selectedCardId)?.kind === "attack") {
      send({
        type: "declare-attack",
        targetPlayerId: field(data, "targetPlayerId"),
        targetCardInstanceId: field(data, "targetCardInstanceId"),
        attackInstanceId: selectedCardId,
        supportInstanceIds: [...selectedSupportIds],
      });
      selectedCardId = "";
      selectedSupportIds.clear();
      render();
      return;
    }
    if (effect === "hyperactive") {
      send({
        type: "activate-preaction",
        ability: "hyperactive",
        movement: {
          playerId: account.id,
          catInstanceId: field(data, "movement-cat"),
          to: field(data, "movement-to") as "sofa" | "salon",
        },
      });
      selectedCardId = "";
      render();
      return;
    }
    if (effect === "curious" || effect === "scratcher" || effect === "triplet") {
      send({
        type: "activate-preaction",
        ability: effect === "triplet" ? "triplets" : effect,
        cards: effect === "triplet" ? data.getAll("triplet-card").map(String) : [field(data, "cost-card")],
      });
      selectedCardId = "";
      render();
      return;
    }
    send({ type: "play-card", cardInstanceId: selectedCardId, choices });
    selectedCardId = "";
    selectedSupportIds.clear();
    render();
  }
});

root.addEventListener("change", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.classList.contains("hand-choice") && target.checked) {
    selectedCardId = target.value;
    render();
  } else if (target instanceof HTMLInputElement && target.classList.contains("support-choice")) {
    if (target.checked) selectedSupportIds.add(target.value);
    else selectedSupportIds.delete(target.value);
    render();
  } else if (target instanceof HTMLSelectElement && target.name.startsWith("destination-")) {
    const catInstanceId = target.name.slice("destination-".length);
    if (target.value === "sofa" || target.value === "salon") {
      placementChoices.set(catInstanceId, target.value);
    } else {
      placementChoices.delete(catInstanceId);
    }
    render();
  } else if (target instanceof HTMLSelectElement && ["target-player", "targetPlayerId"].includes(target.name)) {
    const cardSelect = root!.querySelector<HTMLSelectElement>('select[name="target-card"], select[name="targetCardInstanceId"]');
    const effect = root!.querySelector<HTMLFormElement>("#action-form")?.dataset.effect;
    if (cardSelect && publicState) {
      const options = effect === "steal_living_room_cat"
        ? salonCatOptions(publicState, target.value)
        : targetCats(publicState, target.value);
      cardSelect.innerHTML = selectOptions(options, "Gato o Estructura");
    }
  } else if (target instanceof HTMLSelectElement && target.name === "ownerId" && publicState) {
    const catSelect = root!.querySelector<HTMLSelectElement>('select[name="catInstanceId"]');
    if (catSelect) catSelect.innerHTML = selectOptions(catOptionsForPlayer(publicState, target.value), "Elige el gato");
    const destinationSelect = root!.querySelector<HTMLSelectElement>('select[name="to"]');
    if (destinationSelect) destinationSelect.innerHTML = laserDestinationOptions(publicState, target.value, "");
  } else if (target instanceof HTMLSelectElement && target.name === "catInstanceId" && publicState) {
    const ownerId = fieldFromRoot("ownerId");
    const destinationSelect = root!.querySelector<HTMLSelectElement>('select[name="to"]');
    if (destinationSelect) destinationSelect.innerHTML = laserDestinationOptions(publicState, ownerId, target.value);
  }
});

root.addEventListener("click", (event) => {
  const preview = (event.target as HTMLElement).closest<HTMLImageElement>("img[data-card-preview]");
  if (preview) {
    event.preventDefault();
    event.stopPropagation();
    showCardPreview(preview.dataset.cardPreview ?? "");
    return;
  }
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-action]");
  if (!button) return;
  const action = button.dataset.action;
  const checked = (name: string) => [...root!.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)].map((input) => input.value);

  if (action === "logout") {
    room?.leave();
    room = null;
    account = null;
    token = null;
    applyTheme("light");
    publicState = null;
    privateState = null;
    lobby = null;
    idleSinceByPlayer = {};
    render();
  } else if (action === "toggle-theme") {
    void toggleTheme();
  } else if (action === "show-discard") {
    showDiscardPile();
  } else if (action === "show-synergies") {
    showSynergies(button.dataset.playerId ?? "");
  } else if (action === "start") {
    room?.send("start-game");
  } else if (action === "skip-actions") send({ type: "skip-action-phase" });
  else if (action === "finish-movement") send({ type: "finish-movement" });
  else if (action === "initial-draw") send({ type: "choose-initial-draw", useRaccoon: button.dataset.useRaccoon === "true" });
  else if (action === "acknowledge-draw") send({ type: "acknowledge-draw" });
  else if (action === "cancel-selection") {
    selectedCardId = "";
    selectedSupportIds.clear();
    render();
  }
  else if (action === "move") {
    const me = publicState?.players.find((player) => player.id === account?.id);
    const catId = fieldFromRoot("move-cat");
    const cat = me && [...me.sofa, ...me.salon].find((item) => item.instanceId === catId);
    if (cat && (fieldFromRoot("move-to") === "sofa" || fieldFromRoot("move-to") === "salon")) {
      send({ type: "move", movement: { playerId: me.id, catInstanceId: catId, to: fieldFromRoot("move-to") as "sofa" | "salon" } });
    }
  } else if (action === "discard") send({ type: "discard-cards", cardInstanceIds: checked("selected-card") });
  else if (action === "global-choice") {
    const kind = button.dataset.choiceKind;
    if (kind === "toy") send({ type: "resolve-choice", choice: fieldFromRoot("toy-card") });
    if (kind === "dog") send({ type: "resolve-choice", choice: fieldFromRoot("choice-cat") });
    if (kind === "dog-pass") send({ type: "resolve-choice", choice: "" });
    if (kind === "vet") send({ type: "resolve-choice", choice: checked("selected-card") });
  } else if (action === "curious-keep") {
    const selected = root!.querySelector<HTMLInputElement>('input[name="peek-card"]:checked');
    if (selected) send({ type: "resolve-choice", choice: selected.value });
  } else if (action === "fat-top") send({ type: "resolve-choice", choice: "top" });
  else if (action === "fat-bottom") send({ type: "resolve-choice", choice: "bottom" });
  else if (action === "salvage-pay") {
    const paymentId = fieldFromRoot("salvage-card");
    if (paymentId) send({ type: "resolve-choice", choice: `pay:${paymentId}` });
  } else if (action === "salvage-pass") send({ type: "resolve-choice", choice: "pass" });
  else if (action === "flush") send({ type: "respond-flush", cardInstanceId: button.dataset.card ?? "" });
  else if (action === "pass-response") send({ type: "pass-response" });
  else if (action === "defend") {
    const spy = root!.querySelector<HTMLInputElement>('input[name="use-spy"]')?.checked;
    const spyCard = spy ? privateState?.hand.find((card) => card.cardId === "action-spy")?.instanceId : undefined;
    const useNosy = root!.querySelector<HTMLInputElement>('input[name="use-nosy"]')?.checked;
    const nosyCost = fieldFromRoot("nosy-cost");
    if (useNosy) {
      send({ type: "reveal-attack", method: "nosy", ...(nosyCost ? { cardInstanceId: nosyCost } : {}) });
    }
    send({
      type: "choose-defense",
      defenseInstanceId: fieldFromRoot("defense-card") || null,
      supportInstanceIds: checked("defense-support"),
      ...(spyCard ? { spyInstanceId: spyCard } : {}),
    });
  } else if (action === "redirect") {
    const targetPlayerId = fieldFromRoot("target-player");
    const targetCardInstanceId = fieldFromRoot("target-card");
    if (targetPlayerId && targetCardInstanceId) send({
      type: "redirect-attack",
      cardInstanceId: button.dataset.card ?? "",
      targetPlayerId,
      targetCardInstanceId,
    });
  } else if (action === "pass-redirect") {
    send({ type: "pass-redirect" });
  } else if (action === "recover-litter") {
    const selected = root!.querySelector<HTMLInputElement>('input[name="litter-card"]:checked');
    if (selected) send({ type: "resolve-litter", recoverCardInstanceId: selected.value });
  } else if (action === "leave-litter") send({ type: "resolve-litter", recoverCardInstanceId: null });
  else if (action === "preaction") {
    const ability = button.dataset.ability;
    if (ability === "hyperactive") {
      const catInstanceId = fieldFromRoot("hyper-cat");
      const to = fieldFromRoot("hyper-to");
      if (catInstanceId && (to === "salon" || to === "sofa")) {
        send({ type: "activate-preaction", ability, movement: { playerId: account!.id, catInstanceId, to } });
      }
    } else if (ability === "triplets") {
      send({ type: "activate-preaction", ability, cards: checked("triplet-card") });
    } else if (ability === "curious" || ability === "scratcher") {
      const costId = fieldFromRoot("preaction-cost");
      if (costId) send({ type: "activate-preaction", ability, cards: [costId] });
    }
  }
});

root.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const preview = (event.target as HTMLElement).closest<HTMLImageElement>("img[data-card-preview]");
  if (!preview) return;
  event.preventDefault();
  event.stopPropagation();
  showCardPreview(preview.dataset.cardPreview ?? "");
});

discardUi.dialog.addEventListener("click", (event) => {
  const preview = (event.target as HTMLElement).closest<HTMLImageElement>("img[data-card-preview]");
  if (!preview) return;
  event.preventDefault();
  event.stopPropagation();
  showCardPreview(preview.dataset.cardPreview ?? "");
});

discardUi.dialog.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const preview = (event.target as HTMLElement).closest<HTMLImageElement>("img[data-card-preview]");
  if (!preview) return;
  event.preventDefault();
  event.stopPropagation();
  showCardPreview(preview.dataset.cardPreview ?? "");
});

render();
