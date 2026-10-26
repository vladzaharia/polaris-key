// The account verbs (identity.account, WIRE-CONTRACT-V4 §12.3, §12.6): `subject()`, `signOut()`
// and `openAccount()`.
//
// Each reads its endpoint off discovery's Identity fragment and never builds one: a product
// whose discovery names none answers the typed `service-unavailable` N/A before any request.
//
// The subject is persisted beside the identity (`subject.json` in the state directory), so it
// survives a restart; the sign-in flows (I-10a.5) write it on `ready` with `writeStoredSubject`
// and `forget()` removes it. `signOut()` runs the pre-sign-out hooks first (Cloud Sync's flush
// registers one, D-4), then `POST signout`; only `released: true` drops the device token, because
// only then did the server stop counting the device. A refused or failed sign-out changes
// nothing local.

import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  PolarisError,
  UnsupportedError,
  isManageUrl,
} from "@polaris-key/client-core";
import { PAIRWISE_SUBJECT_PATTERN } from "@polaris-key/protocol/identity";
import { ErrorCode, Feature } from "../constants.generated.js";
import { readJson, writeJson } from "../core/jsonFile.js";
import type { CoreContext } from "../core/context.js";
import { classifyResponse, errorFrom } from "../core/http.js";
import type { TokenManager } from "../core/token.js";
import {
  identityFragmentFrom,
  type IdentityFragment,
  type ProductDiscoveryDocument,
} from "../discovery.js";

/** `identity.signOut()`: whether the server released the device (the token then stopped working). */
export interface SignOutResult {
  released: boolean;
}

/** `identity.openAccount()`: the portal page and whether the host's opener ran. */
export interface OpenAccountResult {
  url: string;
  opened: boolean;
}

/** The functions `signOut()` awaits before it signs out, in registration order. A hook that
 *  throws stops the sign-out: nothing was signed out. */
export class BeforeSignOutHooks {
  private readonly set = new Set<() => Promise<void> | void>();

  /** Register a hook; returns its remover. */
  add(hook: () => Promise<void> | void): () => void {
    this.set.add(hook);
    return () => void this.set.delete(hook);
  }

  async run(): Promise<void> {
    for (const hook of Array.from(this.set)) await hook();
  }
}

const SUBJECT = new RegExp(PAIRWISE_SUBJECT_PATTERN);
const isSubject = (v: string): boolean => SUBJECT.test(v);

/** The state-directory file the subject lives in. */
export function subjectFile(stateDir: string): string {
  return join(stateDir, "subject.json");
}

/** The persisted subject, or null. A value that is not a pairwise subject reads as none. */
export async function readStoredSubject(
  stateDir: string,
): Promise<string | null> {
  const v = await readJson<{ subject?: unknown } | null>(
    subjectFile(stateDir),
    null,
  );
  return typeof v?.subject === "string" && isSubject(v.subject)
    ? v.subject
    : null;
}

/** Persist the subject (a sign-in's `ready`, or `subject()`); `null` removes it. */
export async function writeStoredSubject(
  stateDir: string,
  subject: string | null,
): Promise<void> {
  if (subject === null)
    await rm(subjectFile(stateDir), { force: true }).catch(() => undefined);
  else await writeJson(subjectFile(stateDir), { subject });
}

export interface AccountDeps {
  ctx: CoreContext;
  tokens: TokenManager;
  /** Discovery, loaded on demand. */
  discovery: () => Promise<ProductDiscoveryDocument | null>;
  hooks: BeforeSignOutHooks;
  /** Forget the stored identity and subject. */
  forget: () => Promise<void>;
  /** The local half of a deactivation: token, cache, the license event. No request. */
  wipeLocal: () => Promise<void>;
  /** Open a URL in the host's browser; false when it could not. */
  openUrl: (url: string) => Promise<boolean>;
}

type AccountEndpoint = "subject" | "signout" | "accountPortal" | "attach";

/** The licence an `attach({confirm: false})` preview names. */
export interface AttachLicense {
  id: string;
  tierId: string | null;
  name: string | null;
}

/**
 * What `attach({confirm})` answered (§12.3). `confirm`: the preview, nothing written. `ok`: the
 * licence is in the signed-in account, the token rotated and stored (`attached` is `claimed` when
 * this call put it there, absent when it already was); the caller syncs, as after `activate`.
 * `refused`: the Worker said no (`account_required`, `license_owned`, `license_email_bound`,
 * `unauthorized`, `not_found`, ...), by its wire code. A refusal is a result, never a thrown auth
 * failure, and it keeps the token, the cache and the identity.
 */
export type AttachResult =
  | { status: "confirm"; license: AttachLicense }
  | { status: "ok"; subject: string | null; attached?: "claimed" }
  | { status: "refused"; code: string; httpStatus: number };

export class Account {
  constructor(private readonly deps: AccountDeps) {}

  /** The discovery endpoint, else the typed N/A. Nothing is dialled before this answers. */
  private async endpoint(
    name: AccountEndpoint,
    feature: Feature = Feature.identityAccount,
  ): Promise<string> {
    const { ctx } = this.deps;
    ctx.requireService("identity", feature);
    const fragment: IdentityFragment | null = identityFragmentFrom(
      await this.deps.discovery(),
    );
    const url = (fragment?.endpoints as Record<string, string> | undefined)?.[
      name
    ];
    if (!url)
      throw new UnsupportedError(
        {
          supported: false,
          feature,
          reason: "product",
          detail: `this product's discovery names no identity ${name} endpoint`,
        },
        ErrorCode.serviceUnavailable,
      );
    return url;
  }

