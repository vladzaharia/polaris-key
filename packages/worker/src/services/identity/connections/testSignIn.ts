/**
 * Test sign-in for a connection (I-31; brand transition admin-3-19): the operator signs in through
 * the provider once, before anything is saved, and sees which claims arrived.
 *
 * The flow is the portal's own (`GET /callback`, one redirect URI for every connection), marked
 * with a `test` record. Four rules:
 *
 *   1. **The result reaches only the operator who started it.** The flow is bound to the browser
 *      by the same cookie the portal uses, and the result is read back only by the operator
 *      session (`sub`) and the wizard's draft id that started the flow.
 *   2. **Claims are shown, never stored.** The result lives in the single-use store (not D1) for
 *      five minutes, is read once, and holds only the preview: the mapped values and the names of
 *      the claims the token carried. Nothing is persisted until the wizard's last step.
 *   3. **The provider's error is plain text.** Length-capped, control characters removed and
 *      secret-shaped runs redacted. It is never rendered as markup.
 *   4. **The same-tab fallback returns by one fixed path** (`TEST_RETURN_PATH`) to the same step.
 *
 * A draft's client secret is sealed (under PLATFORM_KEK, bound to the flow's `state`) inside the
 * single-use record, so it is never held in the clear and never reaches the browser again.
 */

import type { Db } from "../../../db/types.js";
import type { Env } from "../../../platform/env.js";
import { hashKey } from "../../../platform/crypto.js";
import { open, seal } from "../../../platform/keyvault.js";
import {
  authorizationUrl,
  connectionHosts,
  discover,
  newFlowSecrets,
  redeemAuthorizationCode,
  type RelyingParty,
} from "../../../core/oidc/client.js";
import {
  CONNECTION_ID_RE,
  openConnectionSecret,
  resolveConnection,
  type ClaimMap,
} from "../../../core/oidc/connections.js";
import {
  artefactRef,
  consumeArtefact,
  getArtefact,
  putArtefact,
} from "../../../core/singleUse.js";
import { parseFlowRecord } from "../../../platform/json.js";
import { mappedClaims, mappedGroups } from "./claims.js";
import { cleanClaimMap, issuerProblem } from "./admin.js";
import { portalFlowKey } from "../portal/flowKey.js";

export const TEST_FLOW_TTL_SECONDS = 600;
export const TEST_RESULT_TTL_SECONDS = 300;
/** The console page the same-tab fallback returns to (a fixed path: nothing the caller sends). */
export const TEST_RETURN_PATH = "/manage/#/platform/connections/new";
const ERROR_TEXT_MAX = 200;

/** What a test flow record carries (in `FlowRecord.test`). */
export interface TestFlow {
  sub: string;
  draftId: string;
  issuer: string;
  clientId: string;
  jwksUri: string | null;
  claimMap: ClaimMap;
  /** The draft's secret, sealed to this flow; or null (a public client, or the stored secret). */
  secretSealed: string | null;
  /** Test an existing connection with its stored secret. */
  connectionId?: string;
  state: string;
}

export interface TestResult {
  sub: string;
  draftId: string;
  ok: boolean;
  /** A plain-text reason. */
  message?: string;
  preview?: ClaimsPreview;
}

export interface ClaimsPreview {
  issuer: string;
  email: string | null;
  emailVerified: boolean | null;
  name: string | null;
  /** The mapped groups claim, as it would be kept. */
  groups: string[] | null;
  /** The mapped access-rule claims, as they would be kept. */
  claims: Record<string, string> | null;
  /** The names of the claims the token carried: names only, never values. */
  claimNames: string[];
}

const flowSecretId = (state: string): string => `test:${state}`;

/** Plain text for the page: control characters out, long secret-shaped runs redacted, capped. */
export function plainProviderText(
  raw: unknown,
  secrets: string[] = [],
): string {
  let t = typeof raw === "string" ? raw : "";
  // eslint-disable-next-line no-control-regex
  t = t
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const s of secrets) if (s.length >= 4) t = t.split(s).join("[redacted]");
  t = t.replace(/[A-Za-z0-9_\-+/=.]{24,}/g, "[redacted]");
  return t.length > ERROR_TEXT_MAX ? `${t.slice(0, ERROR_TEXT_MAX - 1)}…` : t;
}

async function resultRef(env: Env, state: string) {
  return artefactRef(
    "connection-test",
    await hashKey(state, env.KEY_HASH_PEPPER),
  );
}

export type StartTest =
  | {
      ok: true;
      url: string;
      state: string;
      binding: string;
      bindingHash: string;
    }
  | {
      ok: false;
      status: 404 | 409 | 422 | 502;
      code: string;
      message: string;
      fields?: string[];
    };

