import { db, now, logAction } from "./db.js";
import { assertUnderCap, humanDelay } from "./linkedin/rateLimiter.js";
import { sendInvite, sendMessage } from "./linkedin/voyager.js";
import { getLead } from "./leads.js";

export type DraftType = "connect" | "message";

export interface Draft {
  id: number;
  lead_id: number;
  type: DraftType;
  text: string;
  rationale: string | null;
  status: string;
  campaign_id: number | null;
  step_index: number | null;
  created_at: number;
  sent_at: number | null;
  error: string | null;
}

export interface CreateDraftArgs {
  leadId: number;
  type: DraftType;
  text: string;
  rationale?: string;
  campaignId?: number;
  stepIndex?: number;
}

export function createDraft(args: CreateDraftArgs): Draft {
  const lead = getLead(args.leadId);
  if (!lead) throw new Error(`No lead ${args.leadId}`);
  if (args.type === "connect" && args.text.length > 300) {
    throw new Error("Connection notes are capped at 300 characters by LinkedIn.");
  }
  const info = db
    .prepare(
      `INSERT INTO drafts (lead_id, type, text, rationale, status, campaign_id, step_index, created_at)
       VALUES (?,?,?,?, 'pending', ?, ?, ?)`
    )
    .run(
      args.leadId,
      args.type,
      args.text,
      args.rationale ?? null,
      args.campaignId ?? null,
      args.stepIndex ?? null,
      now()
    );
  db.prepare("UPDATE leads SET status='drafted' WHERE id=? AND status='new'").run(args.leadId);
  return getDraft(Number(info.lastInsertRowid))!;
}

export function getDraft(id: number): Draft | undefined {
  return db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as Draft | undefined;
}

export function listDrafts(status = "pending", limit = 100): Array<Draft & { lead_name: string; profile_url: string }> {
  return db
    .prepare(
      `SELECT d.*, (l.first_name || ' ' || l.last_name) AS lead_name, l.profile_url
       FROM drafts d JOIN leads l ON l.id = d.lead_id
       WHERE d.status = ? ORDER BY d.id DESC LIMIT ?`
    )
    .all(status, limit) as Array<Draft & { lead_name: string; profile_url: string }>;
}

export function rejectDrafts(ids: number[]): number {
  const stmt = db.prepare("UPDATE drafts SET status='rejected', decided_at=? WHERE id=? AND status='pending'");
  let n = 0;
  for (const id of ids) n += stmt.run(now(), id).changes;
  return n;
}

export interface ApproveResult {
  id: number;
  ok: boolean;
  detail: string;
}

/**
 * The ONLY path that actually sends. Each draft is cap-checked and paced; a cap hit
 * stops the batch (remaining drafts stay pending for the next window).
 */
export async function approveDrafts(ids: number[]): Promise<ApproveResult[]> {
  const results: ApproveResult[] = [];
  for (const id of ids) {
    const d = getDraft(id);
    if (!d || d.status !== "pending") {
      results.push({ id, ok: false, detail: d ? `not pending (${d.status})` : "not found" });
      continue;
    }
    const lead = getLead(d.lead_id);
    if (!lead) {
      results.push({ id, ok: false, detail: "lead missing" });
      continue;
    }

    const kind = d.type === "connect" ? "connect" : "message";
    try {
      assertUnderCap(kind);
    } catch (e) {
      results.push({ id, ok: false, detail: (e as Error).message });
      break; // out of budget; leave the rest pending
    }

    try {
      await humanDelay();
      if (d.type === "connect") {
        await sendInvite(lead.urn, d.text);
        db.prepare("UPDATE leads SET status='contacted' WHERE id=?").run(lead.id);
      } else {
        await sendMessage(lead.urn, d.text);
        db.prepare("UPDATE leads SET status='contacted' WHERE id=?").run(lead.id);
      }
      db.prepare("UPDATE drafts SET status='sent', decided_at=?, sent_at=? WHERE id=?").run(
        now(),
        now(),
        id
      );
      logAction(kind, lead.id, `draft ${id} sent`);
      results.push({ id, ok: true, detail: `sent ${d.type} to ${lead.first_name}` });
    } catch (e) {
      const msg = (e as Error).message.slice(0, 200);
      db.prepare("UPDATE drafts SET status='failed', error=? WHERE id=?").run(msg, id);
      results.push({ id, ok: false, detail: msg });
    }
  }
  return results;
}
