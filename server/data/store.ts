import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";

export interface Account {
  id: string;
  username: string;
  elo: number;
  gamesPlayed: number;
  theme: ThemeMode;
}

export type ThemeMode = "light" | "dark";

interface AccountRow extends Account {
  password_hash: string;
  salt: string;
}

const databasePath = resolve(process.cwd(), "server", "data", "game.sqlite");
mkdirSync(dirname(databasePath), { recursive: true });

const database = new Database(databasePath);
database.pragma("journal_mode = WAL");
database.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    elo INTEGER NOT NULL DEFAULT 1000,
    games_played INTEGER NOT NULL DEFAULT 0,
    theme TEXT NOT NULL DEFAULT 'light'
  );
  CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    played_at TEXT NOT NULL,
    winner_id TEXT NOT NULL,
    player_ids_json TEXT NOT NULL
  );
`);
const accountColumns = database.pragma("table_info(accounts)") as Array<{ name: string }>;
if (!accountColumns.some((column) => column.name === "theme")) {
  database.exec("ALTER TABLE accounts ADD COLUMN theme TEXT NOT NULL DEFAULT 'light'");
}

const testAccounts = ["gato1", "gato2", "gato3", "gato4", "gato5"];
const seedAccount = database.prepare(`
  INSERT OR IGNORE INTO accounts (id, username, password_hash, salt)
  VALUES (?, ?, ?, ?)
`);
for (const username of testAccounts) {
  const salt = randomBytes(16).toString("hex");
  seedAccount.run(randomUUID(), username, hashPassword("gato123", salt), salt);
}

const sessions = new Map<string, { accountId: string; expiresAt: number }>();

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64).toString("hex");
}

function publicAccount(row: Pick<AccountRow, "id" | "username" | "elo" | "gamesPlayed" | "theme">): Account {
  return {
    id: row.id,
    username: row.username,
    elo: row.elo,
    gamesPlayed: row.gamesPlayed,
    theme: row.theme,
  };
}

function queryAccount(username: string): AccountRow | undefined {
  return database
    .prepare(`
      SELECT id, username, password_hash, salt, elo, games_played AS gamesPlayed, theme
      FROM accounts WHERE username = ?
    `)
    .get(username) as AccountRow | undefined;
}

export function listTestAccounts(): Array<Pick<Account, "username" | "elo" | "gamesPlayed">> {
  return database
    .prepare("SELECT username, elo, games_played AS gamesPlayed FROM accounts ORDER BY username")
    .all() as Array<Pick<Account, "username" | "elo" | "gamesPlayed">>;
}

export function authenticate(username: unknown, password: unknown): { token: string; account: Account } | null {
  if (typeof username !== "string" || typeof password !== "string") return null;
  const row = queryAccount(username.trim().toLowerCase());
  if (!row) return null;

  const expected = Buffer.from(row.password_hash, "hex");
  const actual = Buffer.from(hashPassword(password, row.salt), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

  const token = randomBytes(32).toString("hex");
  sessions.set(token, { accountId: row.id, expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
  return { token, account: publicAccount(row) };
}

export function accountForToken(token: unknown): Account | null {
  if (typeof token !== "string") return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  const row = database
    .prepare(`
      SELECT id, username, elo, games_played AS gamesPlayed, theme
      FROM accounts WHERE id = ?
    `)
    .get(session.accountId) as Pick<AccountRow, "id" | "username" | "elo" | "gamesPlayed" | "theme"> | undefined;
  return row ? publicAccount(row) : null;
}

export function updateAccountTheme(accountId: string, theme: ThemeMode): void {
  database.prepare("UPDATE accounts SET theme = ? WHERE id = ?").run(theme, accountId);
}

export function recordMatch(winnerId: string, playerIds: string[]): void {
  const uniquePlayerIds = [...new Set(playerIds)];
  if (uniquePlayerIds.length < 2 || !uniquePlayerIds.includes(winnerId)) {
    throw new Error("Cannot record a match without a valid winner and at least two players.");
  }
  const placeholders = uniquePlayerIds.map(() => "?").join(",");
  const players = database
    .prepare(`SELECT id, elo FROM accounts WHERE id IN (${placeholders})`)
    .all(...uniquePlayerIds) as Array<{ id: string; elo: number }>;
  if (players.length !== uniquePlayerIds.length) throw new Error("A match references an unknown account.");

  const ratings = new Map(players.map((player) => [player.id, player.elo]));
  const winnerRating = ratings.get(winnerId);
  if (winnerRating === undefined) throw new Error("Winner account is missing.");
  const opponents = players.filter((player) => player.id !== winnerId);
  const expectedScore =
    opponents.reduce((sum, opponent) => sum + 1 / (1 + 10 ** ((opponent.elo - winnerRating) / 400)), 0) /
    opponents.length;
  const winnerDelta = Math.round(32 * (1 - expectedScore));

  const updateRating = database.prepare(`
    UPDATE accounts SET elo = ?, games_played = games_played + 1 WHERE id = ?
  `);
  const insertMatch = database.prepare(`
    INSERT INTO matches (id, played_at, winner_id, player_ids_json) VALUES (?, ?, ?, ?)
  `);
  const transaction = database.transaction(() => {
    updateRating.run(winnerRating + winnerDelta, winnerId);
    for (const opponent of opponents) {
      const expected = 1 / (1 + 10 ** ((winnerRating - opponent.elo) / 400));
      updateRating.run(opponent.elo + Math.round(32 * (0 - expected)), opponent.id);
    }
    insertMatch.run(randomUUID(), new Date().toISOString(), winnerId, JSON.stringify(uniquePlayerIds));
  });
  transaction();
}

export function listRecentMatches(limit = 20): Array<{
  id: string;
  playedAt: string;
  winnerName: string;
  playerNames: string[];
}> {
  const rows = database
    .prepare(`
      SELECT matches.id, matches.played_at AS playedAt, winner.username AS winnerName,
             matches.player_ids_json AS playerIdsJson
      FROM matches
      JOIN accounts AS winner ON winner.id = matches.winner_id
      ORDER BY matches.played_at DESC
      LIMIT ?
    `)
    .all(Math.max(1, Math.min(100, Math.floor(limit)))) as Array<{
    id: string;
    playedAt: string;
    winnerName: string;
    playerIdsJson: string;
  }>;
  return rows.map((row) => {
    const ids = JSON.parse(row.playerIdsJson) as string[];
    const placeholders = ids.map(() => "?").join(",");
    const players = database
      .prepare(`SELECT username FROM accounts WHERE id IN (${placeholders})`)
      .all(...ids) as Array<{ username: string }>;
    return { id: row.id, playedAt: row.playedAt, winnerName: row.winnerName, playerNames: players.map((player) => player.username) };
  });
}
