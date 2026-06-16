import { db, now } from "./db.js";

export interface CampaignStep {
  dayOffset: number; // days after enrollment (or after prior step) this fires
  type: "connect" | "message";
  instruction: string; // guidance Claude uses to draft this step
}

export interface Campaign {
  id: number;
  name: string;
  icp: string | null;
  steps_json: string;
  status: string;
  created_at: number;
}

export function createCampaign(name: string, icp: string, steps: CampaignStep[]): Campaign {
  if (!steps.length) throw new Error("A campaign needs at least one step.");
  const info = db
    .prepare(
      "INSERT INTO campaigns (name, icp, steps_json, status, created_at) VALUES (?,?,?, 'active', ?)"
    )
    .run(name, icp, JSON.stringify(steps), now());
  return getCampaign(Number(info.lastInsertRowid))!;
}

export function getCampaign(id: number): Campaign | undefined {
  return db.prepare("SELECT * FROM campaigns WHERE id = ?").get(id) as Campaign | undefined;
}

export function getCampaignByName(name: string): Campaign | undefined {
  return db.prepare("SELECT * FROM campaigns WHERE name = ?").get(name) as Campaign | undefined;
}

export function enroll(campaignId: number, leadIds: number[]): number {
  const c = getCampaign(campaignId);
  if (!c) throw new Error(`No campaign ${campaignId}`);
  const steps = JSON.parse(c.steps_json) as CampaignStep[];
  const firstDue = now() + (steps[0]?.dayOffset ?? 0) * 86400000;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO campaign_members (campaign_id, lead_id, current_step, status, enrolled_at, next_due_at)
     VALUES (?,?,0,'active',?,?)`
  );
  let n = 0;
  for (const lid of leadIds) n += stmt.run(campaignId, lid, now(), firstDue).changes;
  return n;
}

export interface DueStep {
  memberId: number;
  campaignId: number;
  leadId: number;
  stepIndex: number;
  step: CampaignStep;
}

/** Members whose next step is due now. The caller drafts (never auto-sends) these. */
export function dueSteps(limit = 50): DueStep[] {
  const rows = db
    .prepare(
      `SELECT m.id AS memberId, m.campaign_id, m.lead_id, m.current_step, c.steps_json
       FROM campaign_members m JOIN campaigns c ON c.id = m.campaign_id
       WHERE m.status='active' AND c.status='active' AND m.next_due_at <= ?
       ORDER BY m.next_due_at ASC LIMIT ?`
    )
    .all(now(), limit) as any[];

  const out: DueStep[] = [];
  for (const r of rows) {
    const steps = JSON.parse(r.steps_json) as CampaignStep[];
    const step = steps[r.current_step];
    if (!step) {
      db.prepare("UPDATE campaign_members SET status='done' WHERE id=?").run(r.memberId);
      continue;
    }
    out.push({
      memberId: r.memberId,
      campaignId: r.campaign_id,
      leadId: r.lead_id,
      stepIndex: r.current_step,
      step,
    });
  }
  return out;
}

/** Advance a member after its current step has been drafted/queued. */
export function advanceMember(memberId: number): void {
  const m = db
    .prepare(
      `SELECT m.*, c.steps_json FROM campaign_members m JOIN campaigns c ON c.id=m.campaign_id WHERE m.id=?`
    )
    .get(memberId) as any;
  if (!m) return;
  const steps = JSON.parse(m.steps_json) as CampaignStep[];
  const nextIndex = m.current_step + 1;
  if (nextIndex >= steps.length) {
    db.prepare("UPDATE campaign_members SET current_step=?, status='done' WHERE id=?").run(
      nextIndex,
      memberId
    );
    return;
  }
  const nextDue = now() + (steps[nextIndex].dayOffset ?? 1) * 86400000;
  db.prepare(
    "UPDATE campaign_members SET current_step=?, next_due_at=? WHERE id=?"
  ).run(nextIndex, nextDue, memberId);
}

export function campaignStatus(name?: string) {
  const campaigns = name
    ? [getCampaignByName(name)].filter(Boolean)
    : (db.prepare("SELECT * FROM campaigns ORDER BY id DESC").all() as Campaign[]);
  return (campaigns as Campaign[]).map((c) => {
    const counts = db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM campaign_members WHERE campaign_id=? GROUP BY status`
      )
      .all(c.id) as Array<{ status: string; n: number }>;
    return {
      id: c.id,
      name: c.name,
      status: c.status,
      steps: JSON.parse(c.steps_json),
      members: counts.reduce((acc, r) => ((acc[r.status] = r.n), acc), {} as Record<string, number>),
    };
  });
}

/** Aggregate analytics across all sends, returned as data Claude turns into advice. */
export function analytics() {
  const sent = db
    .prepare("SELECT type, COUNT(*) AS n FROM drafts WHERE status='sent' GROUP BY type")
    .all() as Array<{ type: string; n: number }>;
  const contacted = (db.prepare("SELECT COUNT(*) AS n FROM leads WHERE status IN ('contacted','connected','replied')").get() as any).n;
  const connected = (db.prepare("SELECT COUNT(*) AS n FROM leads WHERE status IN ('connected','replied')").get() as any).n;
  const replied = (db.prepare("SELECT COUNT(*) AS n FROM leads WHERE status='replied'").get() as any).n;
  const byOpenerLen = db
    .prepare(
      `SELECT CASE WHEN LENGTH(text) < 120 THEN 'short' WHEN LENGTH(text) < 240 THEN 'medium' ELSE 'long' END AS bucket,
              COUNT(*) AS sent
       FROM drafts WHERE status='sent' GROUP BY bucket`
    )
    .all() as Array<{ bucket: string; sent: number }>;

  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
  return {
    sentByType: sent,
    totals: { contacted, connected, replied },
    rates: {
      acceptRatePct: pct(connected, contacted),
      replyRatePct: pct(replied, contacted),
    },
    openerLengthBreakdown: byOpenerLen,
    note: "Update lead.status to 'connected'/'replied' as outcomes land so these rates stay real.",
  };
}
