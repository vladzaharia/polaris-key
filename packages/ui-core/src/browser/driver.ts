// The framework-neutral half of the gate drop-in (UI-KITS.md §4.2, DL18): the browser client
// built from a config object, and the controller that drives the same states React's
// `useSdkGate` and `DrivenUpdate` do: status, Welcome / Activate (key), hosted sign-in, the
// device-limit link, grace, and the update offer with its facts (lead decision 1). It holds the
// steps and the typed key; the models decide every screen and nothing here draws.
//
// `<pk-gate config>` (elements) is the first caller outside React; no part of this file imports
// a framework.

import { withManageKey, withManageReturn } from "@polaris-key/client-core";
import { parsePortal, portalLink } from "@polaris-key/client-core/portal";
import { ISSUER } from "@polaris-key/protocol/core";

import type { ReleaseNoteInput, UiInput } from "../input.js";
import { BrowserAdapter } from "./sdk/browser/browserAdapter.js";
import {
  PolarisError,
  type DeviceCodeSignInSession,
  type OidcSignInHandle,
  type PolarisAdapter,
  type PolarisState,
} from "./sdk/core/index.js";
import { SERVICE_SLUGS, type ServiceSlug } from "./sdk/core/services.js";
import type { TrustSet } from "./sdk/browser/offline.js";
import {
  AddToAccountModel,
  type AddToAccountDriver,
  type AddToAccountSnapshot,
} from "../addToAccountModel.js";
import type {
  ChoiceComplete,
  SignInPrimitives,
  SignInSessionHandle,
  SignInWait,
} from "../signInModel.js";
import { gateInput, isHolderStep, type GateStep } from "./input.js";
import { openLink, safeLink } from "./links.js";

/** What `<pk-gate config>` takes: the product, and the few transport choices a page makes. */
export interface GateConfig {
  /** The product slug. */
  product: string;
  /** The control-plane origin. Defaults to the SDK's. */
  baseUrl?: string;
  /** The app's own version: reported with the device, and what the update prompt says you have. */
  version?: string;
  /** Browser-page authentication strategy. */
  auth?: "cookie" | "bearer" | "auto";
  /** Pinned trust keys for bearer mode. */
  trust?: { pinnedKeys: TrustSet };
  /** The services the app expects until discovery answers. */
  expectedServices?: readonly string[];
  /** The app's own address, added to the device-limit link as `return=` (PX-W8). */
  returnUrl?: string;
}

/** Test seams for the client. */
export interface BrowserClientSeams {
  fetchImpl?: typeof fetch;
  navigate?: (url: string) => void;
  now?: () => number;
}

const AUTH = new Set(["cookie", "bearer", "auto"]);

/** The config as an object: a JSON string (the attribute) or an object, checked. Throws a
 *  `PolarisError("invalid-options")` that names the first thing wrong. */
export function parseGateConfig(raw: unknown): GateConfig {
  let v = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      throw new PolarisError("invalid-options", "config is not valid JSON");
    }
  }
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new PolarisError("invalid-options", "config must be an object");
  const o = v as Record<string, unknown>;
  const str = (k: string): string | undefined => {
    const x = o[k];
    if (x === undefined) return undefined;
    if (typeof x !== "string" || x === "")
      throw new PolarisError("invalid-options", `config.${k} must be a string`);
    return x;
  };
  const product = str("product") ?? str("productSlug");
  if (!product)
    throw new PolarisError("invalid-options", "config.product is required");
  const auth = str("auth");
  if (auth !== undefined && !AUTH.has(auth))
    throw new PolarisError(
      "invalid-options",
      "config.auth must be cookie, bearer or auto",
    );
  const services = o.expectedServices;
  if (services !== undefined) {
    if (!Array.isArray(services))
      throw new PolarisError(
        "invalid-options",
        "config.expectedServices must be a list",
      );
    for (const s of services)
      if (typeof s !== "string" || !SERVICE_SLUGS.includes(s as ServiceSlug))
        throw new PolarisError(
          "invalid-options",
          `config.expectedServices has an unknown service: ${String(s)}`,
        );
  }
  const trust = o.trust as { pinnedKeys?: unknown } | undefined;
  if (
    trust !== undefined &&
    (typeof trust !== "object" ||
      trust === null ||
      typeof trust.pinnedKeys !== "object" ||
      trust.pinnedKeys === null)
  )
    throw new PolarisError(
      "invalid-options",
      "config.trust.pinnedKeys must be an object",
    );
  return {
    product,
    ...(str("baseUrl") ? { baseUrl: str("baseUrl")! } : {}),
    ...(str("version") ? { version: str("version")! } : {}),
    ...(auth ? { auth: auth as GateConfig["auth"] } : {}),
    ...(trust ? { trust: trust as { pinnedKeys: TrustSet } } : {}),
    ...(services ? { expectedServices: services as string[] } : {}),
    ...(str("returnUrl") ? { returnUrl: str("returnUrl")! } : {}),
  };
}

