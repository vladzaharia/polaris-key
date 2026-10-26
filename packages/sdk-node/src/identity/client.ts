// The Identity sub-client: `signIn.start(opts)` (device code or redirect; signIn.ts, redirect.ts),
// the account verbs (account.ts: `subject()`, `signOut()`, `openAccount()`, `attach()`) and
// `current()`, the signed-in identity.
//
// A device-code sign-in yields the SIGNED-IN IDENTITY'S OWN licence and nothing else. The
// Worker's callback merges nothing (P1-06): a device that was on an anonymous enrolled licence is
// not attached to the account by signing in. The opt-in, device-confirmed attach (P1-07) is
// `wait({confirm})` on the session, then `identity.attach`.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { PolarisError } from "@polaris-key/client-core";
import { DEVICE_POLL_DENIED } from "@polaris-key/protocol/identity";
import { readJson, writeJson } from "../core/jsonFile.js";
import { ErrorCode, Feature } from "../constants.generated.js";
import type { CoreContext } from "../core/context.js";
import { classifyResponse, errorFrom } from "../core/http.js";
import type { TokenManager } from "../core/token.js";
import { redactOnPrint } from "../core/redact.js";
import type { ProductDiscoveryDocument } from "../discovery.js";
import {
  Account,
  type AttachResult,
  BeforeSignOutHooks,
  subjectFile,
  type OpenAccountResult,
  type SignOutResult,
} from "./account.js";
import {
  startDeviceCodeSignIn,
  type DeviceCodeSession,
  type DeviceCodeSignInOptions,
  type IdentityEvent,
  type ShownIdentity,
} from "./signIn.js";
import {
  startRedirectSignIn,
  type RedirectSession,
  type RedirectSignInOptions,
} from "./redirect.js";

/** `identity.current()`: who this device is signed in as. */
export interface CurrentIdentity extends ShownIdentity {
  /** Epoch seconds of the sign-in on this device. */
  signedInAt: number;
}

/** The process spawner `openInBrowser` uses (a test passes a fake). */
export type SpawnLike = (
  cmd: string,
  args: string[],
  opts: { detached: boolean; stdio: "ignore" },
) => {
  once(event: "error" | "spawn", fn: () => void): unknown;
  unref(): void;
};

/** The OS command and arguments that open `url` with the default handler, per platform. */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): [string, string[]] {
  // Windows: rundll32 hands the URL to the protocol handler as one argument. `cmd /c start`
  // would run it through cmd.exe's parser, where `&`, `|` and `^` in a URL split the command.
  if (platform === "win32")
    return ["rundll32", ["url.dll,FileProtocolHandler", url]];
  if (platform === "darwin") return ["open", [url]];
  return ["xdg-open", [url]];
}

/**
 * Open `url` with the OS's default handler. Best-effort: false when no opener ran. Only an
 * absolute http(s) URL with no whitespace or control character is opened.
 */
