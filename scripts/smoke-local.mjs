import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "colyseus.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const httpPort = Number(process.env.TCIM_SMOKE_HTTP_PORT ?? 2868);
const gamePort = Number(process.env.TCIM_SMOKE_GAME_PORT ?? 2867);
const apiUrl = `http://127.0.0.1:${httpPort}`;
const gameUrl = `ws://127.0.0.1:${gamePort}`;
const output = [];
const child = spawn(process.execPath, [resolve(projectRoot, "build", "server", "index.js")], {
  cwd: projectRoot,
  env: { ...process.env, HTTP_PORT: String(httpPort), GAME_PORT: String(gamePort) },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.setEncoding("utf8").on("data", (chunk) => output.push(chunk));
child.stderr.setEncoding("utf8").on("data", (chunk) => output.push(chunk));

const rooms = [];
const gameRooms = [];
const publicStates = new Map();
const privateStates = new Map();
const lobbyStates = new Map();
const kickedNotices = new Set();
const roomErrors = [];
let revisions = new Map();
try {
  await waitForServer();
  const [first, second, third] = await Promise.all([login("gato1"), login("gato2"), login("gato3")]);
  await verifyThemePersistence(first);
  const client1 = new Client(gameUrl);
  const client2 = new Client(gameUrl);
  let room1 = await client1.create("game", { token: first.token, maxPlayers: 2, isPrivate: true });
  rooms.push(room1);
  registerRoom(room1);
  room1.send("refresh");
  await waitUntil(() => lobbyStates.has(room1.sessionId), "the private room lobby");
  const privateLobby = lobbyStates.get(room1.sessionId);
  const resolvedPrivateRoom = await resolveRoomCode(privateLobby.roomCode);
  if (resolvedPrivateRoom.roomId !== privateLobby.roomId) throw new Error("The private room code resolved to the wrong room.");
  const initialListings = await listRooms();
  if (initialListings.some((listedRoom) => listedRoom.roomId === privateLobby.roomId)) {
    throw new Error("The private room appeared in the public room list.");
  }

  let room2 = await client2.joinById(resolvedPrivateRoom.roomId, { token: second.token, code: privateLobby.roomCode });
  rooms.push(room2);
  registerRoom(room2);
  gameRooms.push(room1, room2);
  room1.send("refresh");
  room2.send("refresh");
  await waitUntil(
    () => lobbyStates.get(room1.sessionId)?.autoStartAt !== null,
    "the full-room start countdown",
  );
  room1.send("kick-player", { playerId: second.account.id });
  await waitUntil(
    () => kickedNotices.has(room2.sessionId) && lobbyStates.get(room1.sessionId)?.players.length === 1,
    "the creator to kick a player before starting",
  );
  if (lobbyStates.get(room1.sessionId)?.autoStartAt !== null) {
    throw new Error("The auto-start countdown did not cancel after the room stopped being full.");
  }

  const retryClient = new Client(gameUrl);
  room2 = await retryClient.joinById(resolvedPrivateRoom.roomId, { token: second.token, code: privateLobby.roomCode });
  rooms.push(room2);
  registerRoom(room2);
  gameRooms.splice(1, 1, room2);
  room1.send("refresh");
  room2.send("refresh");

  const publicClient = new Client(gameUrl);
  const publicRoom = await publicClient.create("game", { token: third.token, maxPlayers: 5, isPrivate: false });
  rooms.push(publicRoom);
  registerRoom(publicRoom);
  publicRoom.send("refresh");
  await waitUntil(() => lobbyStates.has(publicRoom.sessionId), "the public room lobby");
  const listedRooms = await listRooms();
  const publicLobby = lobbyStates.get(publicRoom.sessionId);
  if (!listedRooms.some((listedRoom) => listedRoom.roomId === publicLobby.roomId)) {
    throw new Error("The public room did not appear in the public room list.");
  }
  if (listedRooms.some((listedRoom) => listedRoom.roomId === privateLobby.roomId)) {
    throw new Error("The private room appeared in the public room list.");
  }

  await waitUntil(
    () => gameRooms.every((gameRoom) => publicStates.has(gameRoom.sessionId) && privateStates.has(gameRoom.sessionId)),
    "the full room to start automatically and both players to receive state",
  );

  let publicState = publicStates.get(room1.sessionId);
  if (publicState.players.length !== 2) throw new Error("The room did not start with two players.");
  for (const room of gameRooms) {
    const privateState = privateStates.get(room.sessionId);
    const serialized = JSON.stringify(publicStates.get(room.sessionId));
    for (const card of privateState.hand) {
      if (serialized.includes(card.instanceId)) throw new Error("A private hand card leaked into public state.");
    }
    for (const cat of privateState.initialPlacementCats) {
      if (serialized.includes(cat.instanceId)) throw new Error("An unplaced initial cat leaked into public state.");
    }
    if (privateState.initialPlacementCats.length > 0) {
      await sendAndWait(
        room,
        room.sessionId,
        {
          type: "choose-initial-cats",
          placements: privateState.initialPlacementCats.map((cat) => ({
            catInstanceId: cat.instanceId,
            to: "salon",
          })),
        },
        (state) => !state.initialPlacementPlayerIds.includes(privateState.playerId),
      );
    }
  }

  await waitUntil(
    () => publicStates.get(room1.sessionId)?.phase !== "initial_placement",
    "all players to choose their initial cat zones",
  );
  await resolvePendingCatPlacements();
  publicState = publicStates.get(room1.sessionId);
  const activePlayerId = publicState.currentPlayerId;
  const activeRoom = activePlayerId === first.account.id ? room1 : room2;
  const activeSessionId = activeRoom.sessionId;
  if (publicState.initialDrawChoicePlayerId) {
    await sendAndWait(activeRoom, activeSessionId, { type: "choose-initial-draw", useRaccoon: false }, (state) => state.phase === "action");
    await resolvePendingCatPlacements();
  }
  await sendAndWait(activeRoom, activeSessionId, { type: "skip-action-phase" }, (state) => state.phase === "movement");
  await sendAndWait(activeRoom, activeSessionId, { type: "finish-movement" }, (state) => state.currentPlayerId !== activePlayerId);
  await resolvePendingCatPlacements();
  if (roomErrors.length) throw new Error(`The game server rejected a smoke-test command: ${roomErrors.join("; ")}`);

  console.log("Smoke test passed: private codes stayed off the public list, public rooms were listed, creators could kick, full rooms auto-started, and two profiles advanced a turn safely.");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  throw new Error(`${message}\n${output.join("")}`);
} finally {
  await Promise.all(rooms.map((room) => Promise.race([room.leave(), delay(1500)])));
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await Promise.race([
      new Promise((resolveExit) => child.once("exit", resolveExit)),
      delay(5000),
    ]);
  }
}

function registerRoom(room) {
  room.onMessage("lobby", (state) => lobbyStates.set(room.sessionId, state));
  room.onMessage("presence", () => {});
  room.onMessage("public-state", (state) => {
    publicStates.set(room.sessionId, state);
    revisions.set(room.sessionId, (revisions.get(room.sessionId) ?? 0) + 1);
  });
  room.onMessage("private-state", (state) => privateStates.set(room.sessionId, state));
  room.onMessage("error", (message) => roomErrors.push(message));
  room.onMessage("room-kicked", () => kickedNotices.add(room.sessionId));
  room.onMessage("notice", () => {});
}

async function login(username) {
  const response = await fetch(`${apiUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "gato123" }),
  });
  const result = await response.json();
  if (!response.ok || !result.token || !result.account) {
    throw new Error(`Login failed for ${username}: ${result.error ?? response.statusText}`);
  }
  return result;
}

async function verifyThemePersistence(loginResult) {
  const originalTheme = loginResult.account.theme;
  const changedTheme = originalTheme === "dark" ? "light" : "dark";
  try {
    await updateTheme(loginResult.token, changedTheme);
    const refreshed = await login(loginResult.account.username);
    if (refreshed.account.theme !== changedTheme) {
      throw new Error("The selected theme was not persisted for the account.");
    }
  } finally {
    await updateTheme(loginResult.token, originalTheme);
  }
}

async function updateTheme(token, theme) {
  const response = await fetch(`${apiUrl}/api/preferences/theme`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, theme }),
  });
  const result = await response.json();
  if (!response.ok || result.theme !== theme) {
    throw new Error(`Could not save the test account theme: ${result.error ?? response.statusText}`);
  }
}

async function waitForServer() {
  await waitUntil(async () => {
    const response = await fetch(`${apiUrl}/api/health`);
    return response.ok;
  }, "the local HTTP server");
}

async function listRooms() {
  const response = await fetch(`${apiUrl}/api/rooms`);
  const result = await response.json();
  if (!response.ok || !Array.isArray(result.rooms)) {
    throw new Error(`Could not list public rooms: ${result.error ?? response.statusText}`);
  }
  return result.rooms;
}

async function resolveRoomCode(code) {
  const response = await fetch(`${apiUrl}/api/rooms/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  const result = await response.json();
  if (!response.ok || !result.roomId) {
    throw new Error(`Could not resolve the room code: ${result.error ?? response.statusText}`);
  }
  return result;
}

async function waitUntil(predicate, description) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The server exited before ${description}.\n${output.join("")}`);
    if (roomErrors.length) throw new Error(`The room rejected a command: ${roomErrors.join("; ")}`);
    try {
      if (await predicate()) return;
    } catch (error) {
      if (Date.now() + 250 >= deadline) throw error;
    }
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${description}.\n${output.join("")}`);
}

