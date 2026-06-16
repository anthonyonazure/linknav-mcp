// ── Voyager endpoint layer ────────────────────────────────────────────────
// These hit LinkedIn's PRIVATE internal API. They are undocumented and DO change.
// Everything brittle lives here on purpose: when LinkedIn shifts a shape, you patch
// this one file. Parsing is defensive so a layout change degrades instead of crashing.

import {
  voyagerGet,
  voyagerPost,
  voyagerGraphQLRaw,
  voyagerRawGet,
} from "./client.js";
import { config, hasCredentials, hasSearchCookie } from "../config.js";
import { getSetting, setSetting } from "../db.js";
import { searchPeopleSsr } from "./search-ssr.js";

// ── queryId rotation handling ─────────────────────────────────────────────
// LinkedIn versions the people-search queryId and rotates it without notice.
// A rotated id is the single most likely break. We resolve the id from
// (DB cache > env > built-in), detect rotation precisely, and best-effort
// auto-discover a fresh id from LinkedIn's own web bundle when authenticated.

const SETTING_QUERY_ID = "search_query_id";
const SETTING_QUERY_ID_CHECKED = "search_query_id_checked_at";

// Last id known to work at build time. Treated as a seed, not gospel.
const BUILTIN_SEARCH_QUERY_ID = "voyagerSearchDashClusters.<UPDATE_ME>";

export function resolveSearchQueryId(): string {
  const cached = getSetting(SETTING_QUERY_ID);
  if (cached) return cached;
  if (config.searchQueryId) return config.searchQueryId;
  return BUILTIN_SEARCH_QUERY_ID;
}

export function isConfiguredQueryId(id: string): boolean {
  return Boolean(id) && !id.includes("<") && !/UPDATE_ME/i.test(id);
}

export function setSearchQueryId(id: string): void {
  if (!isConfiguredQueryId(id)) {
    throw new Error(`Refusing to store a placeholder queryId: "${id}"`);
  }
  setSetting(SETTING_QUERY_ID, id.trim());
}

export class StaleQueryIdError extends Error {
  constructor(public queryId: string, public httpStatus: number) {
    super(
      `LinkedIn people-search queryId looks ROTATED (was "${queryId}", HTTP ${httpStatus}). ` +
        `Grab the current one from your browser: open linkedin.com, run a People search, ` +
        `in DevTools Network filter "graphql", copy the queryId starting "voyagerSearchDashClusters." ` +
        `from the request URL, then set it via the linknav_set_search_query_id tool (or ` +
        `LINKNAV_SEARCH_QUERY_ID in .env). Run linknav_doctor to confirm.`
    );
    this.name = "StaleQueryIdError";
  }
}

export type SearchHealth =
  | "ok"
  | "stale_query_id"
  | "auth_expired"
  | "unconfigured"
  | "empty"
  | "no_credentials"
  | "error";

/** Classify a raw search response. Pure function — unit-testable without a network. */
export function classifySearchResponse(
  status: number,
  body: string,
  parsedCount: number
): SearchHealth {
  if (status === 401 || status === 403) return "auth_expired";
  if (status === 400) {
    if (/queryId|query id|Failed to find|unrecognized|INVALID_ARGUMENT|not.*found/i.test(body)) {
      return "stale_query_id";
    }
    return "error";
  }
  if (status >= 200 && status < 300) {
    return parsedCount > 0 ? "ok" : "empty";
  }
  return "error";
}

function buildSearchVariables(keywords: string, start: number, count: number): string {
  return (
    `(start:${start},count:${count},origin:GLOBAL_SEARCH_HEADER,` +
    `query:(keywords:${encodeURIComponent(keywords)},` +
    `flagshipSearchIntent:SEARCH_SRP,` +
    `queryParameters:List((key:resultType,value:List(PEOPLE)))))`
  );
}

const QUERY_ID_RE = /voyagerSearchDashClusters\.[A-Za-z0-9_-]{6,}/g;

