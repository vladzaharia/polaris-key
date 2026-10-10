import type { Env } from "../src/env.js";
import { hashKey } from "../src/crypto.js";
import { adminFlowKey } from "../src/admin/auth.js";
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
