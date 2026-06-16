#!/usr/bin/env node
// Standalone auth/credential smoke test. Safe to run with no cookies: it reports
// missing credentials instead of throwing, so it doubles as a "does it wire up" check.

import { hasCredentials } from "../config.js";
import { remainingBudget } from "../linkedin/rateLimiter.js";
import { getMe } from "../linkedin/voyager.js";

async function main() {
  console.log("LinkNav auth check\n==================");
  if (!hasCredentials()) {
    console.log("credentials : MISSING (set LINKNAV_LI_AT + LINKNAV_JSESSIONID in .env)");
    console.log("db wiring   : OK (caps + storage initialized)");
    console.log("\nremaining 24h budget:");
    console.table(remainingBudget());
    console.log("\nResult: wiring OK, no live LinkedIn call made (no cookies).");
    return;
  }
  try {
    const me = await getMe();
    console.log("credentials : PRESENT");
    console.log("identity    :", JSON.stringify(me));
    console.log("\nremaining 24h budget:");
    console.table(remainingBudget());
    console.log("\nResult: authenticated against LinkedIn Voyager.");
  } catch (e) {
    console.log("credentials : PRESENT but call FAILED");
    console.log("error       :", (e as Error).message);
    process.exitCode = 1;
  }
}

main();