/**
 * Best-effort: scrape the current people-search queryId from LinkedIn's authenticated
 * web app. Needs valid cookies. Returns the freshest distinct id found, or null.
 */
export async function discoverQueryIdFromBundle(): Promise<string | null> {
  if (!hasCredentials()) return null;
  const pages = [
    "https://www.linkedin.com/search/results/people/?keywords=engineer",
  ];
  for (const url of pages) {
    try {
      const { status, text } = await voyagerRawGet(url);
      if (status !== 200 || !text) continue;
      const found = extractQueryIds(text);
      if (found.length) return found[found.length - 1]; // newest-looking match
    } catch {
      /* try next */
    }
  }
  return null;
}

/** Extract candidate search queryIds from a blob of HTML/JS. Pure, testable. */
export function extractQueryIds(text: string): string[] {
  const matches = text.match(QUERY_ID_RE) ?? [];
  return [...new Set(matches)];
}

export interface DoctorReport {
  health: SearchHealth;
  queryId: string;
  httpStatus: number | null;
  sampleResults: number;
  autoHealedTo?: string;
  hint: string;
}

/** Probe the current queryId with a benign search and report rotation status. */
export async function checkSearchQueryId(attemptHeal = true): Promise<DoctorReport> {
  if (!hasCredentials()) {
    return {
      health: "no_credentials",
      queryId: resolveSearchQueryId(),
      httpStatus: null,
      sampleResults: 0,
      hint: "Set cookies in .env, then re-run. The detector logic is wired and ready.",
    };
  }
  let queryId = resolveSearchQueryId();
  if (!isConfiguredQueryId(queryId)) {
    const healed = attemptHeal ? await discoverQueryIdFromBundle() : null;
    if (healed) {
      setSearchQueryId(healed);
      queryId = healed;
    } else {
      return {
        health: "unconfigured",
        queryId,
        httpStatus: null,
        sampleResults: 0,
        hint: "No queryId set yet. Provide one via linknav_set_search_query_id or .env, or let auto-discovery run with valid cookies.",
      };
    }
  }

  const probe = await voyagerGraphQLRaw(queryId, buildSearchVariables("engineer", 0, 5));
  const count = probe.json ? parsePeople(probe.json).length : 0;
  let health = classifySearchResponse(probe.status, probe.text, count);
  setSetting(SETTING_QUERY_ID_CHECKED, String(Date.now()));

  if (health === "stale_query_id" && attemptHeal) {
    const healed = await discoverQueryIdFromBundle();
    if (healed && healed !== queryId) {
      setSearchQueryId(healed);
      const retry = await voyagerGraphQLRaw(healed, buildSearchVariables("engineer", 0, 5));
      const retryCount = retry.json ? parsePeople(retry.json).length : 0;
      const retryHealth = classifySearchResponse(retry.status, retry.text, retryCount);
      return {
        health: retryHealth,
        queryId: healed,
        httpStatus: retry.status,
        sampleResults: retryCount,
        autoHealedTo: healed,
        hint:
          retryHealth === "ok"
            ? "Auto-healed: discovered and cached a fresh queryId. You're good."
            : "Auto-discovery found a new id but it still did not return results. Update manually via linknav_set_search_query_id.",
      };
    }
  }

  const hints: Record<SearchHealth, string> = {
    ok: "Search queryId is current. No action needed.",
    stale_query_id: "queryId rotated and auto-discovery could not recover it. Update manually via linknav_set_search_query_id.",
    auth_expired: "Cookies expired. Re-copy li_at + JSESSIONID into .env.",
    unconfigured: "No queryId configured.",
    empty: "queryId works but the probe returned 0 people (could be a transient/empty result). Re-run; if it persists, treat as stale.",
    no_credentials: "Set cookies in .env.",
    error: "Unexpected response. Check connectivity and your cookies.",
  };
  return { health, queryId, httpStatus: probe.status, sampleResults: count, hint: hints[health] };
}

