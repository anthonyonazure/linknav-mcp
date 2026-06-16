// ── SSR people-search ─────────────────────────────────────────────────────
// Modern logged-in LinkedIn people-search is server-rendered: the web UI does
// NOT fire a `voyagerSearchDashClusters` graphql call (it 0-fires; pagination is
// full document loads, and the live API routes through a Service Worker). So
// instead of chasing a rotating graphql queryId, we fetch the authenticated SSR
// results HTML and parse it. No queryId, nothing to rotate.
//
// This needs the FULL cookie jar (config.cookieJar): a li_at-only request gets
// bounced through the login wall in an infinite redirect. The class names in the
// markup are hashed/obfuscated, so we anchor parsing on the stable profile-link
// pattern and derive name from the <strong> inside the anchor; headline/location
// are best-effort from the surrounding card text.

import { config, hasSearchCookie } from "../config.js";
import type { VoyagerProfile } from "./voyager.js";

const SEARCH_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// ── cookie jar helpers (manual redirect needs Set-Cookie persistence) ───────
function parseCookieHeader(header: string): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) jar.set(name, value);
  }
  return jar;
}
function serializeJar(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function mergeSetCookies(jar: Map<string, string>, setCookies: string[]): void {
  for (const sc of setCookies) {
    const first = sc.split(";")[0];
    const eq = first.indexOf("=");
    if (eq < 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (name) jar.set(name, value); // newest value wins
  }
}

export class SearchCookieError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SearchCookieError";
  }
}

interface AnchorHit {
  slug: string;
  name: string;
  start: number;
  end: number; // index just past the matched name, where clean card text begins
}

const ANCHOR_RE =
  /href="https:\/\/www\.linkedin\.com\/in\/([A-Za-z0-9_%-]+)\/?"[^>]*>(?:<!--[^>]*-->)?(?:<strong>)?([^<]{2,80})/g;

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ") // complete tags
    .replace(/<[^>]*$/g, " ") // dangling open tag at a slice boundary (no closing >)
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Strip leading degree badge + bullets, then take the headline up to the next
// bullet/location/action-button boundary. Best-effort — the source has no JSON
// for this, so it's a heuristic on the bullet-delimited card text.
const ACTION_WORDS = /\b(Connect|Message|Follow|View profile|Save|Pending|Invite)\b.*$/i;
export function deriveHeadline(cardText: string): string {
  let t = cardText.replace(/^[\s•·]*/, "");
  t = t.replace(/^(1st|2nd|3rd\+?)\b[\s•·]*/i, ""); // drop degree badge
  // Cut at the card chrome that follows the role line.
  t = t.split(
    /\s+Current:|\s+\d[\d,]*\+?\s+followers|\s+and\s+\d+\s+other|\s+mutual connection|\s+shared connection/i
  )[0];
  t = t.replace(/<.*$/, ""); // any residual markup tail
  const seg = t.split(/\s[•·]\s/)[0] ?? t;
  return seg.replace(ACTION_WORDS, "").replace(/[\s,]+$/, "").slice(0, 150).trim();
}

