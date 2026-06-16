import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, setCookies, projectRoot } from "./config.js";
import { getAllLinkedInCookies, isCdpAvailable } from "./linkedin/activity-cdp.js";

let lastRefresh = 0;

/** Write the current cookie values back into .env so a restart keeps them. */
function persistToEnv(): void {
  const envPath = join(projectRoot(), ".env");
  const lines = existsSync(envPath) ? readFileSync(envPath, "utf8").split("\n") : [];
  const upsert = (key: string, value: string) => {
    const line = `${key}=${value}`;
    const i = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (i >= 0) lines[i] = line;
    else lines.push(line);
  };
  upsert("LINKNAV_LI_AT", config.liAt);
  upsert("LINKNAV_JSESSIONID", config.jsessionid);
  upsert("LINKNAV_COOKIE", config.cookieJar);
  writeFileSync(envPath, lines.join("\n"), { mode: 0o600 });
}

export interface RefreshResult {
  ok: boolean;
  reason?: string;
}

/**
 * Pull fresh LinkedIn cookies from the live browser and load them into the running
 * process (and .env). This is the automation that replaces hand-copying cookies.
 * A short min-interval prevents thrashing when several calls fail at once.
 */
export async function refreshCookiesFromBrowser(
  opts: { persist?: boolean; force?: boolean; minIntervalMs?: number } = {}
): Promise<RefreshResult> {
  const minInterval = opts.minIntervalMs ?? 4000;
  const nowMs = Date.now();
  if (!opts.force && nowMs - lastRefresh < minInterval) {
    return { ok: false, reason: "throttled (just refreshed)" };
  }
  if (!isCdpAvailable()) {
    return {
      ok: false,
      reason:
        "no debuggable browser found — start Edge/Chrome with remote debugging and stay logged into LinkedIn",
    };
  }
  let fresh: Awaited<ReturnType<typeof getAllLinkedInCookies>>;
  try {
    fresh = await getAllLinkedInCookies();
  } catch (e) {
    return { ok: false, reason: `browser read failed: ${(e as Error).message}` };
  }
  if (!fresh) return { ok: false, reason: "no LinkedIn cookies in the browser (not logged in?)" };

  setCookies(fresh);
  lastRefresh = Date.now();
  if (opts.persist !== false) {
    try {
      persistToEnv();
    } catch {
      /* non-fatal: in-memory refresh still took effect */
    }
  }
  return { ok: true };
}
