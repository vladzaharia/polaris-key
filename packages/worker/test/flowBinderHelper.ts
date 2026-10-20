import type { Env } from "../src/platform/env.js";
import { hashKey } from "../src/platform/crypto.js";
import { adminFlowKey } from "../src/console/auth.js";
import { flowKey } from "../src/services/identity/oidc.js";
import { artefacts } from "./singleUseMock.js";

/** A raw `__Host-pk_lcb` value the tests give "the browser that started or confirmed the flow". */
export const TEST_BINDER = "test-binder-0123456789abcdef0123";
export const TEST_BINDER_COOKIE = `__Host-pk_lcb=${TEST_BINDER}`;

/**
 * Stamp the flow under `state` as bound to {@link TEST_BINDER} (what `/auth/start` or the device
 * page's confirmation does with a real cookie) and answer the `Cookie` header that browser sends
 * back. For tests that are not about the binder itself.
 */
export async function bindFlow(
  env: Env,
  product: string,
  state: string,
): Promise<string> {
  const key = await flowKey(env, product, state);
  const raw = await artefacts(env).get(key);
  if (raw) {
    const flow = JSON.parse(raw) as Record<string, unknown>;
    flow.binder = await hashKey(TEST_BINDER, env.KEY_HASH_PEPPER);
    await artefacts(env).put(key, JSON.stringify(flow));
  }
  return TEST_BINDER_COOKIE;
}

/** The admin twin of {@link bindFlow}: bind the console sign-in under `state`. */
export async function bindAdminFlow(env: Env, state: string): Promise<string> {
  const key = await adminFlowKey(state, env);
  const raw = await artefacts(env).get(key);
  if (raw) {
    const flow = JSON.parse(raw) as Record<string, unknown>;
    flow.bindingHash = await hashKey(TEST_BINDER, env.KEY_HASH_PEPPER);
    await artefacts(env).put(key, JSON.stringify(flow));
  }
  return `__Host-pkey_admin_flow=${TEST_BINDER}`;
}

/**
 * I-37: press **Sign in on {device}** for the device-code flow under `state`, the way the
 * approval page does for the browser that carries {@link TEST_BINDER}: GET the page for its
 * single-use token, then POST `decision=approve` (or `deny`). Run after the callback.
 */
export async function decideDeviceFlowAs(
  ctx: {
    env: Env;
    db: import("../src/db/types.js").Db;
    product: import("../src/core/products.js").Product;
  },
  decision: "approve" | "deny" = "approve",
  cookie: string = TEST_BINDER_COOKIE,
  now = Math.floor(Date.now() / 1000),
): Promise<Response> {
  const { handleAuthDeviceApprove } =
    await import("../src/services/identity/oidc.js");
  const url = `https://key.plrs.im/${ctx.product.slug}/identity/auth/device/approve`;
  const page = await handleAuthDeviceApprove(
    new Request(url, { headers: { cookie } }) as unknown as Request,
    ctx.env,
    ctx.db,
    ctx.product,
    now,
  );
  const token = /name="token" value="([^"]+)"/.exec(await page.text())?.[1];
  return handleAuthDeviceApprove(
    new Request(url, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/x-www-form-urlencoded",
        "sec-fetch-site": "same-origin",
      },
      body: new URLSearchParams({ token: token ?? "", decision }).toString(),
    }) as unknown as Request,
    ctx.env,
    ctx.db,
    ctx.product,
    now,
  );
}