/** Parse the SSR search HTML into lightweight profiles. Pure + unit-testable. */
export function parseSearchHtml(html: string): VoyagerProfile[] {
  const hits: AnchorHit[] = [];
  let m: RegExpExecArray | null;
  ANCHOR_RE.lastIndex = 0;
  while ((m = ANCHOR_RE.exec(html))) {
    hits.push({
      slug: m[1].replace(/\/$/, ""),
      name: stripTags(m[2]),
      start: m.index,
      end: ANCHOR_RE.lastIndex, // just past the name — clean card text starts here
    });
  }

  const out: VoyagerProfile[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    if (!h.slug || seen.has(h.slug)) continue;
    if (!h.name) continue;
    // Card text starts AFTER the name (h.end) so the leading `href="..."` fragment
    // of the matched anchor isn't included (stripTags can't clean a half-open tag).
    const next = hits[i + 1]?.start ?? Math.min(h.end + 1400, html.length);
    const cardText = stripTags(html.slice(h.end, next));
    // Exclude "X is a mutual/shared connection" decoy anchors.
    if (/^\s*(?:<\/a>)?\s*is a (mutual|shared) connection/i.test(cardText) ||
        /is a (mutual|shared) connection/i.test(cardText.slice(0, 60))) {
      continue;
    }
    const headline = deriveHeadline(cardText);

    seen.add(h.slug);
    const [firstName, ...rest] = h.name.split(" ");
    out.push({
      urn: `urn:li:fsd_profile:${h.slug}`, // slug-based; resolved to a real urn on profile fetch
      publicId: h.slug,
      firstName: firstName ?? h.name,
      lastName: rest.join(" "),
      headline,
      location: "",
      company: "",
      title: "",
      profileUrl: `https://www.linkedin.com/in/${h.slug}/`,
    });
  }
  return out;
}

/** Fetch + parse one page of SSR people-search results. page is 1-based. */
export async function searchPeopleSsr(keywords: string, page = 1): Promise<VoyagerProfile[]> {
  if (!hasSearchCookie()) {
    throw new SearchCookieError(
      "SSR search needs the full cookie jar. Set LINKNAV_COOKIE in .env to your complete " +
        "linkedin.com cookie string (li_at alone gets bounced through the login wall)."
    );
  }
  // Encode space as %20 (not +) to avoid LinkedIn's query-normalization redirect.
  const kw = encodeURIComponent(keywords);
  let url =
    `https://www.linkedin.com/search/results/people/?keywords=${kw}&origin=GLOBAL_SEARCH_HEADER` +
    (page > 1 ? `&page=${page}` : "");

  const baseHeaders = {
    "user-agent": config.userAgent || SEARCH_UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "upgrade-insecure-requests": "1",
  };

  // LinkedIn's anti-bot flow 302s to the SAME url while issuing a fresh cookie via
  // Set-Cookie that must be echoed on the next request (the browser does this
  // automatically). We maintain a mutable cookie map and merge Set-Cookie across
  // hops, otherwise it loops forever resending the stale jar.
  const jar = parseCookieHeader(config.cookieJar);
  let html = "";
  for (let hop = 0; hop < 8; hop++) {
    const res = await fetch(url, {
      redirect: "manual",
      headers: { ...baseHeaders, cookie: serializeJar(jar) },
    });
    mergeSetCookies(jar, res.headers.getSetCookie?.() ?? []);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location") ?? "";
      if (/login|authwall|uas|checkpoint/i.test(loc)) {
        throw new SearchCookieError(
          "Search bounced to the login wall — your cookie jar is stale or incomplete. " +
            "Refresh LINKNAV_COOKIE from a logged-in browser session."
        );
      }
      const nextUrl = loc.startsWith("http") ? loc : `https://www.linkedin.com${loc}`;
      // Never re-send the session cookie jar to a non-LinkedIn host. If a redirect
      // points off-site (e.g. an open-redirect), bail rather than leak credentials.
      let host = "";
      try { host = new URL(nextUrl).hostname; } catch { /* malformed */ }
      if (!/(^|\.)linkedin\.com$/i.test(host)) {
        throw new SearchCookieError(
          `Search redirected off LinkedIn (to "${host}"). Refusing to forward your session ` +
            `cookies to a non-LinkedIn host.`
        );
      }
      url = nextUrl;
      continue;
    }
    if (!res.ok) throw new Error(`Search HTTP ${res.status}`);
    html = await res.text();
    break;
  }
  if (!html) throw new Error("Search did not resolve to a page within the redirect budget.");
  if (/uas\/login|authwall/i.test(html.slice(0, 2000)) && !/search\/results/i.test(html.slice(0, 4000))) {
    throw new SearchCookieError("Search landed on the login wall. Refresh LINKNAV_COOKIE.");
  }
  return parseSearchHtml(html);
}
