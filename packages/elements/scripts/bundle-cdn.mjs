// The CDN module (UI-KITS.md §5.3): one ES module, `pk.js`, that registers every element, built
// from the package's own build (run `pnpm build` first). The locale packs load on demand, so
// esbuild splits them into chunks beside it.
//
//   node scripts/bundle-cdn.mjs [outDir]      outDir defaults to dist/cdn
//
// Output, all under outDir:
//   <version>/pk.js, <version>/chunks/*.js   the files, named for the exact version: immutable
//   <version>/fonts/*                        Rubik and the kit's mono face, beside the module
//   <version>/integrity.json                 the SRI hash of every file (sha384), and the same
//                                            hashes as an import-map "integrity" table
//   <major>/pk.js                            a one-line shim, `export * from "../<version>/pk.js"`,
//                                            for the floating major URL
//   <major>/integrity.json                   the shim's hash
//
// The major URL is a shim, not a copy, so the chunks and fonts always resolve under the exact
// version's URL (immutable, and consistent with the pk.js that names them): a page that cached
// the shim across a deploy never meets a chunk that is gone. `assemble` runs this script into the
// Worker's assets root; the Worker route (core/elements.ts) serves the result.
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
// The release being deployed names the bundle: PKEY_ELEMENTS_VERSION (deploy.yml passes the tag's
// version) wins over package.json, whose committed "0.0.0" is only stamped at publish time. An
// unstamped 0.0.0 is a local/CI build, and the Worker serves it `no-cache`; a deploy must never
// ship it, so under CI it is refused unless the job says so (PKEY_ELEMENTS_UNSTAMPED_OK=1, the
// test/assemble jobs that never publish).
const version = process.env.PKEY_ELEMENTS_VERSION || pkg.version;
if (!/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`bundle-cdn: "${version}" is not a version.`);
  process.exit(1);
}
if (
  version === "0.0.0" &&
  process.env.CI &&
  process.env.PKEY_ELEMENTS_UNSTAMPED_OK !== "1"
) {
  console.error(
    "bundle-cdn: refusing to build the unstamped 0.0.0 under CI. Set PKEY_ELEMENTS_VERSION to the release version.",
  );
  process.exit(1);
}
const major = version.split(".")[0];
// A prerelease deploy publishes its exact version but must not move the floating major
// (PKEY_ELEMENTS_FLOAT=0, or a version with a prerelease tag): the major directory is then not
// written at all.
const float = !version.includes("-") && process.env.PKEY_ELEMENTS_FLOAT !== "0";

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
// `importMap` is the same hashes keyed by absolute URL, ready to paste as
// <script type="importmap">: a browser checks `integrity` on the top-level module only, but an
// import map's "integrity" table covers every module the graph loads, chunks included.
const origin = process.env.PKEY_ELEMENTS_ORIGIN || "https://key.plrs.im";
const importMap = { integrity: {} };
for (const [rel, hash] of Object.entries(integrity))
  if (rel.endsWith(".js"))
    importMap.integrity[`${origin}/elements/${version}/${rel}`] = hash;
writeFileSync(
  join(exact, "integrity.json"),
  JSON.stringify(
    { name: pkg.name, version, files: integrity, importMap },
    null,
    2,
  ) + "\n",
);

// The floating major URL is the shim.
const shim = `export * from "../${version}/pk.js";\n`;
if (float) {
  mkdirSync(join(out, major), { recursive: true });
  writeFileSync(join(out, major, "pk.js"), shim);
  writeFileSync(
    join(out, major, "integrity.json"),
    JSON.stringify(
      {
        name: pkg.name,
        version,
        files: {
          "pk.js":
            "sha384-" + createHash("sha384").update(shim).digest("base64"),
        },
      },
      null,
      2,
    ) + "\n",
  );
}

console.log(
  `bundle-cdn: ${Object.keys(integrity).length} files, pk.js ${integrity["pk.js"]} -> ${out}`,
);