/** The browser client for a config: construction does no I/O (call `start()` once mounted). */
export function createBrowserClient(
  config: GateConfig,
  seams: BrowserClientSeams = {},
): PolarisAdapter {
  return new BrowserAdapter({
    productSlug: config.product,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.version ? { version: config.version } : {}),
    ...(config.auth ? { auth: config.auth } : {}),
    ...(config.trust ? { trust: config.trust } : {}),
    ...(config.expectedServices
      ? {
          expectedServices: config.expectedServices as readonly ServiceSlug[],
        }
      : {}),
    ...(seams.fetchImpl ? { fetchImpl: seams.fetchImpl } : {}),
    ...(seams.navigate ? { navigate: seams.navigate } : {}),
    ...(seams.now ? { now: seams.now } : {}),
    autoStart: false,
  });
}

/** An update the product offers, with the facts the prompt shows (lead decision 1). */
export interface UpdateOffer {
  version: string;
  /** Where the new build is (opened on Update now). */
  url: string;
  /** Up to three summary lines of the offered version's changelog entry; none: no "What's new". */
  notes: ReleaseNoteInput[];
  /** The release page, "All changes". */
  releaseUrl?: string;
}

/** What the gate draws now. */
export interface GateSnapshot {
  input: UiInput;
  step: GateStep;
  /** The control that opened the current step, so Back returns focus to it. */
  opener: string | null;
  /** The update to offer, or `null` (nothing newer, put off, or Update is off). */
  update: UpdateOffer | null;
  /** The update prompt's input, when there is one to show. */
  updateInput: UiInput | null;
}

export interface GateDriverOptions {
  /** The app's own address, added to the device-limit link as `return=` (PX-W8). */
  returnUrl?: string;
  /** The locale the kit speaks: grace dates are formatted in it. */
  locale?: string;
  /** The app's version: what the update prompt says you have. */
  version?: string;
  /** The product slug (the update prompt's bundle). */
  product?: string;
  /** The control-plane origin: where the product page link falls back to when discovery names
   *  none (an older Worker). Defaults to the SDK's. */
  baseUrl?: string;
  /** The device kind already worded ("computer", "browser"): the lines of ActivateDone and
   *  AddToAccount that name this device. Defaults to "device". */
  deviceKind?: string;
}

/** Open the device-limit link (PX-W8): the app's return URL as `return=` and, on an `/activate`
 *  link, the typed key as the fragment `#key=`; only a link that passes `safeLink` (DL14). */
export function openManage(
  url: string,
  returnUrl?: string,
  key?: string,
): void {
  let u = url;
  if (returnUrl) u = withManageReturn(u, returnUrl);
  if (key) u = withManageKey(u, key);
  const safe = safeLink(u);
  if (safe) openLink(safe);
}

/** The session handle a device-code sign-in runs as, in this page's memory: the form's `wait()`
 *  answers, one poll at a time (the SDK's own interval between them). */