async function sendAndWait(room, sessionId, command, condition) {
  const previousRevision = revisions.get(sessionId) ?? 0;
  room.send("command", command);
  await waitUntil(
    () => (revisions.get(sessionId) ?? 0) > previousRevision &&
      condition(publicStates.get(sessionId), privateStates.get(sessionId)),
    `${command.type} to resolve`,
  );
}

async function resolvePendingCatPlacements() {
  for (const room of gameRooms) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const current = privateStates.get(room.sessionId);
      if (!current) break;
      if (current.pendingPrivateNotice) {
        const noticeId = current.pendingPrivateNotice.id;
        await sendAndWait(room, room.sessionId, { type: "acknowledge-private-notice" }, (_state, next) =>
          next?.pendingPrivateNotice?.id !== noticeId);
        continue;
      }
      if (current.pendingDrawNotice) {
        const notice = current.pendingDrawNotice;
        const cat = current.pendingCatPlacements.find((pending) => pending.instanceId === notice.card.instanceId);
        const command = cat
          ? {
            type: "choose-drawn-cats",
            placements: [{ catInstanceId: cat.instanceId, to: "salon" }],
          }
          : { type: "acknowledge-draw" };
        await sendAndWait(room, room.sessionId, command, (_state, next) =>
          next?.pendingDrawNotice?.card.instanceId !== notice.card.instanceId);
        continue;
      }
      if (current.pendingCatPlacements.length > 0) {
        const catIds = current.pendingCatPlacements.map((cat) => cat.instanceId);
        await sendAndWait(room, room.sessionId, {
          type: "choose-drawn-cats",
          placements: current.pendingCatPlacements.map((cat) => ({
            catInstanceId: cat.instanceId,
            to: "salon",
          })),
        }, (_state, next) =>
          !catIds.some((id) => next?.pendingCatPlacements.some((cat) => cat.instanceId === id)));
        continue;
      }
      break;
    }
  }
  await waitUntil(
    () => gameRooms.every((room) => publicStates.get(room.sessionId)?.pendingCatPlacementPlayerIds.length === 0),
    "all drawn cats to be placed",
  );
}
