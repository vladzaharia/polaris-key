// S-15: enumerate the write surface of the Google Play Developer API (androidpublisher v3)
// from Google's public discovery document. Reads a local copy; makes no account call.
//   curl -sSo play-discovery.json 'https://androidpublisher.googleapis.com/$discovery/rest?version=v3'
//   node scan-play-discovery.mjs play-discovery.json
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const file = process.argv[2] ?? "play-discovery.json";
const raw = readFileSync(file);
const doc = JSON.parse(raw);
const methods = [];
function walk(resources, prefix) {
  for (const [name, r] of Object.entries(resources ?? {})) {
    const p = prefix ? `${prefix}.${name}` : name;
    for (const [m, def] of Object.entries(r.methods ?? {}))
      methods.push({
        id: `${p}.${m}`,
        http: def.httpMethod,
        path: def.flatPath ?? def.path,
      });
    walk(r.resources, p);
  }
}
walk(doc.resources, "");
const by = {};
for (const m of methods) (by[m.http] ??= []).push(m.id);
console.log(
  JSON.stringify(
    {
      revision: doc.revision,
      sha256: createHash("sha256").update(raw).digest("hex"),
      scopes: Object.keys(doc.auth?.oauth2?.scopes ?? {}),
      total: methods.length,
      counts: Object.fromEntries(
        Object.entries(by).map(([k, v]) => [k, v.length]),
      ),
      nonGet: Object.fromEntries(
        Object.entries(by).filter(([k]) => k !== "GET"),
      ),
    },
    null,
    2,
  ),
);
