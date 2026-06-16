import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// Minimal .env loader (no dependency). Only sets vars not already in the env.
function loadDotEnv() {
  const envPath = join(projectRoot(), ".env");
  if (!existsSync(envPath)) return;
  for (const raw of readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export function projectRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

loadDotEnv();

const num = (v: string | undefined, dflt: number) => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : dflt;
};

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const config = {
  liAt: process.env.LINKNAV_LI_AT ?? "",
  jsessionid: (process.env.LINKNAV_JSESSIONID ?? "").replace(/^"|"$/g, ""),
  // Full browser cookie jar — required for the SSR people-search HTML endpoint,
  // which bounces a li_at-only request through the login wall. Some members are
  // short-lived (__cf_bm, lidc), so this needs refreshing more often than li_at.
  cookieJar: process.env.LINKNAV_COOKIE ?? "",
  userAgent: process.env.LINKNAV_USER_AGENT ?? DEFAULT_UA,
  dbPath: process.env.LINKNAV_DB_PATH ?? join(projectRoot(), "data", "linknav.db"),

  // People-search GraphQL queryId. LinkedIn rotates this. Override here without a
  // code edit; a DB-cached value (from auto-discovery) takes precedence over this.
  searchQueryId: process.env.LINKNAV_SEARCH_QUERY_ID ?? "",

  // Activity is SW-hydrated, so recency requires rendering the profile in a real
  // debuggable browser (CDP). Default on; auto-skips if no browser is reachable.
  useCdpActivity: (process.env.LINKNAV_USE_CDP_ACTIVITY ?? "true").toLowerCase() !== "false",

  caps: {
    profileViews: num(process.env.LINKNAV_CAP_PROFILE_VIEWS, 80),
    connects: num(process.env.LINKNAV_CAP_CONNECTS, 20),
    messages: num(process.env.LINKNAV_CAP_MESSAGES, 25),
    searches: num(process.env.LINKNAV_CAP_SEARCHES, 40),
  },

  delay: {
    minMs: num(process.env.LINKNAV_MIN_DELAY_MS, 3500),
    maxMs: num(process.env.LINKNAV_MAX_DELAY_MS, 12000),
  },
} as const;

export function hasCredentials(): boolean {
  return Boolean(config.liAt && config.jsessionid);
}

/** SSR people-search needs the full cookie jar, not just li_at + JSESSIONID. */
export function hasSearchCookie(): boolean {
  return Boolean(config.cookieJar && config.cookieJar.includes("li_at="));
}

/** Action kinds that count against rolling-24h caps. */
export type ActionKind = "profileView" | "connect" | "message" | "search";

export function capFor(kind: ActionKind): number {
  switch (kind) {
    case "profileView":
      return config.caps.profileViews;
    case "connect":
      return config.caps.connects;
    case "message":
      return config.caps.messages;
    case "search":
      return config.caps.searches;
  }
}
