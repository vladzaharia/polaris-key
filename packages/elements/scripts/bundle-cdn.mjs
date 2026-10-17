// The CDN module (UI-KITS.md §5.3): one ES module, `pk.js`, that registers every element, built
// from the package's own build (run `pnpm build` first). The locale packs load on demand, so
// esbuild splits them into chunks beside it.
//
//   node scripts/bundle-cdn.mjs [outDir]      outDir defaults to dist/cdn
//
// Output, all under outDir:
//   <version>/pk.js, <version>/chunks/*.js   the files, named for the exact version: immutable
//   <version>/fonts/*                        Rubik and the kit's mono face, beside the module
//   <version>/integrity.json                 the SRI hash of every file (sha384)
//   <major>/…                                the same files again, for the floating major URL
//
// The server side (the Worker route, its headers and the cache policy) is a separate change; this
// script only produces the files and the hashes it will serve.
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = process.argv[2] ?? join(root, "dist", "cdn");
const version = pkg.version;
const major = version.split(".")[0];

const exact = join(out, version);
rmSync(out, { recursive: true, force: true });
mkdirSync(exact, { recursive: true });

await build({
  entryPoints: { pk: join(root, "dist", "index.js") },
  outdir: exact,
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  splitting: true,
  format: "esm",
  target: "es2022",
  minify: true,
  legalComments: "none",
  // Reproducible: no timestamps, no absolute paths in the output.
  sourcemap: false,
  logLevel: "warning",
});

// The fonts the module loads beside itself (src/fonts.ts): fonts.css and the woff2 files.
cpSync(join(root, "dist", "fonts"), join(exact, "fonts"), { recursive: true });

function* files(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else yield p;
  }
}

const integrity = {};
for (const f of files(exact)) {
  const rel = relative(exact, f).split("\\").join("/");
  integrity[rel] =
    "sha384-" + createHash("sha384").update(readFileSync(f)).digest("base64");
}
writeFileSync(
  join(exact, "integrity.json"),
  JSON.stringify({ name: pkg.name, version, files: integrity }, null, 2) + "\n",
);

// The floating major URL serves the same files.
cpSync(exact, join(out, major), { recursive: true });

console.log(
  `bundle-cdn: ${Object.keys(integrity).length} files, pk.js ${integrity["pk.js"]} -> ${out}`,
);
