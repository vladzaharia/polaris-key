#!/usr/bin/env node
/**
 * Deploy preflight. Fails the deploy while a required secret is not set on the target
 * environment or an origin var in wrangler.toml is not an absolute https URL. Reads NAMES only:
 * `wrangler secret list` output on stdin (JSON), never a value. Strength (length) is enforced at
 * runtime by src/core/configGuard.ts.
 *
 *   wrangler secret list --env prod | node scripts/check-config.mjs prod
 */
import { readFileSync } from "node:fs";

const REQUIRED = [
  "KEY_HASH_PEPPER",
  "ADMIN_SESSION_SECRET",
  "PORTAL_SESSION_SECRET",
  "PLATFORM_KEK",
];
const ORIGINS = ["BLOB_ORIGIN", "PKG_ORIGIN", "IMG_ORIGIN"];

/** Pure: returns the list of problems. */
export function check(env, secretNames, toml) {
  const problems = [];
  const have = new Set(secretNames);
  for (const n of REQUIRED)
    if (!have.has(n)) {
      // The keyring replaces PLATFORM_KEK.
      if (n === "PLATFORM_KEK" && have.has("PLATFORM_KEK_KEYS")) continue;
      problems.push(`secret ${n} is not set`);
    }
  const m = toml.match(
    new RegExp(`\\[env\\.${env}\\.vars\\]([\\s\\S]*?)(?=\\n\\[|$)`),
  );
  const vars = m ? m[1] : "";
  for (const n of ORIGINS) {
    const v = vars.match(new RegExp(`^${n}\\s*=\\s*"([^"]*)"`, "m"));
    if (!v || v[1] === "") continue;
    let ok = false;
    try {
      const u = new URL(v[1]);
      ok = u.protocol === "https:" && u.hostname !== "";
    } catch {}
    if (!ok) problems.push(`${n} is not an absolute https URL`);
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.argv[2];
  const parsed = JSON.parse(readFileSync(0, "utf8"));
  const names = parsed.map((s) => s.name);
  const problems = check(env, names, readFileSync("wrangler.toml", "utf8"));
  if (problems.length) {
    for (const p of problems) console.error(`config check: ${p}`);
    process.exit(1);
  }
  console.log("config check: ok");
}
