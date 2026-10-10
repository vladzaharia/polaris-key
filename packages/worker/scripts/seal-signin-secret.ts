/**
 * I-06: seal one login-card provider secret for a Worker secret (RUNBOOK "Login-card providers").
 *
 *   PLATFORM_KEK=… pnpm --filter @polaris-key/worker signin:seal -- google < client-secret.txt
 *   PLATFORM_KEK=… pnpm --filter @polaris-key/worker signin:seal -- apple  < AuthKey_ABCDE12345.p8
 *   PLATFORM_KEK=… pnpm --filter @polaris-key/worker signin:seal -- steam  < steam-web-api-key.txt
 *
 * Reads the plaintext from stdin and the KEK of the TARGET environment from this process's
 * environment, resolved exactly as the Worker resolves it, because it is the Worker's own
 * `keyvault.seal`: `PLATFORM_KEK_KEYS` + `PLATFORM_KEK_ACTIVE` when set (a `PLATFORM_KEK` beside
 * them is the legacy key, open-only, and is never sealed under), else `PLATFORM_KEK`
 * (+ `PLATFORM_KEK_ID`). The blob is always sealed under the ACTIVE kid, so on an environment
 * mid-way through "Rotating when the old KEK is unknown" export only the new
 * `PLATFORM_KEK_KEYS` + `PLATFORM_KEK_ACTIVE`: the old key is not needed. Prints the sealed blob,
 * bound to `pkey:v2:_platform:signin-provider-secret:<id>`, for
 * `wrangler secret put SIGNIN_<…> --env <env>`, and the kid it used (a name, never key material)
 * on stderr. It writes nothing and calls nothing; the blob opens only in a Worker holding the same
 * KEK.
 */
import { fileURLToPath } from "node:url";
import { seal } from "../src/platform/keyvault.js";
import type { Env } from "../src/platform/env.js";
import {
  isSignInProviderKind,
  SIGNIN_ENV,
  SIGNIN_SECRET_IDS,
  signInSecretContext,
  type SignInProviderKind,
} from "../src/services/identity/providers/config.js";

/** Seal `plaintext` for `kind`'s Worker secret under `env`'s active KEK. Exported for the test. */
export async function sealSignInSecret(
  env: Env,
  kind: SignInProviderKind,
  plaintext: string,
): Promise<{ name: string; kekId: string; sealed: string }> {
  const sealed = await seal(
    env,
    plaintext,
    signInSecretContext(SIGNIN_SECRET_IDS[kind]),
  );
  const { kekId } = JSON.parse(sealed) as { kekId: string };
  return { name: SIGNIN_ENV[kind].sealed, kekId, sealed };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<void> {
  const kind = process.argv.slice(2).find((a) => a !== "--");
  if (!isSignInProviderKind(kind)) {
    console.error("usage: signin:seal -- <google|apple|steam> < secret");
    process.exit(2);
  }
  const plaintext = await readStdin();
  if (!plaintext) {
    console.error("no secret on stdin");
    process.exit(2);
  }
  if (kind === "apple" && !plaintext.includes("BEGIN PRIVATE KEY")) {
    console.error("the Apple secret is the .p8 file (a PKCS#8 PEM)");
    process.exit(2);
  }
  const { name, kekId, sealed } = await sealSignInSecret(
    process.env as unknown as Env,
    kind,
    plaintext,
  );
  console.error(
    `sealed for ${name} under KEK ${kekId}; set it with: wrangler secret put ${name} --env <env>`,
  );
  process.stdout.write(`${sealed}\n`);
}

if (
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1]
) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