  /**
   * The pairwise subject of the account signed in on this device, or null (a key-only device,
   * or one with no token). The answer is persisted, so it survives a restart.
   */
  async subject(): Promise<string | null> {
    const url = await this.endpoint("subject");
    const { ctx, tokens } = this.deps;
    const token = tokens.current;
    if (token === null) {
      await writeStoredSubject(ctx.dirs.state, null);
      return null;
    }
    const res = await ctx.request(
      url,
      {
        method: "GET",
        headers: ctx.headers({ authorization: `Bearer ${token}` }),
      },
      "subject",
    );
    if (res.status !== 200)
      throw errorFrom(await classifyResponse(res), "subject");
    const body = (await res.json().catch(() => null)) as {
      subject?: unknown;
    } | null;
    const v = body?.subject;
    if (v === null) {
      await writeStoredSubject(ctx.dirs.state, null);
      return null;
    }
    if (typeof v !== "string" || !isSubject(v))
      throw new PolarisError(
        ErrorCode.badResponse,
        "the subject endpoint answered without a subject.",
      );
    await writeStoredSubject(ctx.dirs.state, v);
    return v;
  }

  /**
   * Sign out: await the pre-sign-out hooks, `POST signout`, then forget the identity. On
   * `released: true` the device token, cache and license state go too; on `false` (a key-only
   * activation) the device keeps its licence and token. A refusal or failure throws and
   * changes nothing.
   */
  async signOut(): Promise<SignOutResult> {
    const url = await this.endpoint("signout");
    const { ctx, tokens } = this.deps;
    const token = tokens.current;
    if (token === null) {
      await this.deps.forget();
      return { released: false };
    }
    await this.deps.hooks.run();
    const res = await ctx.request(
      url,
      {
        method: "POST",
        headers: ctx.headers({ authorization: `Bearer ${token}` }),
      },
      "sign-out",
    );
    if (res.status !== 200)
      throw errorFrom(
        await classifyResponse(res, ErrorCode.signOutFailed),
        "sign-out",
      );
    const body = (await res.json().catch(() => null)) as {
      released?: unknown;
    } | null;
    if (typeof body?.released !== "boolean")
      throw new PolarisError(
        ErrorCode.badResponse,
        "the signout endpoint answered without `released`.",
      );
    await this.deps.forget();
    if (body.released) await this.deps.wipeLocal();
    return { released: body.released };
  }

  /**
   * `POST identity/attach`. `confirm: false` previews the device's licence and writes nothing;
   * `confirm: true` puts it in the signed-in account, rotates the token and stores it, and
   * persists the subject. A Worker refusal is a typed result that changes nothing local.
   */
  async attach(confirm: boolean): Promise<AttachResult> {
    const url = await this.endpoint("attach", Feature.identityAttach);
    const { ctx, tokens } = this.deps;
    const token = tokens.current;
    if (token === null)
      throw new PolarisError(
        ErrorCode.noToken,
        "Activate or sign in before attaching the license.",
      );
    const res = await ctx.request(
      url,
      {
        method: "POST",
        headers: ctx.headers({
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        }),
        body: JSON.stringify({ confirm }),
      },
      "attach",
    );
    const text = await res.text().catch(() => "");
    let body: Record<string, unknown> | null = null;
    try {
      const v: unknown = JSON.parse(text);
      if (v && typeof v === "object" && !Array.isArray(v))
        body = v as Record<string, unknown>;
    } catch {
      body = null;
    }
    if (res.status !== 200) {
      const e = body?.error;
      const code =
        typeof e === "string"
          ? e
          : e &&
              typeof e === "object" &&
              typeof (e as { code?: unknown }).code === "string"
            ? (e as { code: string }).code
            : `http_${res.status}`;
      return { status: "refused", code, httpStatus: res.status };
    }
    if (body?.status === "confirm") {
      const l = (body.license ?? {}) as Record<string, unknown>;
      return {
        status: "confirm",
        license: {
          id: typeof l.id === "string" ? l.id : "",
          tierId: typeof l.tierId === "string" ? l.tierId : null,
          name: typeof l.name === "string" ? l.name : null,
        },
      };
    }
    if (typeof body?.token !== "string" || body.token === "")
      throw new PolarisError(
        ErrorCode.badResponse,
        "attach answered without a token.",
      );
    await tokens.set(body.token, "activate");
    const subject =
      typeof body.subject === "string" && isSubject(body.subject)
        ? body.subject
        : null;
    if (subject !== null) await writeStoredSubject(ctx.dirs.state, subject);
    return {
      status: "ok",
      subject,
      ...(body.attached === "claimed" ? { attached: "claimed" as const } : {}),
    };
  }

  /** Open the product's page in the customer portal in the host's browser. */
  async openAccount(): Promise<OpenAccountResult> {
    const url = await this.endpoint("accountPortal");
    if (!isManageUrl(url))
      throw new UnsupportedError(
        {
          supported: false,
          feature: Feature.identityAccount,
          reason: "product",
          detail:
            "this product's discovery names no usable account portal link",
        },
        ErrorCode.serviceUnavailable,
      );
    return { url, opened: await this.deps.openUrl(url) };
  }
}