export function openInBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawnImpl: SpawnLike = spawn as unknown as SpawnLike,
): Promise<boolean> {
  if (!/^https?:\/\//.test(url) || /[\s\u0000-\u001f\u007f-\u009f]/.test(url))
    return Promise.resolve(false);
  const [cmd, args] = browserCommand(url, platform);
  return new Promise((resolve) => {
    try {
      const child = spawnImpl(cmd, args, {
        detached: true,
        stdio: "ignore",
      });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

/** Raised after a sign-in mints a credential; the facade syncs. */
export type SignInAcquiredListener = () => Promise<void>;

export class IdentityClient {
  private readonly identityFile: string;

  constructor(
    private readonly ctx: CoreContext,
    private readonly tokens: TokenManager,
    private readonly onAcquired: SignInAcquiredListener,
    /** `license.wipeLocal()`, for a `signOut()` that released the device. */
    private readonly wipeLocal: () => Promise<void> = async () => undefined,
    /** The discovery document this session loaded, or null. */
    private readonly discovery: () => ProductDiscoveryDocument | null = () =>
      null,
    /** Load discovery when this session has not (the redirect channel needs its endpoints). */
    private readonly loadDiscovery: () => Promise<ProductDiscoveryDocument | null> = async () =>
      this.discovery(),
    /** `client.events.safeEmit("identity", …)`. */
    private readonly emit: (e: IdentityEvent) => void = () => undefined,
    /** The licence the device runs on (the cache's), for a sign-in's `activation`. */
    private readonly licenseId: () => string | null = () => null,
  ) {
    this.identityFile = join(ctx.dirs.state, "identity.json");
    this.account = new Account({
      ctx,
      tokens,
      discovery: this.loadDiscovery,
      hooks: this.beforeSignOut,
      forget: () => this.forget(),
      wipeLocal: this.wipeLocal,
      openUrl: (url) => openInBrowser(url),
      emit: this.emit,
    });
  }

  private readonly account: Account;
  private readonly beforeSignOut = new BeforeSignOutHooks();

  /** Register a function `signOut()` awaits first (Cloud Sync's flush, D-4); returns its remover. */
  onBeforeSignOut(hook: () => Promise<void> | void): () => void {
    return this.beforeSignOut.add(hook);
  }

  /** The pairwise subject of the account signed in on this device, or null (persisted). */
  subject(): Promise<string | null> {
    return this.account.subject();
  }

  /**
   * Add this device's licence to the signed-in account (§12.3). `confirm: false` previews it and
   * writes nothing; `confirm: true` attaches, rotates the token and stores the subject. A refusal
   * (`account_required`, `license_owned`, ...) is a result that keeps the token. The device-code
   * `confirm` poll carries `attachable`; the caller who confirms calls this.
   */
  attach(opts: { confirm: boolean }): Promise<AttachResult> {
    return this.account.attach(opts.confirm);
  }

  /** Open the product's account page in the browser. */
  openAccount(): Promise<OpenAccountResult> {
    return this.account.openAccount();
  }

  /** Conformance replay only (reached through a typed cast, like `chunkRangeFetch`): the exact
   *  `state` and verifier of a recorded redirect conversation. */
  private redirectEntropy:
    | { state?: string; codeVerifier?: string }
    | undefined;

  /**
   * Sign in. `start({channel: "device-code", ...})` returns a {@link DeviceCodeSession}: show
   * its `userCode` and `verificationUri` (or open `verificationUriComplete`), then `wait()`.
   * `start({channel: "redirect", redirectUri})` returns a {@link RedirectSession}: open its
   * `authorizeUrl` in a browser, then `complete(callbackUrl)`. Identity off: `start` throws
   * `service-unavailable` before any request.
   */
  get signIn(): {
    start(opts: DeviceCodeSignInOptions): Promise<DeviceCodeSession>;
    start(opts: RedirectSignInOptions): Promise<RedirectSession>;
  } {
    const start = (
      opts: DeviceCodeSignInOptions | RedirectSignInOptions,
    ): Promise<DeviceCodeSession | RedirectSession> => {
      if (opts.channel === "redirect")
        return startRedirectSignIn(
          {
            ctx: this.ctx,
            tokens: this.tokens,
            discovery: this.loadDiscovery,
            onAcquired: this.onAcquired,
            forget: () => this.forget(),
            emit: this.emit,
            ...(this.redirectEntropy ? { entropy: this.redirectEntropy } : {}),
          },
          opts,
        );
      if (opts.channel === "device-code")
        return startDeviceCodeSignIn(
          {
            ctx: this.ctx,
            tokens: this.tokens,
            discovery: this.discovery,
            onAcquired: this.onAcquired,
            storeIdentity: (who) => this.storeIdentity(who),
            fetchSubject: () => this.account.fetchSubject(),
            licenseId: this.licenseId,
            openUrl: (url) => openInBrowser(url),
            emit: this.emit,
          },
          opts,
        );
      return Promise.reject(
        new PolarisError(
          ErrorCode.signInUnavailable,
          `unknown sign-in channel: ${String((opts as { channel?: unknown }).channel)}`,
        ),
      );
    };
    return { start } as {
      start: {
        (opts: DeviceCodeSignInOptions): Promise<DeviceCodeSession>;
        (opts: RedirectSignInOptions): Promise<RedirectSession>;
      };
    };
  }

  /** Persist who signed in (`identity.json`); null forgets it. */
  private async storeIdentity(who: ShownIdentity | null): Promise<void> {
    if (who)
      await writeJson(this.identityFile, {
        ...who,
        signedInAt: this.ctx.now(),
      }).catch(() => undefined);
    else await this.forget();
  }

  /** Who this device is signed in as (from the last `ready`), or null. */
  async current(): Promise<CurrentIdentity | null> {
    if (this.tokens.current === null) return null;
    const v = await readJson<CurrentIdentity | null>(this.identityFile, null);
    return v && typeof v.signedInAt === "number" ? v : null;
  }

  /** Sign out of the account (`POST signout`) after the pre-sign-out hooks. The device token goes
   *  only when the server released the device (`released: true`). */
  signOut(): Promise<SignOutResult> {
    return this.account.signOut();
  }

  /** Forget the stored identity (the facade calls it on every deactivation). */
  async forget(): Promise<void> {
    await rm(this.identityFile, { force: true }).catch(() => undefined);
    await rm(subjectFile(this.ctx.dirs.state), { force: true }).catch(
      () => undefined,
    );
  }
}
