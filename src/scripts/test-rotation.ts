#!/usr/bin/env node
// Cookie-free unit tests for the rotation detector. Proves the classification and
// queryId-extraction logic without any live LinkedIn call.

import { classifySearchResponse, extractQueryIds, isConfiguredQueryId } from "../linkedin/voyager.js";
import { parseSearchHtml } from "../linkedin/search-ssr.js";
import { parseRelativeTime } from "../linkedin/activity-cdp.js";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
  ok ? pass++ : fail++;
}

// ── classifySearchResponse ────────────────────────────────────────────────
check("rotated queryId -> stale_query_id",
  classifySearchResponse(400, '{"message":"Failed to find queryId voyagerSearchDashClusters.x"}', 0),
  "stale_query_id");

check("400 unrecognized arg -> stale_query_id",
  classifySearchResponse(400, "INVALID_ARGUMENT: unrecognized queryId", 0),
  "stale_query_id");

check("expired cookie 401 -> auth_expired",
  classifySearchResponse(401, "CSRF check failed", 0),
  "auth_expired");

check("403 -> auth_expired",
  classifySearchResponse(403, "forbidden", 0),
  "auth_expired");

check("200 with results -> ok",
  classifySearchResponse(200, "{...}", 7),
  "ok");

check("200 with zero results -> empty",
  classifySearchResponse(200, "{...}", 0),
  "empty");

check("400 unrelated -> error",
  classifySearchResponse(400, "some other bad request", 0),
  "error");

check("500 -> error",
  classifySearchResponse(500, "server error", 0),
  "error");

// ── extractQueryIds ───────────────────────────────────────────────────────
const sampleBundle = `
  ...spaCfg...,"queryId":"voyagerSearchDashClusters.abc123DEF456",...
  fallback voyagerSearchDashClusters.abc123DEF456 again, plus a newer
  "voyagerSearchDashClusters.zzz999-newHash_01" reference in another chunk.
`;
check("extracts unique queryIds from a bundle",
  extractQueryIds(sampleBundle),
  ["voyagerSearchDashClusters.abc123DEF456", "voyagerSearchDashClusters.zzz999-newHash_01"]);

check("no queryId in text -> empty list",
  extractQueryIds("nothing to see here"),
  []);

// ── isConfiguredQueryId ───────────────────────────────────────────────────
check("placeholder is not configured", isConfiguredQueryId("voyagerSearchDashClusters.<UPDATE_ME>"), false);
check("empty is not configured", isConfiguredQueryId(""), false);
check("real hash is configured", isConfiguredQueryId("voyagerSearchDashClusters.abc123DEF456"), true);

// ── parseSearchHtml (SSR) ─────────────────────────────────────────────────
// Mirrors the real markup: hashed classes, name in <strong> inside the /in/ anchor,
// plus a "mutual connection" decoy anchor that must be excluded.
const ssrFixture = `
<div class="_abc"><a class="_x" href="https://www.linkedin.com/in/jane-doe-123/"><strong>Jane Doe</strong></a>
  <span>2nd</span><p class="_y">VP Marketing at Acme</p></div>
<div class="_abc"><a class="_x" href="https://www.linkedin.com/in/john-smith/"><strong>John Smith</strong></a>
  <span>3rd+</span><p>Growth Lead</p></div>
<p><a href="https://www.linkedin.com/in/mutual-pal/"><strong>Mutual Pal</strong></a> is a mutual connection</p>
`;
const parsed = parseSearchHtml(ssrFixture);
check("SSR parse extracts the right number of people (excludes mutual)", parsed.length, 2);
check("SSR parse gets slug", parsed[0]?.publicId, "jane-doe-123");
check("SSR parse splits first/last name", [parsed[0]?.firstName, parsed[0]?.lastName], ["Jane", "Doe"]);
check("SSR parse builds profile url", parsed[1]?.profileUrl, "https://www.linkedin.com/in/john-smith/");
check("SSR parse excludes mutual-connection decoy", parsed.some(p => p.publicId === "mutual-pal"), false);

// ── parseRelativeTime (activity recency) ──────────────────────────────────
const T = 1_000_000_000_000; // fixed "now" for determinism
const DAY = 86_400_000;
check("relTime now -> now", parseRelativeTime("now", T), T);
check("relTime 30s -> now", parseRelativeTime("30s", T), T);
check("relTime 45m -> 45 min ago", parseRelativeTime("45m", T), T - 45 * 60_000);
check("relTime 3h -> 3 hours ago", parseRelativeTime("3h", T), T - 3 * 60 * 60_000);
check("relTime 6d -> 6 days ago", parseRelativeTime("6d", T), T - 6 * DAY);
check("relTime 1w -> 7 days ago", parseRelativeTime("1w", T), T - 7 * DAY);
check("relTime 2mo -> 60 days ago", parseRelativeTime("2mo", T), T - 60 * DAY);
check("relTime 1yr -> 365 days ago", parseRelativeTime("1yr", T), T - 365 * DAY);
check("relTime empty -> null", parseRelativeTime("", T), null);
check("relTime '2 days ago' -> 2 days ago", parseRelativeTime("2 days ago", T), T - 2 * DAY);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
