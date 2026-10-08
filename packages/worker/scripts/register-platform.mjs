#!/usr/bin/env node
// F-10 automation: register the platform's own packages on its feeds, from deploy.yml.
//
// Run by the "Register the platform packages" step of `.github/workflows/deploy.yml` after the
// request Worker is live (and safe to rerun by hand from a rerun of that job). It calls the deploy
// hook, `POST <origin>/webhooks/deploy` (src/platformDeploy.ts), which bootstraps the system
// product `polaris-key` (idempotent: an operator's switches stay as set), links it to this
// repository and applies the root `.pkey/` sent in the body: the package deliverables every SDK
// publish is checked against, and the trusted publisher the publishes exchange their OIDC tokens
// through (publish-package.yml in the `package-registry` environment).
// It then checks the hook's `uploads` report and fails the job when the Worker cannot issue upload
// tickets (a missing `BLOBS` binding or parent R2 secret), naming what is missing.
//
// Authentication is the job's own GitHub Actions OIDC token for the audience
// `<origin>/webhooks/deploy` (the job needs `id-token: write`); the Worker admits only this
// repository's deploy.yml, in the `production` environment, at a protected v* tag. The token is
// masked and never printed; nothing else here is secret.
//
// Inputs (environment): ORIGIN (the console origin, e.g. https://key.plrs.im);
// ACTIONS_ID_TOKEN_REQUEST_URL and ACTIONS_ID_TOKEN_REQUEST_TOKEN (set by Actions for a job with
// `id-token: write`). Optional: PKEY_ROOT (the repository root; default two levels up).
//
// Usage:  node scripts/register-platform.mjs          (inside packages/worker)

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const HOOK_PATH = "/webhooks/deploy";
const DOCUMENTS = ["product", "schema", "release", "distribution"];

/** The root `.pkey/` documents as text, by name (JSON before YAML, like a repository link). */
export function readManifestFiles(root) {
  const files = {};
  for (const name of DOCUMENTS)
    for (const ext of ["json", "yaml", "yml"]) {
      const path = join(root, ".pkey", `${name}.${ext}`);
      if (existsSync(path)) {
        files[name] = readFileSync(path, "utf8");
        break;
      }
    }
  return files;
}

async function oidcToken(env, audience, fetchImpl) {
  const base = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const bearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!base || !bearer)
    throw new Error(
      "this job cannot request a GitHub OIDC token (ACTIONS_ID_TOKEN_REQUEST_URL is unset): give the job `id-token: write`",
    );
  const url = `${base}${base.includes("?") ? "&" : "?"}audience=${encodeURIComponent(audience)}`;
  const res = await fetchImpl(url, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  if (!res.ok) throw new Error(`the OIDC token request failed: ${res.status}`);
  const body = await res.json();
  if (typeof body.value !== "string" || !body.value)
    throw new Error("the OIDC token response has no value");
  return body.value;
}

