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
import { PolarisError, type DeviceKeyPort } from "@polaris-key/client-core";
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
  writeStoredSubject,
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
import { ChoiceClient } from "./choice.js";
import { NearbyRoutes } from "./nearby.js";
import {
  onNearbyRequest,
  type NearbyApproverKeyring,
  type NearbyApproverLan,
  type NearbyAsk,
} from "./nearbyApprover.js";
import type {
  NearbyApproverHandle,
  NearbyApproverOptions,
} from "../connect/nearbyApprover.js";
import {
  startNearbySignIn,
  type NearbyKeyring,
  type NearbyLan,
  type NearbySessionDeps,
  type NearbySignInOptions,
  type NearbySignInSession,
} from "./nearbySession.js";
import {
  nearbyAvailable,
  runAutoSignIn,
  SignInState,
  type AutoSignInOptions,
  type AutoSignInResult,
  type NearbyRole,
} from "./autoSignIn.js";
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

/** What nearby approval needs of the rest of the client, bound lazily (Cloud Connect is built
 *  after Identity). */
export interface NearbyBinding {
  /** This device's keys (made when none exist) and its `X-PKey-Device` value. */
  signer(): Promise<{ port: DeviceKeyPort; deviceId: string }>;
  /** `devices.registerKeys(port)`. */
  registerKeys(port: DeviceKeyPort): Promise<unknown>;
  /** Load discovery again and answer it (N11). */
  refreshDiscovery(): Promise<ProductDiscoveryDocument | null>;
  /** The LAN half of nearby approval (`cloudConnect.nearby`). */
  lan(): NearbyLan & NearbyApproverLan;
  /** The key ring: a wrap sent to a new device, a wrap taken from the channel. */
  keyring(): NearbyKeyring & NearbyApproverKeyring;
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
    /** Runs after the identity is forgotten: the facade drops the key ring's root and pin. */
    private readonly onForget: () => Promise<void> | void = () => undefined,
    /** Nearby approval's device keys and discovery refresh; absent, nearby answers the typed N/A. */
    private readonly nearbyBinding: NearbyBinding | null = null,
  ) {
    this.identityFile = join(ctx.dirs.state, "identity.json");
    this.signInState = new SignInState(ctx.dirs.state);
    // The token manager keeps "a sign-in produced this token" in the state directory.
    tokens.setMarks(this.signInState);
    this.account = new Account({
      ctx,
      tokens,
      discovery: this.loadDiscovery,
      hooks: this.beforeSignOut,
      forget: () => this.forget(),
      wipeLocal: this.wipeLocal,
      openUrl: (url) => openInBrowser(url),
      emit: this.emit,
      signedOut: async () => {
        await this.tokens.dropSignIn();
        await this.signInState.signedOut();
      },
    });
  }

  private readonly account: Account;
  private readonly signInState: SignInState;
  #routes: NearbyRoutes | undefined;

  /** The nearby HTTP routes, for the sign-in and approver sessions. @internal */
  get nearbyRoutes(): NearbyRoutes {
    const b = this.nearbyBinding;
    return (this.#routes ??= new NearbyRoutes({
      ctx: this.ctx,
      tokens: this.tokens,
      discovery: (fresh) =>
        fresh && b !== null ? b.refreshDiscovery() : this.loadDiscovery(),
      signer: () =>
        b !== null
          ? b.signer()
          : Promise.reject(
              new PolarisError(
                ErrorCode.serviceUnavailable,
                "nearby approval is not set up on this client.",
              ),
            ),
      registerKeys: (port) =>
        b !== null ? b.registerKeys(port) : Promise.resolve(),
      onAcquired: this.onAcquired,
      storeIdentity: (who) => this.storeIdentity(who),
      licenseId: this.licenseId,
      emit: this.emit,
    }));
  }
  private choiceClient: ChoiceClient | undefined;

  /**
   * The licence choice an app shows itself after a redirect sign-in answered `{kind: "choose",
   * grant}`: `licenses(grant)`, `devices(grant, licenseId)`, `complete(grant, choice)`,
   * `cancel(grant)` (choice.ts). Each answers the typed `service-unavailable` N/A when the
   * product's discovery names no choice endpoint.
   */
  get choice(): ChoiceClient {
    return (this.choiceClient ??= new ChoiceClient({
      ctx: this.ctx,
      tokens: this.tokens,
      discovery: this.loadDiscovery,
      onAcquired: this.onAcquired,
      forget: () => this.forget(),
      emit: this.emit,
    }));
  }
  private readonly beforeSignOut = new BeforeSignOutHooks();

  /** Register a function `signOut()` awaits first (Cloud Sync's flush, D-4); returns its remover. */
  onBeforeSignOut(hook: () => Promise<void> | void): () => void {
    return this.beforeSignOut.add(hook);
  }

  /**
   * The automatic sign-in ladder (CC-01-auto-sign-in; I-47.2). Node runs rung 1 (a token a
   * sign-in produced: `signedIn`, no network) and ends at the regular sign-in:
   * `needsSignIn{reason: "signed_out"}` after an explicit `signOut()` (until the next sign-in),
   * `needsSignIn{reason: "no_credential"}` otherwise, `unavailable` when Identity is off. It never
   * throws and starts nothing: the sign-in form (a kit) starts nearby or the device code.
   */
  autoSignIn(_opts: AutoSignInOptions = {}): Promise<AutoSignInResult> {
    return runAutoSignIn({
      ctx: this.ctx,
      discovery: this.loadDiscovery,
      signedIn: () => this.tokens.signedIn,
      state: this.signInState,
      licenseId: this.licenseId,
    });
  }

  /** Nearby approval (CC-15; V5 §12.11.5): whether this device can take part on one side. */
  readonly nearby = {
    /**
     * M, a signed-in device: advertise while the person has "Approve a nearby device" open
     * (`prompt: true`), or has allowed background approval (`prompt: false`, `background: true`),
     * and hand each session that reaches the code to `handler` as an `ask` (nearbyApprover.ts).
     * Returns CC-15's handle (`stop`, `pause`, `resume`, `setPrompt`, `reopen`, `status`). Throws
     * `account_required` when signed out and the typed N/A when nearby approval is not served.
     * Signing out stops it.
     */
    onRequest: (
      handler: (ask: NearbyAsk) => void,
      o: NearbyApproverOptions,
    ): Promise<NearbyApproverHandle> => {
      const b = this.nearbyBinding;
      if (b === null)
        return Promise.reject(
          new PolarisError(
            ErrorCode.serviceUnavailable,
            "nearby approval is not set up on this client.",
          ),
        );
      return onNearbyRequest(
        { routes: this.nearbyRoutes, lan: () => b.lan(), keyring: b.keyring() },
        handler,
        // This device's name in the other device's list (§12.7.1); never an account identifier.
        o.label !== undefined
          ? o
          : { ...o, ...labelFor(this.ctx.deviceLabel(undefined)) },
      );
    },
    /** True when Identity is on, discovery names `nearby` and the role's endpoints, and this
     *  runtime can do mDNS. Never throws. */
    available: (o: { role: NearbyRole }): Promise<boolean> =>
      nearbyAvailable({ ctx: this.ctx, discovery: this.loadDiscovery }, o),
  };

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
    start(opts: NearbySignInOptions): Promise<NearbySignInSession>;
  } {
    const start = (
      opts:
        | DeviceCodeSignInOptions
        | RedirectSignInOptions
        | NearbySignInOptions,
    ): Promise<DeviceCodeSession | RedirectSession | NearbySignInSession> => {
      if (opts.channel === "nearby") {
        const b = this.nearbyBinding;
        if (b === null)
          return Promise.reject(
            new PolarisError(
              ErrorCode.serviceUnavailable,
              "nearby approval is not set up on this client.",
            ),
          );
        return startNearbySignIn(
          {
            ctx: this.ctx,
            routes: this.nearbyRoutes,
            lan: () => b.lan(),
            keyring: b.keyring(),
            signOut: () => this.signOut(),
            ...this.nearbySessionHooks,
          },
          opts,
        );
      }
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
        (opts: NearbySignInOptions): Promise<NearbySignInSession>;
      };
    };
  }

  /** What a nearby sign-in session calls at the person's decision (V5 §15.6.1 rule 12). @internal */
  private get nearbySessionHooks(): Pick<
    NearbySessionDeps,
    "confirm" | "dropLocal" | "holds"
  > {
    return {
      holds: (token) => this.tokens.current === token,
      // Confirmed: the token is a sign-in, the subject is stored and the event goes out, so Sync
      // and Connect start now and not before (V5 §12.11.5 rule 9).
      confirm: async (subject) => {
        await this.tokens.confirmSignIn();
        await writeStoredSubject(this.ctx.dirs.state, subject).catch(
          () => undefined,
        );
        this.emit({ kind: "signedIn", subject });
      },
      // Unconfirmed and ended: the token, its mark and the stored identity go, whatever the
      // Worker answered to the sign-out.
      dropLocal: async () => {
        await this.tokens.clear();
        await this.forget();
      },
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
    await this.onForget();
  }
}

/** `{label}` when this device has a name to give, else nothing. */
function labelFor(label: string | null): { label?: string } {
  return label !== null && label !== "" ? { label } : {};
}
