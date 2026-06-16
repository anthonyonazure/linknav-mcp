// ── Browser-assisted activity scrape (CDP) ────────────────────────────────
// A profile's recent activity is NOT server-rendered — it hydrates client-side
// via a Service Worker, so a headless fetch returns an empty shell. To get posts
// + timestamps we render the recent-activity page in the user's real logged-in
// Edge/Chrome (remote-debugging) and scrape the hydrated DOM.
//
// This is the one place LinkNav depends on a live browser. It is OPTIONAL: when
// no debuggable browser is reachable, callers fall back (find_leads keeps the
// lead without recency filtering). Enable/disable via LINKNAV_USE_CDP_ACTIVITY.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ActivityItem } from "./voyager.js";

const PORT_FILES = [
  "Library/Application Support/Google/Chrome/DevToolsActivePort",
  "Library/Application Support/Microsoft Edge/DevToolsActivePort",
  "Library/Application Support/BraveSoftware/Brave-Browser/DevToolsActivePort",
  "Library/Application Support/Chromium/DevToolsActivePort",
].map((p) => join(homedir(), p));

function browserWsUrl(): string | null {
  for (const f of PORT_FILES) {
    if (!existsSync(f)) continue;
    const [port, path] = readFileSync(f, "utf8").trim().split("\n");
    if (port && path) return `ws://127.0.0.1:${port}${path}`;
  }
  return null;
}

export function isCdpAvailable(): boolean {
  return browserWsUrl() !== null;
}

/**
 * Pull the current linkedin.com cookies from the live logged-in browser. This is how
 * we auto-refresh when LinkedIn rotates the session, with no hand-copying. Returns
 * null if no debuggable browser is reachable or no LinkedIn cookies are present.
 */
export async function getAllLinkedInCookies(): Promise<
  { jar: string; liAt: string; jsessionid: string } | null
> {
  if (!isCdpAvailable()) return null;
  const cdp = await Cdp.connect();
  try {
    const r = await cdp.send("Storage.getCookies"); // browser-level: all cookies
    const cookies: any[] = (r.result?.cookies ?? []).filter((c: any) =>
      /(^|\.)linkedin\.com$/.test(c.domain)
    );
    if (!cookies.length) return null;
    const jar = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const liAt = cookies.find((c) => c.name === "li_at")?.value ?? "";
    const jsessionid = (cookies.find((c) => c.name === "JSESSIONID")?.value ?? "").replace(/^"|"$/g, "");
    if (!liAt) return null; // not logged in
    return { jar, liAt, jsessionid };
  } finally {
    cdp.close();
  }
}

/** Parse a LinkedIn relative time label ("6d", "1w", "3h", "45m", "2mo", "now") to epoch ms. */
export function parseRelativeTime(label: string, nowMs: number): number | null {
  const s = (label || "").trim().toLowerCase();
  if (!s) return null;
  if (/^now\b|^just now/.test(s)) return nowMs;
  // Accept both LinkedIn's short form ("6d", "1w", "2mo") and full words ("2 days ago").
  const m = s.match(
    /(\d+)\s*(mo|months?|yr|years?|y|weeks?|w|days?|d|hours?|h|minutes?|min|m|seconds?|sec|s)\b/
  );
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2];
  const MIN = 60_000, HR = 60 * MIN, DAY = 24 * HR;
  let unit: "s" | "m" | "h" | "d" | "w" | "mo" | "y";
  if (/^mo|^month/.test(u)) unit = "mo";
  else if (/^yr|^year|^y$/.test(u)) unit = "y";
  else if (/^w/.test(u)) unit = "w";
  else if (/^d/.test(u)) unit = "d";
  else if (/^h/.test(u)) unit = "h";
  else if (/^min|^minute|^m$/.test(u)) unit = "m";
  else unit = "s";
  if (unit === "s") return nowMs; // seconds ago ≈ now
  const mult: Record<string, number> = {
    m: MIN, h: HR, d: DAY, w: 7 * DAY, mo: 30 * DAY, y: 365 * DAY,
  };
  return nowMs - n * mult[unit];
}

// Minimal CDP client over the browser websocket (flattened sessions). Edge/Chrome
// block direct /devtools/page ws by origin, but the browser endpoint + attach works.
class Cdp {
  private ws: WebSocket;
  private id = 1;
  private pending = new Map<number, (v: any) => void>();
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (e: any) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        this.pending.get(m.id)!(m);
        this.pending.delete(m.id);
      }
    });
  }
  static async connect(): Promise<Cdp> {
    const url = browserWsUrl();
    if (!url) throw new Error("No debuggable browser (DevToolsActivePort) found.");
    const ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("Could not connect to the browser CDP endpoint."));
    });
    return new Cdp(ws);
  }
  send(method: string, params: any = {}, sessionId?: string): Promise<any> {
    return new Promise((res) => {
      const id = this.id++;
      this.pending.set(id, res);
      const msg: any = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }
  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SCRAPE_EXPR = `(() => {
  const nodes = [...document.querySelectorAll('[data-urn*="urn:li:activity"]')];
  const out = []; const seen = new Set();
  for (const el of nodes) {
    const urn = el.getAttribute('data-urn'); if (seen.has(urn)) continue; seen.add(urn);
    const t = (el.innerText || '').replace(/\\s+/g, ' ').trim();
    const tm = t.match(/\\b\\d+\\s*(?:second|minute|hour|day|week|month|year)s?\\b|\\b\\d+\\s*(?:mo|yr|[smhdwy])\\b|\\bnow\\b/i);
    out.push({ time: tm ? tm[0] : '', text: t.slice(0, 400) });
    if (out.length >= 8) break;
  }
  return JSON.stringify(out);
})()`;

/**
 * Scrape a profile's recent activity via the live browser. Returns posts with
 * absolute timestamps derived from the relative labels. Throws if no browser is
 * reachable or the page never hydrates — callers decide how to degrade.
 */
export async function getProfileActivityCdp(
  slug: string,
  nowMs: number,
  opts: { hydrateMs?: number; maxWaitMs?: number } = {}
): Promise<ActivityItem[]> {
  const hydrateMs = opts.hydrateMs ?? 1500;
  const maxWaitMs = opts.maxWaitMs ?? 12000;
  const cdp = await Cdp.connect();
  let targetId: string | undefined;
  try {
    const created = await cdp.send("Target.createTarget", {
      url: `https://www.linkedin.com/in/${encodeURIComponent(slug)}/recent-activity/all/`,
    });
    targetId = created.result?.targetId;
    if (!targetId) throw new Error("Failed to open activity tab.");
    const att = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = att.result?.sessionId;
    if (!sessionId) throw new Error("Failed to attach to activity tab.");
    await cdp.send("Runtime.enable", {}, sessionId);

    // Poll until the feed hydrates (activity nodes appear) or we time out.
    let raw = "[]";
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await sleep(hydrateMs);
      const r = await cdp.send(
        "Runtime.evaluate",
        { expression: SCRAPE_EXPR, returnByValue: true, awaitPromise: true },
        sessionId
      );
      raw = r.result?.result?.value ?? "[]";
      try {
        if (JSON.parse(raw).length > 0) break;
      } catch { /* keep waiting */ }
    }

    const items: Array<{ time: string; text: string }> = JSON.parse(raw);
    return items.map((it) => ({
      text: it.text,
      postedAt: parseRelativeTime(it.time, nowMs),
      url: "",
    }));
  } finally {
    if (targetId) await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    cdp.close();
  }
}
