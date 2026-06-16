import { config, capFor, type ActionKind } from "../config.js";
import { countActionsSince } from "../db.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export class CapExceededError extends Error {
  constructor(
    public kind: ActionKind,
    public used: number,
    public cap: number
  ) {
    super(
      `Daily cap reached for "${kind}": ${used}/${cap} in the last 24h. ` +
        `Refusing to continue — this is the ban-mitigation guardrail. ` +
        `Wait, or raise LINKNAV_CAP_${kind.toUpperCase()} in .env if you accept the risk.`
    );
    this.name = "CapExceededError";
  }
}

/** Throws CapExceededError if performing one more action of `kind` would exceed the rolling-24h cap. */
export function assertUnderCap(kind: ActionKind): void {
  const cap = capFor(kind);
  const used = countActionsSince(kind, DAY_MS);
  if (used >= cap) throw new CapExceededError(kind, used, cap);
}

/** Remaining budget for each action kind in the current rolling 24h window. */
export function remainingBudget(): Record<ActionKind, { used: number; cap: number; left: number }> {
  const kinds: ActionKind[] = ["profileView", "connect", "message", "search"];
  const out = {} as Record<ActionKind, { used: number; cap: number; left: number }>;
  for (const k of kinds) {
    const cap = capFor(k);
    const used = countActionsSince(k, DAY_MS);
    out[k] = { used, cap, left: Math.max(0, cap - used) };
  }
  return out;
}

/** Sleep a randomized human-like interval between actions. */
export function humanDelay(): Promise<void> {
  const { minMs, maxMs } = config.delay;
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  const ms = Math.floor(lo + Math.random() * (hi - lo));
  return new Promise((r) => setTimeout(r, ms));
}
