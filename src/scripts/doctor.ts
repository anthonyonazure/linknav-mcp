#!/usr/bin/env node
// CLI: probe the people-search queryId and report rotation status.
// Safe with no cookies — reports that the detector is wired and waiting.

import { checkSearchQueryId } from "../linkedin/voyager.js";

async function main() {
  console.log("LinkNav doctor — search queryId health\n======================================");
  const report = await checkSearchQueryId(true);
  console.table({
    health: report.health,
    queryId: report.queryId,
    httpStatus: report.httpStatus ?? "n/a",
    sampleResults: report.sampleResults,
    autoHealedTo: report.autoHealedTo ?? "-",
  });
  console.log("\n" + report.hint);
  if (report.health !== "ok" && report.health !== "no_credentials") process.exitCode = 1;
}

// Top-level entry point: nothing can await it, so mark the rejection path
// explicitly rather than leaving an unhandled promise.
main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