export interface StartTestInput {
  sub: string;
  draftId: string;
  connectionId?: string;
  issuer?: unknown;
  clientId?: unknown;
  clientSecret?: unknown;
  jwksUri?: unknown;
  claimMap?: unknown;
}

const DRAFT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * Begin a test sign-in. Answers the provider's authorization URL, the flow's state and the
 * binding cookie's value; the handler sets the cookie. The flow record is the portal's own shape
 * with `test` set, so `/callback` finds it by `state`.
 */
export async function startConnectionTest(
  env: Env,
  db: Db,
  input: StartTestInput,
  origin: string,
): Promise<StartTest> {
  const fail = (
    status: 404 | 409 | 422 | 502,
    code: string,
    message: string,
    fields?: string[],
  ): StartTest => ({
    ok: false,
    status,
    code,
    message,
    ...(fields ? { fields } : {}),
  });
  if (!DRAFT_ID_RE.test(input.draftId)) {
    return fail(422, "invalid_draft", "Start the test from the wizard.");
  }
  const { state, nonce, verifier, challenge } = await newFlowSecrets();
  let issuer: string;
  let clientId: string;
  let jwksUri: string | null = null;
  // The same validation a saved claim map gets: names only, bounded.
  const given =
    input.claimMap === undefined ? undefined : cleanClaimMap(input.claimMap);
  if (given && "ok" in given) {
    return fail(422, "invalid_claim_map", given.message, given.fields);
  }
  let claimMap: ClaimMap = given ?? {};
  let secretPlain: string | null = null;
  let connectionId: string | undefined;
  if (input.connectionId !== undefined) {
    const conn = CONNECTION_ID_RE.test(input.connectionId)
      ? await resolveConnection(db, input.connectionId)
      : null;
    if (!conn || conn.scope !== "platform") {
      return fail(404, "not_found", "No such connection.");
    }
    issuer = conn.issuer;
    clientId = conn.clientId;
    jwksUri = conn.jwksUri;
    claimMap = given ?? conn.claimMap;
    connectionId = conn.id;
    secretPlain = await openConnectionSecret(env, db, conn.id);
  } else {
    issuer = typeof input.issuer === "string" ? input.issuer.trim() : "";
    const problem = issuerProblem(issuer);
    if (problem) return fail(422, "invalid_issuer", problem, ["issuer"]);
    clientId = typeof input.clientId === "string" ? input.clientId.trim() : "";
    if (!/^[\x21-\x7e]{1,200}$/.test(clientId)) {
      return fail(
        422,
        "invalid_client_id",
        "Enter the client ID, without spaces.",
        ["clientId"],
      );
    }
    jwksUri =
      typeof input.jwksUri === "string" && input.jwksUri ? input.jwksUri : null;
    if (typeof input.clientSecret === "string" && input.clientSecret.trim()) {
      if (input.clientSecret.length > 4096) {
        return fail(422, "invalid_client_secret", "Enter the client secret.", [
          "clientSecret",
        ]);
      }
      secretPlain = input.clientSecret.trim();
    }
  }
  const rp: RelyingParty = {
    label: "connection-test",
    issuer,
    clientId,
    clientSecret: null,
    allowedHosts: connectionHosts(issuer, jwksUri),
    jwksUri,
  };
  let url: string;
  try {
    const discovered = await discover(rp);
    url = authorizationUrl(discovered, rp, {
      redirectUri: `${origin}/callback`,
      scope: claimMap.groups
        ? "openid email profile groups"
        : "openid email profile",
      state,
      nonce,
      codeChallenge: challenge,
    });
  } catch {
    return fail(
      502,
      "discovery_unreachable",
      "The provider did not answer discovery. Check the issuer address.",
      ["issuer"],
    );
  }
  let secretSealed: string | null = null;
  if (secretPlain && connectionId === undefined) {
    try {
      secretSealed = await seal(env, secretPlain, {
        product: "_platform",
        kind: "identity-connection",
        id: flowSecretId(state),
      });
    } catch {
      return fail(
        409,
        "no_kek",
        "Secrets cannot be sealed: the platform key is not set up.",
      );
    }
  }
  const binding = (await newFlowSecrets()).state;
  const bindingHash = await hashKey(binding, env.KEY_HASH_PEPPER);
  const test: TestFlow = {
    sub: input.sub,
    draftId: input.draftId,
    issuer,
    clientId,
    jwksUri,
    claimMap,
    secretSealed,
    ...(connectionId ? { connectionId } : {}),
    state,
  };
  await putArtefact(
    env,
    await portalFlowKey(env, state),
    JSON.stringify({
      verifier,
      nonce,
      redirectUri: `${origin}/callback`,
      bindingHash,
      test,
    }),
    TEST_FLOW_TTL_SECONDS,
  );
  return { ok: true, url, state, binding, bindingHash };
}