export interface VoyagerProfile {
  urn: string; // fsd_profile / member entityUrn
  publicId: string; // vanity slug
  firstName: string;
  lastName: string;
  headline: string;
  location: string;
  company: string;
  title: string;
  profileUrl: string;
}

export interface ActivityItem {
  text: string;
  postedAt: number | null; // epoch ms if known
  url: string;
}

/** Current logged-in member. Cheapest call to validate the cookie works. */
export async function getMe(): Promise<{ urn: string; firstName: string; lastName: string }> {
  const data = await voyagerGet("/me");
  const mini =
    data?.included?.find((x: any) => x?.$type?.includes("MiniProfile")) ??
    data?.miniProfile ??
    {};
  return {
    urn: String(mini?.entityUrn ?? mini?.objectUrn ?? data?.plainId ?? ""),
    firstName: String(mini?.firstName ?? ""),
    lastName: String(mini?.lastName ?? ""),
  };
}

/**
 * People search. Primary path is the SSR results page (no queryId, nothing to
 * rotate) — that's what the modern logged-in web actually uses. The GraphQL
 * clusters path is kept as a fallback for if LinkedIn flips search back to a
 * client-fired queryId; it still resolves + auto-heals the queryId when used.
 */
export async function searchPeople(
  keywords: string,
  start = 0,
  count = 10
): Promise<VoyagerProfile[]> {
  // Preferred: SSR parse. Requires the full cookie jar.
  if (hasSearchCookie()) {
    const page = Math.floor(start / 10) + 1;
    const ssr = await searchPeopleSsr(keywords, page);
    if (ssr.length) return ssr.slice(0, count);
    // fall through to graphql only if SSR yielded nothing
  }

  let queryId = resolveSearchQueryId();

  // If we have nothing usable, try to discover one before making a doomed call.
  if (!isConfiguredQueryId(queryId)) {
    const healed = await discoverQueryIdFromBundle();
    if (healed) {
      setSearchQueryId(healed);
      queryId = healed;
    } else {
      throw new StaleQueryIdError(queryId, 0);
    }
  }

  const variables = buildSearchVariables(keywords, start, count);
  const res = await voyagerGraphQLRaw(queryId, variables);
  const parsedCount = res.json ? parsePeople(res.json).length : 0;
  const health = classifySearchResponse(res.status, res.text, parsedCount);

  if (health === "ok") return parsePeople(res.json);

  if (health === "stale_query_id") {
    // One auto-heal attempt: discover, cache, retry.
    const healed = await discoverQueryIdFromBundle();
    if (healed && healed !== queryId) {
      setSearchQueryId(healed);
      const retry = await voyagerGraphQLRaw(healed, variables);
      if (classifySearchResponse(retry.status, retry.text, retry.json ? parsePeople(retry.json).length : 0) === "ok") {
        return parsePeople(retry.json);
      }
    }
    throw new StaleQueryIdError(queryId, res.status);
  }

  if (health === "auth_expired") {
    throw new Error(
      `Search failed: HTTP ${res.status}. Cookies expired — re-copy li_at + JSESSIONID into .env.`
    );
  }
  // empty or error: return what we parsed (possibly nothing) rather than throw.
  return res.json ? parsePeople(res.json) : [];
}

function parsePeople(data: any): VoyagerProfile[] {
  const out: VoyagerProfile[] = [];
  const included: any[] = Array.isArray(data?.included) ? data.included : [];
  for (const node of included) {
    const t = String(node?.$type ?? "");
    if (!t.includes("EntityResultViewModel") && !t.includes("MiniProfile")) continue;
    const urn = String(node?.entityUrn ?? node?.targetUrn ?? "");
    if (!urn || !urn.includes("fsd_profile") && !urn.includes("member")) continue;
    const title = textOf(node?.title) || `${node?.firstName ?? ""} ${node?.lastName ?? ""}`.trim();
    const [firstName, ...rest] = title.split(" ");
    out.push({
      urn,
      publicId: String(node?.publicIdentifier ?? slugFromUrn(urn)),
      firstName: node?.firstName ?? firstName ?? "",
      lastName: node?.lastName ?? rest.join(" ") ?? "",
      headline: textOf(node?.primarySubtitle) || String(node?.occupation ?? node?.headline ?? ""),
      location: textOf(node?.secondarySubtitle) || "",
      company: "",
      title: "",
      profileUrl: profileUrlFromUrn(urn, String(node?.publicIdentifier ?? "")),
    });
  }
  return out;
}

