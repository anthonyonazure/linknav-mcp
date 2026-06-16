import { config, hasCredentials } from "../config.js";
import { refreshCookiesFromBrowser } from "../refresh.js";

const VOYAGER_BASE = "https://www.linkedin.com/voyager/api";

/**
 * Run a request and, on an auth bounce or a transient network/redirect-loop error
 * (the signature of rotated cookies), pull fresh cookies from the live browser and
 * retry once. The thunk re-reads baseHeaders() each call, so the retry uses the
 * refreshed cookies.
 */
async function withCookieRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const msg = (e as Error)?.message ?? "";
    const auth = e instanceof LinkedInAuthError;
    const transient = /redirect count exceeded|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(msg);
    if (auth || transient) {
      const r = await refreshCookiesFromBrowser({ force: auth });
      if (r.ok) return await fn();
    }
    throw e;
  }
}

export class LinkedInAuthError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "LinkedInAuthError";
  }
}
export class LinkedInRateLimitError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "LinkedInRateLimitError";
  }
}

function requireCreds(): void {
  if (!hasCredentials()) {
    throw new LinkedInAuthError(
      "Missing credentials. Set LINKNAV_LI_AT and LINKNAV_JSESSIONID in .env " +
        "(see .env.example for how to copy them from your browser cookies)."
    );
  }
}

function baseHeaders(): Record<string, string> {
  // CSRF token = the JSESSIONID value. Prefer the value embedded in the full jar
  // so it can't drift from the cookies actually being sent.
  const jarJsess = config.cookieJar.match(/JSESSIONID=("?)([^;]+)\1/)?.[2];
  const csrf = (jarJsess ?? config.jsessionid).replace(/^"|"$/g, "");
  // The voyager API redirect-loops through the login wall when li_at + JSESSIONID
  // drift apart (LinkedIn rotates JSESSIONID). Sending the full browser jar when
  // available keeps the API as robust as the browser session itself.
  const cookie = config.cookieJar || `li_at=${config.liAt}; JSESSIONID="${csrf}"`;
  return {
    cookie,
    "csrf-token": csrf,
    "user-agent": config.userAgent,
    accept: "application/vnd.linkedin.normalized+json+2.1",
    "x-restli-protocol-version": "2.0.0",
    "x-li-lang": "en_US",
    "x-li-track":
      '{"clientVersion":"1.13.0","mpVersion":"1.13.0","osName":"web","timezoneOffset":0,"deviceFormFactor":"DESKTOP","mpName":"voyager-web"}',
    referer: "https://www.linkedin.com/feed/",
  };
}

async function handle(res: Response, label: string): Promise<any> {
  if (res.status === 401 || res.status === 403) {
    throw new LinkedInAuthError(
      `${label} → HTTP ${res.status}. Your li_at/JSESSIONID cookies are likely expired or invalid. ` +
        `Re-copy them from a fresh logged-in browser session into .env.`
    );
  }
  if (res.status === 429) {
    throw new LinkedInRateLimitError(
      `${label} → HTTP 429. LinkedIn is throttling you. Back off hard — lower your caps and wait.`
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${label} → HTTP ${res.status}. ${body.slice(0, 300)}`);
  }
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 1000) };
  }
}

export async function voyagerGet(path: string, query?: Record<string, string>): Promise<any> {
  requireCreds();
  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  const url = `${VOYAGER_BASE}${path}${qs}`;
  return withCookieRetry(async () =>
    handle(await fetch(url, { method: "GET", headers: baseHeaders() }), `GET ${path}`)
  );
}

export async function voyagerPost(path: string, body: unknown): Promise<any> {
  requireCreds();
  const url = `${VOYAGER_BASE}${path}`;
  return withCookieRetry(async () =>
    handle(
      await fetch(url, {
        method: "POST",
        headers: { ...baseHeaders(), "content-type": "application/json; charset=UTF-8" },
        body: JSON.stringify(body),
      }),
      `POST ${path}`
    )
  );
}

/**
 * Raw GraphQL call that does NOT throw on 4xx. Returns status + body so the caller
 * can classify a stale queryId (400) vs expired auth (401/403) vs real results.
 */
export async function voyagerGraphQLRaw(
  queryId: string,
  variables: string
): Promise<{ status: number; ok: boolean; text: string; json: any }> {
  requireCreds();
  const url = `${VOYAGER_BASE}/graphql?queryId=${encodeURIComponent(queryId)}&variables=${variables}`;
  const res = await fetch(url, { method: "GET", headers: baseHeaders() });
  const text = await res.text().catch(() => "");
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body (often an error/HTML page) */
  }
  return { status: res.status, ok: res.ok, text, json };
}

/** Authenticated GET that returns raw text (used to scrape the current queryId from the web app). */
export async function voyagerRawGet(absoluteUrl: string): Promise<{ status: number; text: string }> {
  requireCreds();
  const res = await fetch(absoluteUrl, { method: "GET", headers: baseHeaders() });
  const text = await res.text().catch(() => "");
  return { status: res.status, text };
}
