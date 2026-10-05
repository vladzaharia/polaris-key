/**
 * I-06: seal one login-card provider secret for a Worker secret (RUNBOOK "Login-card providers").
 *
 *   PLATFORM_KEK=… pnpm --filter @polaris-key/worker signin:seal -- google < client-secret.txt
 *   PLATFORM_KEK=… pnpm --filter @polaris-key/worker signin:seal -- apple  < AuthKey_ABCDE12345.p8
 *   PLATFORM_KEK=… pnpm --filter @polaris-key/worker signin:seal -- steam  < steam-web-api-key.txt
 *
 * Reads the plaintext from stdin and the KEK of the TARGET environment from this process's
 * environment (the same names the Worker reads: `PLATFORM_KEK` (+ `PLATFORM_KEK_ID`), or
 * `PLATFORM_KEK_KEYS` + `PLATFORM_KEK_ACTIVE`). Prints the sealed blob, bound to
 * `pkey:v2:_platform:signin-provider-secret:<id>`, for
 * `wrangler secret put SIGNIN_<…> --env <env>`. It writes nothing and calls nothing; the blob
 * opens only in a Worker holding the same KEK.
 */
import { seal } from "../src/keyvault.js";
import type { Env } from "../src/env.js";
import {
  isSignInProviderKind,
  SIGNIN_ENV,
  SIGNIN_SECRET_IDS,
  signInSecretContext,
} from "../src/services/identity/providers/config.js";

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
  const sealed = await seal(
    process.env as unknown as Env,
    plaintext,
    signInSecretContext(SIGNIN_SECRET_IDS[kind]),
  );
  console.error(
    `sealed for ${SIGNIN_ENV[kind].sealed}; set it with: wrangler secret put ${SIGNIN_ENV[kind].sealed} --env <env>`,
  );
  process.stdout.write(`${sealed}\n`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
