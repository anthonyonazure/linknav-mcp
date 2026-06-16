# LinkNav MCP

A Claude [MCP](https://modelcontextprotocol.io) server for honest, rate-limited LinkedIn lead generation.

Give it your ICP. It finds people who posted recently, reads what they posted, drafts a personalized opener for each, holds everything at a review gate, and sends only on your approval inside safe daily caps. Then it reports analytics so you can tune the next round.

One command, one loop: **find → read → draft → review → send → learn.**

> Built in the open as the honest version of every "delete Sales Navigator, automate LinkedIn with AI" thread. Those threads sell a frictionless fantasy and hide the part where you get banned. This one tells you exactly how it works, and the safety rails are the actual product.

---

## The honest truth (read this first)

There is **no official, compliant LinkedIn API** for searching arbitrary leads by activity and sending connection requests or DMs. Anyone selling "no scraping, fully compliant automation" is misleading you.

LinkNav works two ways, both using **your own logged-in session**:

- **Search** is a headless fetch of LinkedIn's authenticated server-rendered results page, parsed directly.
- **Activity** (the "active in the last N hours" signal) is scraped from your **real browser** over CDP, because that data hydrates client-side and isn't in the headless HTML.

This is for **your own account doing your own outreach**. It **violates LinkedIn's Terms of Service** and carries **real account-suspension risk** if you push volume. The mitigations below are not optional decoration, they are the reason the tool exists in this shape:

- **Conservative rolling-24h caps**, refused (not queued) when hit.
- **Human-paced random delays** between every action.
- **Draft-review by default.** Nothing auto-sends. Drafts queue, and only an explicit approval sends, still subject to the caps.

Start tiny. 10 to 20 connects a day for the first week. Do not be greedy.

---

## Features

- **ICP-driven search** that returns real people from your live network, no list buying, no Sales Navigator.
- **Activity-aware drafting.** Openers are built on what a lead actually posted, not generic "I came across your profile" filler.
- **A hard review gate.** You see every draft before anything leaves your account.
- **Multi-step campaigns** with scheduled follow-ups that are drafted (never auto-sent) when due.
- **Analytics** on accept and reply rates plus opener-style breakdown, fed back as concrete changes for the next round.
- **Self-defending against LinkedIn changes.** A queryId-rotation detector and a one-call fix path for when LinkedIn shifts its internals.

## How it works

The bundled Claude skill ([`skill/SKILL.md`](skill/SKILL.md)) runs the loop:

1. **Find.** `find_leads` searches your ICP and keeps only people active within `recencyHours`.
2. **Read.** It pulls each lead's recent posts for personalization.
3. **Draft.** Claude writes one opener per lead, keyed to a specific post, and queues it.
4. **Review gate.** It shows you the queue and stops. Nothing sends without your word.
5. **Send.** On approval, it sends inside the daily caps with human pacing.
6. **Learn.** After sends, it reads analytics and tells you what to change.

## Architecture, and why it is shaped this way

Modern logged-in LinkedIn does not work the way the old unofficial libraries assume. Two findings drove the design:

| Concern | What LinkedIn actually does | What LinkNav does |
| --- | --- | --- |
| **People search** | Server-rendered. The web UI never fires the `voyagerSearchDashClusters` graphql call the old libs depend on; pagination is full document loads and the live API hides behind a Service Worker. | Fetches and parses the authenticated SSR results page ([`search-ssr.ts`](src/linkedin/search-ssr.ts)). No queryId, nothing to rotate. |
| **Profile activity** | Not server-rendered. The feed hydrates client-side via a Service Worker, and the old `profileUpdatesV2` REST endpoint is deprecated (302). A headless fetch gets an empty shell. | Renders the profile's recent-activity page in your real logged-in browser over CDP and scrapes the hydrated feed ([`activity-cdp.ts`](src/linkedin/activity-cdp.ts)), converting relative timestamps to absolute. |

A `queryId`-rotation detector (`linknav_doctor`) and a `linknav_set_search_query_id` fix path remain as a safety net for any graphql endpoint, and flip on automatically if LinkedIn moves search back to a client-fired query.

## Quickstart

```bash
git clone https://github.com/anthonyonazure/linknav-mcp.git
cd linknav-mcp
npm install
cp .env.example .env     # see Cookies below — mostly automatic
npm run cookies          # pull fresh cookies from your logged-in browser into .env
npm run auth             # smoke test: prints your identity + remaining budget
npm run doctor           # checks search health / queryId rotation
npm test                 # unit tests (no network, no cookies needed)
npm start                # run the MCP server on stdio
```

### Cookies (mostly automatic)

Search needs your **full** linkedin.com cookie string, not just two cookies (a `li_at`-only request bounces through the login wall forever). LinkedIn also rotates session cookies every few minutes.

You do **not** hand-copy cookies. As long as you have a debuggable browser open and logged into LinkedIn (see below), LinkNav pulls the current cookies straight from it:

- **Automatic self-heal:** when search or the API detects stale cookies (a 302 redirect loop or an auth bounce), it pulls fresh cookies from your browser and retries, transparently.
- **One command:** `npm run cookies` grabs them on demand and writes them to `.env`.
- **From Claude:** the `linknav_refresh_cookies` tool does the same mid-workflow.

Manual fallback (only if you run headless with no browser): copy the entire `cookie` header from a logged-in `linkedin.com` request (DevTools → Network → Request Headers) into `LINKNAV_COOKIE`, plus `LINKNAV_LI_AT` and `LINKNAV_JSESSIONID` from the same jar.

### Browser for activity (optional but recommended)

Recency filtering needs a debuggable browser. Start Edge or Chrome with remote debugging enabled (`chrome://inspect/#remote-debugging` or `edge://inspect`) and stay logged into LinkedIn. Controlled by `LINKNAV_USE_CDP_ACTIVITY` (default `true`). If no debuggable browser is reachable, `find_leads` skips recency filtering and keeps all matches rather than returning zero.

### Register with Claude

```jsonc
{
  "mcpServers": {
    "linknav": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/linknav-mcp/src/mcp-server.ts"]
    }
  }
}
```

Then add `skill/SKILL.md` to your Claude skills and run it.

## Usage

You drive it in plain language through Claude. The skill runs the **find → draft → review → send → learn** loop and always stops for your approval before anything is sent.

### Find and draft

> "Find 10 marketing directors at B2B SaaS companies who posted in the last 24 hours, and draft a connection note for each based on what they actually posted."

Claude searches your ICP, keeps only recently-active people, reads each one's recent posts, writes a personalized opener, and shows you the queue. Nothing has sent yet.

### Review and send (the gate)

> "Show me the drafts."

…you read them…

> "Send 1, 3, and 5. Reject the rest."

Only the approved drafts send, within your daily caps and with human-paced delays. Anything held by a cap stays pending for the next window.

### Tune the targeting or the voice

> "Only keep people based in the US, and rewrite the openers shorter and less salesy, no pitch in the first touch."

### Run a multi-step campaign

> "Enroll the rest in a 3-step sequence: connect today, a soft value message on day 3, one specific ask on day 7."

Then, on a later day:

> "Draft any campaign follow-ups that are due."

It drafts the due steps and stops at the review gate again. It never auto-sends a follow-up.

### See what is working

> "How are my campaigns doing, and what should I change next round?"

Claude reads your accept and reply rates plus the opener-length breakdown and gives you concrete tweaks.

### Housekeeping (rarely needed)

> "Refresh my LinkedIn cookies."  (also happens automatically when they go stale)

> "Run a health check on search."  → `linknav_doctor`

> "What's my remaining daily budget?"  → `linknav_auth_status`

These prompts map to the tools below. You can also call any tool directly if you prefer.

## Tools

| Tool | What it does |
| --- | --- |
| `linknav_auth_status` | Verify cookies, return identity plus remaining daily budget |
| `linknav_refresh_cookies` | Pull fresh cookies from your live logged-in browser (also happens automatically on staleness) |
| `linknav_doctor` | Probe search health and detect a rotated queryId; auto-heals when it can |
| `linknav_set_search_query_id` | Manually set a fresh queryId when auto-discovery cannot |
| `linknav_find_leads` | Search an ICP, keep only leads active within `recencyHours` |
| `linknav_get_activity` | Render and scrape a lead's recent posts (CDP) |
| `linknav_list_leads` | List stored leads by status |
| `linknav_draft_message` | Queue a connect note or message (never sends) |
| `linknav_list_drafts` | Review the pending queue |
| `linknav_approve_drafts` | The only tool that sends; capped, paced, logged |
| `linknav_reject_drafts` | Discard drafts |
| `linknav_enroll_campaign` | Create a multi-step follow-up sequence and enroll leads |
| `linknav_run_due_steps` | Surface due follow-ups to draft (not send) |
| `linknav_campaign_status` | Membership and step status |
| `linknav_campaign_analytics` | Accept and reply rates plus opener-length breakdown |

## Safety caps

Rolling-24h ceilings, refused (not queued) when hit. Override in `.env`.

| Action | Default per 24h |
| --- | --- |
| Profile views | 80 |
| Connection requests | 20 |
| Messages | 25 |
| Searches | 40 |

## Maintenance

LinkedIn changes its internals without notice. The brittle parts live in [`search-ssr.ts`](src/linkedin/search-ssr.ts), [`activity-cdp.ts`](src/linkedin/activity-cdp.ts), and [`voyager.ts`](src/linkedin/voyager.ts).

- **Search returns a 302 loop or nothing:** stale cookies. It self-heals from your browser automatically; if no browser is reachable, run `npm run cookies` or set `LINKNAV_COOKIE`.
- **`auth_status` fails with 401/403:** the API auto-refreshes from your browser; otherwise run `npm run cookies`.
- **`find_leads` returns people but no recency filtering:** no debuggable browser was reachable. Start one, or set `LINKNAV_USE_CDP_ACTIVITY=true`.
- **Search empty after a LinkedIn change:** run `linknav_doctor`.

## Tech

TypeScript, ESM, Node 22+. [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk), `better-sqlite3`, `zod`. Run with `tsx`. No build step.

## Disclaimer

For personal use on your own LinkedIn account. This tool violates LinkedIn's Terms of Service and may get your account restricted or banned. You are solely responsible for how you use it and for complying with LinkedIn's terms and applicable law. Provided as-is, no warranty. Not affiliated with or endorsed by LinkedIn.

## License

ISC. See [LICENSE](LICENSE).