/** Call the deploy hook; answer its JSON. Throws with the Worker's reason on a refusal. */
export async function registerPlatform({
  origin,
  root,
  env = process.env,
  fetchImpl = fetch,
  out = process.stdout,
}) {
  const base = origin.replace(/\/+$/, "");
  const audience = `${base}${HOOK_PATH}`;
  const files = readManifestFiles(root);
  for (const need of ["product", "schema", "release"])
    if (!files[need]) throw new Error(`${root}/.pkey/ has no ${need} document`);
  const token = await oidcToken(env, audience, fetchImpl);
  // Actions masks the value in every later log line, should anything ever echo it.
  if (env.GITHUB_ACTIONS === "true") out.write(`::add-mask::${token}\n`);
  let res;
  for (let attempt = 1; ; attempt++) {
    res = await fetchImpl(audience, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ files }),
    });
    // A just-deployed version can take a few seconds to reach every edge (deploy.yml's smoke
    // check polls for the same reason): retry a 404 or a 5xx, briefly. Never a refusal: a used
    // token cannot be resent.
    if ((res.status === 404 || res.status >= 500) && attempt < 6) {
      out.write(
        `deploy hook answered ${res.status} (attempt ${attempt}/6); retrying in 5s\n`,
      );
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    break;
  }
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text.slice(0, 400) };
  }
  if (!res.ok) {
    const why =
      [body.reason, body.message].filter(Boolean).join(": ") ||
      body.error ||
      res.status;
    const detail = Array.isArray(body.errors)
      ? `\n  ${body.errors.join("\n  ")}`
      : "";
    throw new Error(
      `the deploy hook refused the registration (${res.status}): ${why}${detail}`,
    );
  }
  // The registration landed, but a publish also needs an upload ticket, and a Worker without the
  // blob store or the parent R2 token answers the uploads route 404 (core/publisher.ts r2Parent).
  // Fail here, by name, rather than in every SDK feed job afterwards.
  if (!body.uploads || typeof body.uploads.ready !== "boolean")
    throw new Error(
      "the deploy hook answered without `uploads`: the Worker that answered is not the version just deployed (or predates the readiness report); rerun this job",
    );
  if (!body.uploads.ready) {
    const missing = Array.isArray(body.uploads.missing)
      ? body.uploads.missing.join(", ")
      : "unknown";
    throw new Error(
      `the system product ${body.slug} is registered, but this Worker cannot issue upload tickets, so every SDK publish would get 404 from /${body.slug}/release/publish/uploads. ` +
        `Missing Worker configuration: ${missing}. Set the secrets with \`wrangler secret put <NAME> --env <env>\` (docs/DEPLOYMENT.md, "Trusted publishing: the R2 parent token") and rerun this job.`,
    );
  }
  return body;
}

/**
 * ST-20: the deploy summary's break-glass lines. The system product is manifest-authoritative, so
 * a console edit to it is a time-boxed break-glass claim; each one still live after this deploy
 * is named (key and expiry; the reason stays in the console), as a warning annotation under
 * Actions so a claim nobody committed to `.pkey/` is visible on every deploy.
 */
export function breakGlassLines(body, env = process.env) {
  const live = Array.isArray(body.breakGlass) ? body.breakGlass : [];
  const ended = Array.isArray(body.breakGlassEnded) ? body.breakGlassEnded : [];
  const at = (s) => new Date(s * 1000).toISOString();
  const warn =
    env.GITHUB_ACTIONS === "true" ? "::warning title=Break-glass claim::" : "";
  return [
    ...live.map(
      (b) =>
        `${warn}${body.slug}: ${b.key} is a live break-glass claim until ${at(b.expiresAt)}; commit the value to .pkey/ (the claim ends at the first deploy that changes it) or revert it in the console`,
    ),
    ...ended.map(
      (e) =>
        `${body.slug}: the break-glass claim on ${e.key} ended (${e.why === "expired" ? "its 7 days ran out" : "this deploy's .pkey/ changed it"}); the manifest's value applies`,
    ),
  ];
}

async function main() {
  const origin = process.env.ORIGIN;
  if (!origin)
    throw new Error(
      "ORIGIN is required (the console origin, e.g. https://key.plrs.im)",
    );
  const root = process.env.PKEY_ROOT ?? join(HERE, "..", "..", "..");
  const r = await registerPlatform({ origin, root });
  process.stdout.write(
    `${r.created ? "Created" : "Re-asserted"} the system product ${r.slug}, linked to ${r.repository}: ` +
      `${r.packages.length} packages; trusted publisher ` +
      (r.publisherClaimed
        ? "claimed by an operator (replaced by the manifest's)"
        : r.publisher
          ? `${r.publisher.workflow} in ${r.publisher.environment}${r.publisherChanged ? " (changed)" : ""}`
          : "none") +
      "\n",
  );
  for (const line of breakGlassLines(r)) process.stdout.write(`${line}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    process.stderr.write(
      `::error::${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(1);
  });
}
