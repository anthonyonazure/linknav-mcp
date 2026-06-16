#!/usr/bin/env node
// Pull fresh LinkedIn cookies from the live logged-in browser into .env.
// Replaces hand-copying. Needs Edge/Chrome running with remote debugging and a
// logged-in LinkedIn session.

import { refreshCookiesFromBrowser } from "../refresh.js";
import { getMe } from "../linkedin/voyager.js";

async function main() {
  console.log("LinkNav cookie refresh\n======================");
  const r = await refreshCookiesFromBrowser({ force: true });
  if (!r.ok) {
    console.log("FAILED:", r.reason);
    console.log("\nMake sure Edge/Chrome is running with remote debugging");
    console.log("(chrome://inspect/#remote-debugging or edge://inspect) and logged into LinkedIn.");
    process.exitCode = 1;
    return;
  }
  console.log("Pulled fresh cookies from the browser and wrote them to .env.");
  try {
    const me = await getMe();
    console.log(`Verified against LinkedIn: ${me.firstName} ${me.lastName}`.trim());
  } catch (e) {
    console.log("Cookies loaded, but the identity check failed:", (e as Error).message);
  }
}

main();
