#!/usr/bin/env node
/**
 * LinkNav MCP Server
 *
 * ICP-driven LinkedIn lead-finding, activity-aware drafting, draft-review sending,
 * and campaign analytics, over LinkedIn's private Voyager API (cookie auth).
 *
 * Personal-use outreach automation. Against LinkedIn ToS; ban risk. The caps and
 * the draft-review gate are the safety model: nothing here auto-sends.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { hasCredentials } from "./config.js";
import { remainingBudget } from "./linkedin/rateLimiter.js";
import { getMe, checkSearchQueryId, setSearchQueryId, resolveSearchQueryId } from "./linkedin/voyager.js";
import { findLeads, listLeads, getLead, refreshActivity } from "./leads.js";
import { createDraft, listDrafts, approveDrafts, rejectDrafts } from "./drafts.js";
import {
  createCampaign,
  enroll,
  dueSteps,
  advanceMember,
  campaignStatus,
  analytics,
  getCampaignByName,
  type CampaignStep,
} from "./campaigns.js";

const server = new McpServer({ name: "linknav", version: "0.1.0" });

const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
const fail = (msg: string) => ({
  content: [{ type: "text" as const, text: msg }],
  isError: true,
});

// ── auth ────────────────────────────────────────────────────────────────
server.tool(
  "linknav_auth_status",
  "Verify the LinkedIn session cookie works and report identity plus remaining daily action budget. Run this first.",
  {},
  async () => {
    if (!hasCredentials()) {
      return fail(
        "No credentials. Set LINKNAV_LI_AT and LINKNAV_JSESSIONID in .env (see .env.example for how to copy them from your browser cookies), then retry."
      );
    }
    try {
      const me = await getMe();
      return text({ authenticated: true, me, remainingBudget: remainingBudget() });
    } catch (e) {
      return fail(`Auth check failed: ${(e as Error).message}`);
    }
  }
);

// ── health / queryId rotation ─────────────────────────────────────────────
server.tool(
  "linknav_doctor",
  "Probe the people-search queryId and report whether it has rotated. Distinguishes rotated id, expired cookies, and genuinely empty results. Attempts to auto-discover and cache a fresh queryId when possible. Run this if find_leads stops returning anyone.",
  {},
  async () => {
    try {
      return text(await checkSearchQueryId(true));
    } catch (e) {
      return fail((e as Error).message);
    }
  }
);

server.tool(
  "linknav_set_search_query_id",
  "Manually set the people-search queryId (persisted) when LinkedIn rotates it and auto-discovery can't recover it. Copy the value starting 'voyagerSearchDashClusters.' from a real People-search graphql request in DevTools.",
  { queryId: z.string().describe("e.g. voyagerSearchDashClusters.abc123...") },
  async ({ queryId }) => {
    try {
      setSearchQueryId(queryId);
      return text({ ok: true, queryId: resolveSearchQueryId(), note: "Stored. Run linknav_doctor to confirm." });
    } catch (e) {
      return fail((e as Error).message);
    }
  }
);

// ── find ────────────────────────────────────────────────────────────────
server.tool(
  "linknav_find_leads",
  "Search people for an ICP and keep only those active within recencyHours. Stores leads with their recent activity. Cap-checked, paced, logged.",
  {
    icp: z.string().describe("Plain-language ideal customer profile, used as a tag."),
    keywords: z.string().describe("Search keywords (titles, industry, tech, etc.)."),
    recencyHours: z.number().default(24).describe("Only keep leads active within this many hours."),
    limit: z.number().default(10).describe("Max leads to keep."),
  },
  async (a) => {
    try {
      const leads = await findLeads(a);
      return text({ kept: leads.length, leads });
    } catch (e) {
      return fail((e as Error).message);
    }
  }
);

server.tool(
  "linknav_get_activity",
  "Refresh and return a stored lead's recent posts/activity for personalization. Counts as a profile view.",
  { leadId: z.number() },
  async ({ leadId }) => {
    try {
      return text({ leadId, activity: await refreshActivity(leadId) });
    } catch (e) {
      return fail((e as Error).message);
    }
  }
);

server.tool(
  "linknav_list_leads",
  "List stored leads, optionally filtered by status (new|drafted|contacted|connected|replied|skipped).",
  { status: z.string().optional(), limit: z.number().default(50) },
  async ({ status, limit }) => text(listLeads(status, limit))
);

// ── draft + review ────────────────────────────────────────────────────────
server.tool(
  "linknav_draft_message",
  "Queue a draft (connect note or message) for a lead. DOES NOT SEND. Write the text yourself using the lead's activity; include a short rationale for the reviewer.",
  {
    leadId: z.number(),
    type: z.enum(["connect", "message"]),
    text: z.string().describe("The message. Connect notes are capped at 300 chars."),
    rationale: z.string().optional().describe("Why this opener, for your review."),
  },
  async (a) => {
    try {
      return text(createDraft({ leadId: a.leadId, type: a.type, text: a.text, rationale: a.rationale }));
    } catch (e) {
      return fail((e as Error).message);
    }
  }
);

server.tool(
  "linknav_list_drafts",
  "List drafts by status (default pending) for review before sending.",
  { status: z.string().default("pending"), limit: z.number().default(100) },
  async ({ status, limit }) => text(listDrafts(status, limit))
);

server.tool(
  "linknav_approve_drafts",
  "Approve drafts by id and ACTUALLY SEND them, subject to daily caps and human-paced delays. The only tool that sends. A cap hit stops the batch; remaining drafts stay pending.",
  { ids: z.array(z.number()).min(1) },
  async ({ ids }) => {
    const results = await approveDrafts(ids);
    return text({ results, sent: results.filter((r) => r.ok).length });
  }
);

server.tool(
  "linknav_reject_drafts",
  "Reject drafts by id so they are never sent.",
  { ids: z.array(z.number()).min(1) },
  async ({ ids }) => text({ rejected: rejectDrafts(ids) })
);

// ── campaigns ─────────────────────────────────────────────────────────────
server.tool(
  "linknav_enroll_campaign",
  "Create (or reuse) a named multi-step campaign and enroll leads. Steps: [{dayOffset,type,instruction}]. Follow-ups are drafted later by linknav_run_due_steps, never auto-sent.",
  {
    name: z.string(),
    icp: z.string().default(""),
    leadIds: z.array(z.number()).min(1),
    steps: z
      .array(
        z.object({
          dayOffset: z.number(),
          type: z.enum(["connect", "message"]),
          instruction: z.string(),
        })
      )
      .min(1),
  },
  async ({ name, icp, leadIds, steps }) => {
    try {
      const existing = getCampaignByName(name);
      const c = existing ?? createCampaign(name, icp, steps as CampaignStep[]);
      const enrolled = enroll(c.id, leadIds);
      return text({ campaign: c.name, enrolled });
    } catch (e) {
      return fail((e as Error).message);
    }
  }
);

server.tool(
  "linknav_run_due_steps",
  "Return campaign steps that are due now so you can draft them. Drafts only; nothing sends. Call linknav_draft_message for each, then advance via this tool's returned memberIds.",
  { limit: z.number().default(50) },
  async ({ limit }) => {
    const due = dueSteps(limit);
    for (const d of due) advanceMember(d.memberId); // advance scheduling; drafting is the caller's job
    return text({
      due,
      note: "Draft each with linknav_draft_message (use step.instruction + the lead's activity). Members already advanced to their next due date.",
    });
  }
);

server.tool(
  "linknav_campaign_status",
  "Show campaign membership counts and steps. Omit name for all campaigns.",
  { name: z.string().optional() },
  async ({ name }) => text(campaignStatus(name))
);

server.tool(
  "linknav_campaign_analytics",
  "Aggregate outreach analytics: sent counts, accept/reply rates, opener-length breakdown. Returns data; turn it into recommendations for the next round.",
  {},
  async () => text(analytics())
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("linknav MCP server running on stdio");
