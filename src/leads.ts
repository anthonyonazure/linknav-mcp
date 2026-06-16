import { db, now, logAction } from "./db.js";
import { config } from "./config.js";
import { assertUnderCap, humanDelay } from "./linkedin/rateLimiter.js";
import { searchPeople, type VoyagerProfile, type ActivityItem } from "./linkedin/voyager.js";
import { getProfileActivityCdp, isCdpAvailable } from "./linkedin/activity-cdp.js";

export interface Lead {
  id: number;
  urn: string;
  public_id: string;
  first_name: string;
  last_name: string;
  headline: string;
  location: string;
  company: string;
  title: string;
  profile_url: string;
  icp_tag: string | null;
  activity_json: string | null;
  activity_at: number | null;
  status: string;
}

function upsertLead(p: VoyagerProfile, icpTag: string): number {
  const existing = db.prepare("SELECT id FROM leads WHERE urn = ?").get(p.urn) as
    | { id: number }
    | undefined;
  if (existing) {
    db.prepare(
      "UPDATE leads SET headline=?, location=?, public_id=?, profile_url=?, icp_tag=COALESCE(icp_tag, ?) WHERE id=?"
    ).run(p.headline, p.location, p.publicId, p.profileUrl, icpTag, existing.id);
    return existing.id;
  }
  const info = db
    .prepare(
      `INSERT INTO leads (urn, public_id, first_name, last_name, headline, location, company, title, profile_url, icp_tag, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'new', ?)`
    )
    .run(
      p.urn,
      p.publicId,
      p.firstName,
      p.lastName,
      p.headline,
      p.location,
      p.company,
      p.title,
      p.profileUrl,
      icpTag,
      now()
    );
  return Number(info.lastInsertRowid);
}

export interface FindLeadsArgs {
  icp: string;
  keywords: string;
  recencyHours: number;
  limit: number;
}

/**
 * Search people for the ICP, then keep only those with activity inside recencyHours.
 * Each network action is cap-checked, paced, and logged. Returns stored leads.
 */
export async function findLeads(args: FindLeadsArgs): Promise<Lead[]> {
  const { icp, keywords, recencyHours, limit } = args;

  assertUnderCap("search");
  await humanDelay();
  const hits = await searchPeople(keywords, 0, Math.min(50, Math.max(limit, 10)));
  logAction("search", null, `icp="${icp}" kw="${keywords}" hits=${hits.length}`);

  const cutoff = now() - recencyHours * 60 * 60 * 1000;
  const kept: Lead[] = [];

  for (const p of hits) {
    if (kept.length >= limit) break;
    const leadId = upsertLead(p, icp);

    // Activity (for recency) is SW-hydrated, so it needs a rendered browser via CDP.
    // When CDP is on and reachable, render the profile and scrape posts (a profile
    // view — cap-checked). When it isn't, we can't recency-filter, so keep the lead.
    const useCdp = config.useCdpActivity && isCdpAvailable();
    let activity: ActivityItem[] = [];
    let activityError = false;
    if (useCdp) {
      try {
        assertUnderCap("profileView");
      } catch {
        break; // out of profile-view budget for today; return what we have
      }
      await humanDelay();
      try {
        activity = await getProfileActivityCdp(p.publicId, now());
        logAction("profileView", leadId, `cdp-activity=${activity.length}`);
      } catch (e) {
        activityError = true;
        logAction("profileView", leadId, `cdp-activity-error: ${(e as Error).message.slice(0, 120)}`);
      }
    } else {
      activityError = true; // no activity source → cannot filter by recency
      logAction("lead", leadId, "activity-unavailable (cdp off/unreachable)");
    }

    const mostRecent = activity
      .map((a) => a.postedAt ?? 0)
      .reduce((m, t) => Math.max(m, t), 0);
    const isRecent = mostRecent >= cutoff || (activity.length > 0 && mostRecent === 0);

    // If the activity endpoint is unavailable we can't filter by recency, so keep
    // the lead rather than silently dropping everyone. Recency filtering resumes
    // once getProfileActivity is repointed at the current endpoint.
    if (isRecent || activityError) {
      db.prepare("UPDATE leads SET activity_json=?, activity_at=? WHERE id=?").run(
        JSON.stringify(activity),
        mostRecent || now(),
        leadId
      );
      kept.push(getLead(leadId)!);
    }
  }
  return kept;
}

export function getLead(id: number): Lead | undefined {
  return db.prepare("SELECT * FROM leads WHERE id = ?").get(id) as Lead | undefined;
}

export function listLeads(status?: string, limit = 50): Lead[] {
  if (status) {
    return db
      .prepare("SELECT * FROM leads WHERE status = ? ORDER BY id DESC LIMIT ?")
      .all(status, limit) as Lead[];
  }
  return db.prepare("SELECT * FROM leads ORDER BY id DESC LIMIT ?").all(limit) as Lead[];
}

/** Recent activity for a stored lead, rendered via CDP (browser-assisted). */
export async function refreshActivity(leadId: number) {
  const lead = getLead(leadId);
  if (!lead) throw new Error(`No lead ${leadId}`);
  if (!config.useCdpActivity || !isCdpAvailable()) {
    throw new Error(
      "Activity needs a debuggable browser (CDP): the feed is Service-Worker hydrated and " +
        "isn't available to a headless fetch. Start Edge/Chrome with remote debugging, or set " +
        "LINKNAV_USE_CDP_ACTIVITY=true once it's reachable."
    );
  }
  assertUnderCap("profileView");
  await humanDelay();
  const activity = await getProfileActivityCdp(lead.public_id, now());
  logAction("profileView", leadId, `cdp refresh activity=${activity.length}`);
  db.prepare("UPDATE leads SET activity_json=? WHERE id=?").run(JSON.stringify(activity), leadId);
  return activity;
}