/** Recent posts/activity for a profile, used to personalize the opener. */
export async function getProfileActivity(publicId: string, count = 5): Promise<ActivityItem[]> {
  const data = await voyagerGet(`/identity/profileUpdatesV2`, {
    profileId: publicId,
    q: "memberShareFeed",
    count: String(count),
    moduleKey: "member-shares:phone",
  });
  const items: ActivityItem[] = [];
  const included: any[] = Array.isArray(data?.included) ? data.included : [];
  for (const node of included) {
    const commentary =
      node?.commentary?.text?.text ?? node?.commentary?.text ?? node?.text?.text;
    if (typeof commentary === "string" && commentary.trim()) {
      items.push({
        text: commentary.trim(),
        postedAt: extractTimestamp(node),
        url: String(node?.permalink ?? node?.url ?? ""),
      });
    }
    if (items.length >= count) break;
  }
  return items;
}

/** Send a connection invitation with an optional custom note (<= 300 chars). */
export async function sendInvite(profileUrn: string, message?: string): Promise<void> {
  const inviteeUrn = profileUrn.startsWith("urn:") ? profileUrn : `urn:li:fsd_profile:${profileUrn}`;
  await voyagerPost("/growth/normInvitations", {
    invitee: { "com.linkedin.voyager.growth.invitation.InviteeProfile": { profileId: inviteeUrn } },
    ...(message ? { customMessage: message.slice(0, 300) } : {}),
    trackingId: pseudoTrackingId(),
  });
}

/** Send a direct message to an existing connection. */
export async function sendMessage(profileUrn: string, text: string): Promise<void> {
  const recipient = profileUrn.startsWith("urn:") ? profileUrn : `urn:li:fsd_profile:${profileUrn}`;
  await voyagerPost("/messaging/conversations?action=create", {
    keyVersion: "LEGACY_INBOX",
    conversationCreate: {
      eventCreate: {
        value: {
          "com.linkedin.voyager.messaging.create.MessageCreate": {
            body: text,
            attachments: [],
            attributedBody: { text, attributes: [] },
          },
        },
      },
      recipients: [recipient],
      subtype: "MEMBER_TO_MEMBER",
    },
  });
}

// ── helpers ───────────────────────────────────────────────────────────────
function textOf(v: any): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (typeof v?.text === "string") return v.text;
  if (typeof v?.text?.text === "string") return v.text.text;
  return "";
}
function slugFromUrn(urn: string): string {
  const m = urn.match(/:([^:]+)$/);
  return m ? m[1] : urn;
}
function profileUrlFromUrn(urn: string, publicId: string): string {
  if (publicId) return `https://www.linkedin.com/in/${publicId}/`;
  return `https://www.linkedin.com/in/${slugFromUrn(urn)}/`;
}
function extractTimestamp(node: any): number | null {
  const t = node?.createdAt ?? node?.publishedAt ?? node?.actor?.subDescription?.accessibilityText;
  const n = typeof t === "number" ? t : NaN;
  return Number.isFinite(n) ? n : null;
}
function pseudoTrackingId(): string {
  // 16-byte tracking id; value is cosmetic for our purposes.
  const bytes = Array.from({ length: 16 }, (_, i) => ((i * 53 + 17) % 256));
  return Buffer.from(bytes).toString("base64");
}
