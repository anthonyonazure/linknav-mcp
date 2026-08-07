// ── Safe readers for untrusted JSON ───────────────────────────────────────
// Everything LinkedIn hands back (Voyager, GraphQL, the CDP bridge) is an
// undocumented shape that changes without notice. Asserting a static interface
// over it would be a lie the compiler then trusts, so these helpers read one
// property at a time off `unknown` and fall back instead of throwing. A layout
// change degrades to an empty string / missing field rather than a crash.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Walk a property path, returning undefined the moment the path stops existing. */
export function prop(value: unknown, ...path: string[]): unknown {
  let cur = value;
  for (const key of path) {
    if (!isRecord(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** A string property, or "" when absent or of another type. */
export function str(value: unknown, ...path: string[]): string {
  const v = prop(value, ...path);
  return typeof v === "string" ? v : "";
}

/**
 * A string-or-number property rendered as a string, or "". Voyager is
 * inconsistent about whether ids come back quoted, so both are accepted.
 */
export function scalar(value: unknown, ...path: string[]): string {
  const v = prop(value, ...path);
  if (typeof v === "string") return v;
  return typeof v === "number" ? String(v) : "";
}

/** A finite number property, or null. */
export function num(value: unknown, ...path: string[]): number | null {
  const v = prop(value, ...path);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** An array property, or [] when absent or of another type. */
export function arr(value: unknown, ...path: string[]): unknown[] {
  const v = prop(value, ...path);
  return Array.isArray(v) ? v : [];
}