/** The `test` part of a flow record, or null when the flow is an ordinary sign-in. */
export function testFlowOf(record: unknown): TestFlow | null {
  if (typeof record !== "object" || record === null) return null;
  const t = (record as { test?: unknown }).test;
  if (typeof t !== "object" || t === null) return null;
  const o = t as Partial<TestFlow>;
  if (
    typeof o.sub !== "string" ||
    typeof o.draftId !== "string" ||
    typeof o.issuer !== "string" ||
    typeof o.clientId !== "string" ||
    typeof o.state !== "string"
  ) {
    return null;
  }
  return o as TestFlow;
}

function previewOf(
  issuer: string,
  payload: Record<string, unknown>,
  claimMap: ClaimMap,
): ClaimsPreview {
  const str = (v: unknown, max: number): string | null =>
    typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
  return {
    issuer,
    email: str(payload.email, 254),
    emailVerified:
      typeof payload.email_verified === "boolean"
        ? payload.email_verified
        : null,
    name: str(claimMap.name ? payload[claimMap.name] : payload.name, 120),
    groups: mappedGroups(payload, claimMap.groups),
    claims: mappedClaims(payload, claimMap.claims),
    claimNames: Object.keys(payload).sort().slice(0, 60),
  };
}

/**
 * Finish a test flow at `/callback`: redeem the code (or take the provider's error), keep the
 * result for the operator, and send the browser back by the fixed path. The flow record has been
 * consumed by the caller. Never throws: every failure is a result the wizard shows.
 */
export async function completeConnectionTest(
  env: Env,
  db: Db,
  record: { verifier: string; nonce: string; redirectUri: string },
  test: TestFlow,
  response: {
    code: string | null;
    iss: string | null;
    error: string | null;
    errorDescription: string | null;
  },
): Promise<Response> {
  const secrets: string[] = [];
  let result: TestResult;
  try {
    if (!response.code) {
      const why = plainProviderText(
        [response.error, response.errorDescription].filter(Boolean).join(": "),
      );
      result = {
        sub: test.sub,
        draftId: test.draftId,
        ok: false,
        message: why
          ? `The provider refused the sign-in: ${why}`
          : "The provider did not return a code.",
      };
    } else {
      let secret: string | null = null;
      if (test.connectionId) {
        secret = await openConnectionSecret(env, db, test.connectionId);
      } else if (test.secretSealed) {
        secret = (
          await open(env, test.secretSealed, {
            product: "_platform",
            kind: "identity-connection",
            id: flowSecretId(test.state),
          })
        ).trim();
      }
      if (secret) secrets.push(secret);
      const rp: RelyingParty = {
        label: "connection-test",
        issuer: test.issuer,
        clientId: test.clientId,
        clientSecret: secret,
        allowedHosts: connectionHosts(test.issuer, test.jwksUri),
        jwksUri: test.jwksUri,
      };
      const { claims } = await redeemAuthorizationCode(rp, {
        code: response.code,
        iss: response.iss,
        redirectUri: record.redirectUri,
        codeVerifier: record.verifier,
        nonce: record.nonce,
      });
      result = {
        sub: test.sub,
        draftId: test.draftId,
        ok: true,
        preview: previewOf(
          test.issuer,
          claims as Record<string, unknown>,
          test.claimMap,
        ),
      };
    }
  } catch (e) {
    result = {
      sub: test.sub,
      draftId: test.draftId,
      ok: false,
      message:
        `The sign-in did not complete. ${plainProviderText(e instanceof Error ? e.message : "", secrets)}`.trim(),
    };
  }
  await putArtefact(
    env,
    await resultRef(env, test.state),
    JSON.stringify(result),
    TEST_RESULT_TTL_SECONDS,
  );
  const target = `${TEST_RETURN_PATH}?step=test&draft=${encodeURIComponent(test.draftId)}&state=${encodeURIComponent(test.state)}`;
  return new Response(null, {
    status: 302,
    headers: { location: target, "cache-control": "no-store" },
  });
}

/**
 * The result of a test, read once and only by the operator and draft that started it. A wrong
 * operator or draft leaves it in place for the right one; an unknown or spent state is `null`.
 */
export async function takeTestResult(
  env: Env,
  input: { sub: string; draftId: string; state: string },
): Promise<Omit<TestResult, "sub" | "draftId"> | null> {
  const ref = await resultRef(env, input.state);
  const raw = await getArtefact(env, ref);
  const r = parseFlowRecord<TestResult>(raw);
  if (!r || r.sub !== input.sub || r.draftId !== input.draftId) return null;
  const taken = await consumeArtefact(env, ref);
  if (!taken) return null;
  const out = parseFlowRecord<TestResult>(taken);
  if (!out) return null;
  // The operator's id is not part of the answer.
  return {
    ok: out.ok,
    ...(out.message !== undefined ? { message: out.message } : {}),
    ...(out.preview ? { preview: out.preview } : {}),
  };
}
