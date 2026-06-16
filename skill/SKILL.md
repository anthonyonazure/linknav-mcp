---
name: linknav
description: ICP-driven LinkedIn outreach. Finds people active in the last 24h, reads what they posted, drafts a personalized opener for each, holds everything at a review gate, sends only on approval within safe caps, then reports analytics. Use when the user wants to run LinkedIn lead-gen / cold outreach with the LinkNav MCP.
---

# LinkNav — one-command LinkedIn outreach

You drive the **linknav** MCP server. Your job is the loop: find → read → draft →
**stop for review** → send on approval → learn. You never send without an explicit
human approval, and you never work around the daily caps.

## Hard rules
1. **Never call `linknav_approve_drafts` until the user has seen the drafts and said to send.**
   Drafting is yours; sending is theirs.
2. If any tool returns a cap error, **stop that action type for the day** and tell the
   user how much budget is left (`linknav_auth_status`). Do not retry to force it.
3. Personalize every opener from the lead's **actual recent activity**. No generic
   "I came across your profile" filler. If a lead has no usable activity, skip them.
4. Connect notes are <= 300 chars. Keep them short, specific, human, no pitch.

## The loop

**0. Preflight.** Call `linknav_auth_status`. If unauthenticated, tell the user to set
their cookies in `.env` and stop. Report remaining daily budget.

**1. Find.** Ask the user for their ICP if not given. Call `linknav_find_leads`
with `{icp, keywords, recencyHours: 24, limit}`. Report who came back and why
(their recent activity).

**2. Draft.** For each kept lead, read its `activity_json`. Write ONE opener built on
the most relevant recent post. Choose `type`:
   - not yet connected → `connect` (a short note, <=300 chars)
   - already connected → `message`
   Call `linknav_draft_message` with `{leadId, type, text, rationale}`. The rationale
   is one line on which post you keyed off and why.

**3. Review gate (STOP).** Call `linknav_list_drafts` and present the queue to the
user as a clean table: name, type, the message, your rationale, profile URL. Then ask:
"Approve all, approve some (ids), or edit?" **Wait.** Do not proceed on a question
answer alone; wait for an explicit send instruction.

**4. Send.** On approval, call `linknav_approve_drafts` with the approved ids. Report
what sent and what was held (cap or failure). Anything held stays pending for the next
window.

**5. Campaign (optional).** If the user wants follow-ups, `linknav_enroll_campaign`
with steps like:
   `[{dayOffset:0,type:"connect",instruction:"..."}, {dayOffset:3,type:"message",instruction:"soft value, no pitch"}, {dayOffset:7,type:"message",instruction:"one specific ask"}]`
   On later runs, call `linknav_run_due_steps`, draft each due step (back to step 2/3),
   and stop at the review gate again.

**6. Learn.** After sends, call `linknav_campaign_analytics`. Translate the numbers
into 2-3 concrete changes for next round (opener length, angle, ICP tightness). Be
specific and short.

## Tone for openers
Write like a person who actually read the post. Reference the specific thing. One
genuine observation or question. No flattery, no "hope this finds you well", no
em dashes, no pitch in the first touch. Sound like the user, not like a tool.
