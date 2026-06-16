import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS leads (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  urn           TEXT UNIQUE,                 -- LinkedIn entityUrn (fsd_profile / member urn)
  public_id     TEXT,                        -- vanity slug, e.g. "jane-doe-123"
  first_name    TEXT,
  last_name     TEXT,
  headline      TEXT,
  location      TEXT,
  company       TEXT,
  title         TEXT,
  profile_url   TEXT,
  icp_tag       TEXT,                        -- which ICP search surfaced this lead
  activity_json TEXT,                        -- JSON array of recent posts/comments
  activity_at   INTEGER,                     -- epoch ms of most recent detected activity
  source        TEXT DEFAULT 'search',
  status        TEXT DEFAULT 'new',          -- new | drafted | contacted | connected | replied | skipped
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS drafts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id      INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,                -- connect | message
  text         TEXT NOT NULL,
  rationale    TEXT,                         -- why Claude wrote it this way (for your review)
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | sent | failed
  campaign_id  INTEGER REFERENCES campaigns(id) ON DELETE SET NULL,
  step_index   INTEGER,
  created_at   INTEGER NOT NULL,
  decided_at   INTEGER,
  sent_at      INTEGER,
  error        TEXT
);

CREATE TABLE IF NOT EXISTS campaigns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT UNIQUE NOT NULL,
  icp         TEXT,
  steps_json  TEXT NOT NULL,                 -- JSON array of {dayOffset, type, instruction}
  status      TEXT NOT NULL DEFAULT 'active',-- active | paused | done
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_members (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id  INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id      INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  current_step INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'active', -- active | done | stopped | replied
  enrolled_at  INTEGER NOT NULL,
  next_due_at  INTEGER,                       -- epoch ms when the next step should be drafted
  UNIQUE(campaign_id, lead_id)
);

CREATE TABLE IF NOT EXISTS action_log (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  kind     TEXT NOT NULL,                     -- profileView | connect | message | search
  lead_id  INTEGER,
  detail   TEXT,
  ts       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_leads_status     ON leads(status);
CREATE INDEX IF NOT EXISTS idx_drafts_status    ON drafts(status);
CREATE INDEX IF NOT EXISTS idx_actionlog_kindts ON action_log(kind, ts);
CREATE INDEX IF NOT EXISTS idx_members_due      ON campaign_members(status, next_due_at);
`);

export function now(): number {
  // Date.now is fine in the running server; scripts/tests pass timestamps explicitly.
  return Date.now();
}

/** Record an action for rate-limit accounting + analytics. */
export function logAction(kind: string, leadId: number | null, detail?: string): void {
  db.prepare(
    "INSERT INTO action_log (kind, lead_id, detail, ts) VALUES (?, ?, ?, ?)"
  ).run(kind, leadId, detail ?? null, now());
}

export function getSetting(key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).run(key, value, now());
}

/** Count actions of a kind within the trailing window (ms). */
export function countActionsSince(kind: string, windowMs: number): number {
  const since = now() - windowMs;
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM action_log WHERE kind = ? AND ts >= ?")
    .get(kind, since) as { n: number };
  return row.n;
}