function handleOf(flow: DeviceCodeSignInSession): SignInSessionHandle {
  return {
    browserOpened: true,
    wait: async (): Promise<SignInWait> => {
      const r = await flow.wait({ once: true });
      switch (r.kind) {
        case "pending":
          await new Promise((done) => setTimeout(done, r.interval * 1000));
          return { outcome: "pending" };
        case "choose":
          return {
            outcome: "choose",
            grant: r.grant,
            choices: r.choices as never,
            expiresIn: r.expiresIn,
          };
        case "signedIn":
          return { outcome: "signedIn" };
        case "cancelled":
          return { outcome: "cancelled" };
        case "expired":
          return { outcome: "expired" };
      }
    },
    reopen: () => flow.reopen(),
    cancel: () => flow.cancel(),
  };
}

/** The first `n` non-empty lines of a summary (plain text: it never executes markup). */
function summaryLines(summary: string | null | undefined, n = 3): string {
  return (summary ?? "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, n)
    .join("\n");
}

/**
 * The controller behind a driven gate. `attach()` starts the client and listens; `detach()` stops
 * listening and disposes the client a tick later unless the gate is attached again first (a node
 * moved in the document). `act` takes a control's copy key, `edit` a field's value.
 */
export class GateDriver {
  private step: GateStep = "home";
  private key = "";
  private submitted = false;
  private handle: OidcSignInHandle | null = null;
  private dismissed: unknown = null;
  private opener: string | null = null;
  private secondsLeft: number | undefined;
  private found: { version: string; url: string } | null = null;
  private notes: ReleaseNoteInput[] = [];
  private releaseUrl: string | undefined;
  private skipped = false;
  private asked = false;
  private pushed = false;
  private skipPop = false;
  private awaitingReturn = false;
  private attached = false;
  private disposal: ReturnType<typeof setTimeout> | null = null;
  private unsub: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private timerFor: number | undefined;
  private listeners = new Set<() => void>();
  private last: GateSnapshot | null = null;
  private lastState: PolarisState | null = null;
  private readonly options: GateDriverOptions;
  /** The license key a gate activation took, held in memory only (UK-42): for the portal hand-off
   *  while Identity is off. Never in a snapshot or a view's input, never logged, never stored; it
   *  is dropped when the person leaves ActivateDone, cancels or the gate detaches. */
  private heldKey: string | null = null;
  /** A key activation is in flight: the state it causes must not end the Done step. */
  private activating = false;
  private addModel: AddToAccountModel | null = null;
  private addUnsub: (() => void) | null = null;
  private addSession: SignInSessionHandle | null = null;
  /** Where AddToAccount opened from: ActivateDone, or a screen of the app (the settings row). */
  private addFrom: GateStep = "home";

  constructor(
    readonly adapter: PolarisAdapter,
    options: GateDriverOptions = {},
  ) {
    this.options = { ...options };
  }

  /** The locale the grace date reads in (it can change after construction). */
  setLocale(locale: string | undefined): void {
    if (this.options.locale === locale) return;
    if (locale === undefined) delete this.options.locale;
    else this.options.locale = locale;
    this.changed();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The gate as it stands now (the same object until something changes). */
  snapshot(): GateSnapshot {
    const state = this.adapter.snapshot();
    if (!this.last || this.lastState !== state) {
      this.lastState = state;
      this.last = this.build(state);
    }
    return this.last;
  }

  private changed(): void {
    this.last = null;
    for (const l of [...this.listeners]) l();
  }

  private build(state: PolarisState): GateSnapshot {
    const input = gateInput(state, {
      step: this.step,
      key: this.key,
      submitted: this.submitted,
      handle: this.handle,
      secondsLeft: this.secondsLeft,
      dismissed: this.dismissed,
      deviceKind: this.options.deviceKind ?? "device",
      ...(this.addModel
        ? { addToAccount: this.addModel.input().addToAccount }
        : {}),
      ...(this.options.locale !== undefined
        ? { locale: this.options.locale }
        : {}),
    });
    const offered = this.found && !this.skipped ? this.found : null;
    const update: UpdateOffer | null = offered
      ? {
          version: offered.version,
          url: offered.url,
          notes: this.notes,
          ...(this.releaseUrl ? { releaseUrl: this.releaseUrl } : {}),
        }
      : null;
    const version = this.options.version;
    const updateInput: UiInput | null = update
      ? {
          update: { action: "binary", version: update.version },
          ...(version
            ? {
                bundle: { slug: this.options.product ?? "", version },
              }
            : {}),
          ...(update.notes.length > 0 ? { releaseNotes: update.notes } : {}),
        }
      : null;
    return {
      input,
      step: this.step,
      opener: this.opener,
      update,
      updateInput,
    };
  }

  // ── lifetime ────────────────────────────────────────────────────────────────────────────

  /** Start the client and listen to it and to the page. Safe to call again. */
  attach(): void {
    if (this.disposal !== null) {
      clearTimeout(this.disposal);
      this.disposal = null;
    }
    if (this.attached) return;
    this.attached = true;
    this.unsub = this.adapter.subscribe((state) => {
      this.onState(state);
      this.changed();
    });
    (this.adapter as { start?: () => void }).start?.();
    if (typeof window !== "undefined") {
      window.addEventListener("popstate", this.onPop);
      window.addEventListener("focus", this.onBack);
      document.addEventListener("visibilitychange", this.onBack);
    }
    this.onState(this.adapter.snapshot());
    this.changed();
  }

  /** Stop listening; the client is disposed a tick later unless `attach()` runs again. */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    this.unsub?.();
    this.unsub = null;
    this.handle?.cancel?.();
    this.handle = null;
    this.setTimer(undefined);
    this.dropHolder();
    if (typeof window !== "undefined") {
      window.removeEventListener("popstate", this.onPop);
      window.removeEventListener("focus", this.onBack);
      document.removeEventListener("visibilitychange", this.onBack);
    }
    this.disposal = setTimeout(() => {
      this.disposal = null;
      this.adapter.dispose();
    }, 0);
  }

  /** A sign-in that lands, or a license that holds, ends the flow's local steps; an identity
   *  failure ends the hand-off (the Welcome step shows it); Update is asked once it is on. */
  private onState(state: PolarisState): void {
    if (state.status !== "needs-activation" && state.phase !== "loading") {
      // ActivateDone and AddToAccount show over the license that just activated: only the person
      // leaves them (and a key activation in flight is about to land on Done).
      const holds = this.activating || isHolderStep(this.step);
      if (this.handle || (this.step !== "home" && !holds)) {
        this.handle?.cancel?.();
        this.handle = null;
        this.step = "home";
        this.pushed = false;
        this.setTimer(undefined);
      }
    } else if (state.error.identity && this.handle) {
      this.handle = null;
      this.step = "home";
      this.pushed = false;
      this.setTimer(undefined);
    }
    if (!this.asked && state.capabilities.update.enabled) {
      this.asked = true;
      void this.checkUpdate();
    }
  }

  /** Asked once the SDK knows the product publishes updates (not at first paint). The offered
   *  version's changelog entry supplies the summary and the release link (decision 1). */
  private async checkUpdate(): Promise<void> {
    try {
      const v = await this.adapter.checkUpdate();
      if (!v.updateAvailable || !this.attached) return;
      this.found = { version: v.version, url: v.url };
      this.changed();
    } catch {
      return;
    }
    try {
      const list = await this.adapter.changelog();
      const entry =
        list.find((e) => e.version === this.found?.version) ?? undefined;
      if (!entry || !this.attached) return;
      const notes = summaryLines(entry.summary);
      this.notes = notes
        ? [
            {
              version: entry.version,
              date: entry.date ?? "",
              notes,
            },
          ]
        : [];
      this.releaseUrl = safeLink(entry.url) ?? undefined;
      this.changed();
    } catch {
      // Release off or refused: the prompt draws without "What's new".
    }
  }

  // ── the hand-off countdown (DL14: at 0:00 the view goes to expired while any poll finishes) ──

  private setTimer(expiresAt: number | undefined): void {
    if (
      expiresAt === this.timerFor &&
      (this.timer !== null) === (expiresAt !== undefined)
    )
      return;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.timerFor = expiresAt;
    if (expiresAt === undefined) {
      this.secondsLeft = undefined;
      return;
    }
    const tick = (): void => {
      this.secondsLeft = expiresAt - Date.now() / 1000;
      this.changed();
    };
    this.secondsLeft = expiresAt - Date.now() / 1000;
    this.timer = setInterval(tick, 1000);
  }

  // ── the platform's Back steps back through the gate: each step past Welcome is one entry ─────

  private toHome(): void {
    this.dropHolder();
    this.handle?.cancel?.();
    this.handle = null;
    this.setTimer(undefined);
    this.step = "home";
    this.dismissed = this.adapter.snapshot().error.license;
    this.submitted = false;
    this.changed();
  }

  private enter(next: GateStep, from: string): void {
    this.opener = from;
    this.step = next;
    if (typeof history !== "undefined" && !this.pushed) {
      try {
        history.pushState({ ...(history.state ?? {}), pkGate: next }, "");
        this.pushed = true;
      } catch {
        // A sandboxed frame has no history: Back still works on screen.
      }
    }
    this.changed();
  }

  private leave(): void {
    this.toHome();
    if (this.pushed) {
      this.pushed = false;
      this.skipPop = true;
      try {
        history.back();
      } catch {
        this.skipPop = false;
      }
    }
  }

  private onPop = (): void => {
    if (this.skipPop) {
      this.skipPop = false;
      return;
    }
    if (!this.pushed) return;
    this.pushed = false;
    this.toHome();
  };

  /** "Replace a device" opened the portal: the key is tried again when the person comes back. */
  private onBack = (): void => {
    if (!this.awaitingReturn || document.visibilityState === "hidden") return;
    this.awaitingReturn = false;
    const k = this.key.trim();
    if (k) void this.adapter.submitKey(k).catch(() => undefined);
  };

  // ── activation without an account (UK-42): Done, AddToAccount, the portal ───────────────

  /** Leave Done and AddToAccount: what they held is spent. */
  private dropHolder(): void {
    this.heldKey = null;
    this.addUnsub?.();
    this.addUnsub = null;
    const m = this.addModel;
    this.addModel = null;
    const h = this.addSession;
    this.addSession = null;
    if (m) void m.cancel().catch(() => {});
    if (h) void Promise.resolve(h.cancel()).catch(() => {});
  }

  /** A key activated here: the gate shows ActivateDone with the key held in memory. */
  private keyActivated(key: string): void {
    this.heldKey = key;
    this.key = "";
    this.submitted = false;
    this.dismissed = this.adapter.snapshot().error.license;
    this.enter("done", "activate.submit");
  }

  /** Start using the app (Done's primary, and "continue without an account"): the gate closes
   *  its steps and the key is dropped. */
  private finish(): void {
    this.dropHolder();
    this.step = "home";
    this.key = "";
    this.submitted = false;
    this.opener = null;
    this.setTimer(undefined);
    if (this.pushed) {
      this.pushed = false;
      this.skipPop = true;
      try {
        history.back();
      } catch {
        this.skipPop = false;
      }
    }
    this.changed();
  }

  /** The product page, with the key as the `#key=` fragment when one is held: the one place the
   *  key leaves memory. A fragment never reaches a server or a log, and only a link that passes
   *  `safeLink` opens. Used where Identity is off, so there is no account sign-in to run. */
  private async openPortal(): Promise<void> {
    let core: unknown;
    try {
      core = (await this.adapter.discovery())?.core;
    } catch {
      core = undefined;
    }
    const link = portalLink({
      portal: parsePortal(core),
      baseUrl: this.options.baseUrl ?? `https://${ISSUER}`,
      product: this.options.product ?? "",
    });
    if (link)
      openManage(link, this.options.returnUrl, this.heldKey ?? undefined);
  }

  /** Add your name and email: with Identity on, AddToAccount; with it off, the portal. */
  private addToAccount(): void {
    if (!this.adapter.snapshot().capabilities.identity.enabled) {
      void this.openPortal();
      return;
    }
    if (this.step === "add") return;
    this.dropAdd();
    this.addFrom = this.step;
    this.addModel = new AddToAccountModel({
      driver: this.accountDriver(),
      deviceKind: this.options.deviceKind ?? "device",
    });
    this.addUnsub = this.addModel.store.subscribe(() => {
      this.changed();
    });
    this.enter("add", "activate.recommend.action");
  }

  private dropAdd(): void {
    this.addUnsub?.();
    this.addUnsub = null;
    this.addModel = null;
  }

  /** AddToAccount's three calls over the SDK. The primitives load with the form, never at boot;
   *  `start` runs the sign-in in this page (a device-code session, hints and the app's license
   *  choice), so its answer comes back here and the license is kept and attached in order. */
  private accountDriver(): AddToAccountDriver {
    const ready = this.primitives().then(async (p) => {
      const { driverOf } = await import("../addToAccountModel.js");
      return driverOf(p);
    });
    return {
      signIn: async (hints) => (await ready).signIn(hints),
      complete: async (grant, choice) => (await ready).complete(grant, choice),
      attach: async () => (await ready).attach(),
    };
  }

  /** The SDK's calls as the form's primitives, with `start` running in this page. */
  private async primitives(): Promise<SignInPrimitives> {
    const { primitivesOf } = await import("./sdk/autoPrimitives.js");
    return {
      ...primitivesOf(
        this.adapter,
        () => undefined,
        () => false,
      ),
      start: async (o) => {
        const flow = await this.adapter.signIn.start({
          channel: "device-code",
          ...(o.licenseChoice === "app"
            ? { licenseChoice: "app" as const }
            : {}),
          ...(o.hints?.loginHint ? { loginHint: o.hints.loginHint } : {}),
          ...(o.hints?.nameHint ? { nameHint: o.hints.nameHint } : {}),
          ...(o.hints?.purpose ? { purpose: o.hints.purpose } : {}),
        });
        void flow.reopen();
        const h = handleOf(flow);
        this.addSession = h;
        return h;
      },
    };
  }

  /** "Sign in to that account" on a license-owned refusal: sign in in this page, and when the
   *  sign-in has a license choice due, complete it with the key that was entered (D17): the license
   *  joins the account and no list is shown. The key is held in memory for this call only. Where the
   *  page cannot run the sign-in itself (a cookie page), the gate's own sign-in runs as before. */
  private ownedSignIn(): void {
    const key = this.key.trim();
    void (async () => {
      let p: SignInPrimitives;
      let h: SignInSessionHandle;
      try {
        p = await this.primitives();
        h = await p.start({ channel: "browser", licenseChoice: "app" });
      } catch {
        this.signIn();
        return;
      }
      try {
        for (;;) {
          const r = await h.wait();
          if (r.outcome === "pending") continue;
          if (r.outcome === "choose" && key && p.choice) {
            const c: ChoiceComplete = await p.choice.complete(r.grant, {
              kind: "key",
              key,
            });
            // Anything but signed in leaves the refusal on screen; the person can try again.
            if (c.outcome === "signedIn") this.finish();
          }
          return;
        }
      } catch {
        return;
      } finally {
        if (this.addSession === h) this.addSession = null;
      }
    })();
  }

  // ── the controls ────────────────────────────────────────────────────────────────────────

  private signIn(): void {
    void Promise.resolve(this.adapter.signInWithOidc())
      .then((started) => {
        // The cookie page navigates away and never gets here; a bearer page or a desktop host
        // that reports a code hands back what to show.
        if (
          started &&
          (started.userCode || safeLink(started.verificationUrl))
        ) {
          this.handle = started;
          this.setTimer(started.expiresAt);
          this.enter("handoff", "welcome.signIn");
        }
      })
      .catch(() => undefined);
  }

  /** A control was pressed: its copy key. */
  act(key: string): void {
    const state = this.adapter.snapshot();
    switch (key) {
      case "welcome.signIn":
      case "signin.again":
      case "signin.handoff.again":
      case "signInHandoff.newCode":
        this.handle?.cancel?.();
        this.signIn();
        return;
      case "welcome.useKey":
      case "signin.choice.keyInstead":
        this.enter("activate", key);
        return;
      case "signin.key.differentKey":
        // From a refusal: back to the key field with the refused key still in it.
        this.dismissed = state.error.license;
        this.submitted = false;
        if (this.step === "activate") {
          this.changed();
          return;
        }
        this.enter("activate", key);
        return;
      case "common.paste":
        void navigator.clipboard
          ?.readText()
          .then((t) => {
            this.key = t.trim();
            this.submitted = false;
            this.dismissed = this.adapter.snapshot().error.license;
            this.changed();
          })
          .catch(() => undefined);
        return;
      case "activate.submit": {
        this.submitted = true;
        const v = this.key.trim();
        if (v) {
          this.activating = true;
          void this.adapter
            .submitKey(v)
            .then(() => {
              this.activating = false;
              // No account: the license is floating, held by the key alone. ActivateDone.
              if (this.attached) this.keyActivated(v);
            })
            .catch(() => {
              this.activating = false;
              this.changed();
            });
        }
        this.changed();
        return;
      }
      case "signin.key.ownedSignIn":
        if (this.step === "add") {
          // The license is in an account already (AddToAccount's owned state): sign in to it.
          this.signIn();
          return;
        }
        this.ownedSignIn();
        return;
      case "activate.recommend.action":
        // ActivateDone's card, and AccountAndLicense's "Not in an account" row.
        this.addToAccount();
        return;
      case "activate.recommend.skip":
      case "signin.done.start":
        this.finish();
        return;
      case "activate.waitingSignIn":
        // The license waits for its email's account: the gate's own sign-in.
        this.signIn();
        return;
      case "common.continue":
        if (this.step === "add") void this.addModel?.submit();
        return;
      case "activate.otherEmail.verify":
      case "signin.auto.confirm.other":
        // A different email: back to the form with the fields kept.
        if (this.step === "add") void this.addModel?.cancel();
        return;
      case "deviceLimit.title":
      case "deviceLimit.primary":
      case "deviceLimit.openBrowser": {
        const url = state.error.license?.manageUrl;
        if (!url) return;
        this.awaitingReturn = true;
        openManage(url, this.options.returnUrl, this.key.trim() || undefined);
        return;
      }
      case "signin.handoff.openBrowser": {
        const url = safeLink(this.handle?.verificationUrl);
        if (url) openLink(url);
        return;
      }
      case "a11y.copyCode": {
        const code = this.handle?.userCode;
        if (code) void navigator.clipboard?.writeText(code).catch(() => {});
        return;
      }
      case "a11y.copyAddress":
      case "signin.handoff.copyLink": {
        const url = safeLink(
          this.handle?.verificationUri ?? this.handle?.verificationUrl,
        );
        if (url) void navigator.clipboard?.writeText(url).catch(() => {});
        return;
      }
      case "common.cancel":
      case "common.back":
        if (this.step === "add" && this.addFrom === "done") {
          // AddToAccount's Cancel goes back to ActivateDone, the key still held.
          this.dropAdd();
          this.step = "done";
          this.changed();
          return;
        }
        this.leave();
        return;
      case "common.tryAgain":
        if (this.step === "add") {
          void this.addModel?.tryAgain();
          return;
        }
        void this.adapter.refresh({ force: true }).catch(() => undefined);
        return;
      case "common.reconnect":
        void this.adapter.refresh({ force: true }).catch(() => undefined);
        return;
      case "common.signOut":
        void this.adapter.signOut().catch(() => undefined);
        return;
    }
  }

  /** A field changed: the key field, or AddToAccount's `name` and `email` (held by its model). */
  edit(field: string, value: string): void {
    if (field === "name" || field === "email") {
      this.addModel?.setField(field, value);
      return;
    }
    if (field !== "key") return;
    this.key = value;
    this.submitted = false;
    // Editing the key clears the refusal (DL7).
    this.dismissed = this.adapter.snapshot().error.license;
    this.changed();
  }

  /** A control on the update prompt: Update now opens the build's address; Later puts it off. */
  actUpdate(key: string): void {
    if (key === "update.install" || key === "update.restartWhenReady") {
      const url = safeLink(this.found?.url);
      if (url) openLink(url);
    } else if (key === "update.allChanges") {
      const url = this.releaseUrl ?? safeLink(this.found?.url);
      if (url) openLink(url);
    } else if (key === "update.later" || key === "update.skipVersion") {
      this.skipped = true;
      this.changed();
    }
  }
}
