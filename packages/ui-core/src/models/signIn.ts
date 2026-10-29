// The signIn family (ui-matrix.json `signIn`): the one sign-in form of SIGN-IN.md §3.17, whose
// body morphs in place through methods → handoff | code → finishing → choose ↔ replace | key →
// done (plans/I-04.md §G). SignIn is the form; SignInHandoff draws its step 2 (Finish in your
// browser, the device code); LicenseChoice its step 3 (with Replace a device). These are pure
// functions of the session; `SignInModel` (../signInModel.ts) is the state machine that drives
// the SDK primitives and feeds them.
//
// Precedence, where several states could hold (ui-matrix.json `vocabulary.precedence`):
//
//   SignIn          error, auto (an automatic sign-in step), expired, done, key, replace, choose,
//                   finishing, code, handoff, methods
//   LicenseChoice   loading, grant-expired, raced, replace-open, none-keys | none-no-keys, new,
//                   create, all-full, keep, current, mixed, one, many
//
// A `browser` presentation or a device-code sign-in never reaches choose, replace or a
// LicenseChoice state (D4): the card chooses. `replace: "browser"` never opens the device list in
// the app; Replace opens the card instead (`replace-in-browser`).

import { activationCopy } from "../errors.js";
import {
  platformClass,
  systemConfirm,
  type AutoSignInInput,
  type Context,
  type LicenseChoiceRow,
} from "../input.js";
import {
  DEVICE_CODE_PAGE,
  SIGN_IN_PROVIDER_NAME,
  TV_CODE_PAGE,
} from "@polaris-key/protocol/core";
import { codeExpired, countdown, linkVerdict, validLink } from "../link.js";
import { loadingVisible } from "../loading.js";
import { activateDoneView, addToAccountView } from "./holders.js";
import { keyRefusalOf, keyRefusalSpec } from "./keyRefusal.js";
import {
  choosesInApp,
  DEFAULT_PROVIDER,
  methodsCopy,
  methodsPrimary,
  methodsView,
  signInOn,
  type SignInState,
} from "./signInHandoff.js";
export {
  signInHandoffView,
  verificationUrl,
  type HandoffState,
  type SignInState,
} from "./signInHandoff.js";
import { hiddenView, identityText, makeView, type View } from "../view.js";

/** The one sign-in form. */
export function signInView(ctx: Context): View<"SignIn", SignInState> {
  const s = ctx.input.signIn;
  if (!signInOn(ctx) || !s) return hiddenView(ctx, "SignIn");
  const dc = ctx.input.deviceCode;
  const id = identityText(ctx);
  const provider = ctx.input.provider ?? DEFAULT_PROVIDER;
  const args = {
    product: id.name,
    app: id.name,
    provider,
    // The sign-in that failed is the one the methods step's first row started.
    method: provider,
  };
  const license = ctx.on("license");
  const error = ctx.input.error?.code;
  // A failed Continue (or Link) keeps its step on screen (autoStepView draws the network line).
  const confirmRetry =
    (error === "network" && ctx.input.autoSignIn?.step === "confirm") ||
    (ctx.input.autoSignIn?.step === "link-offer" &&
      (error === "network" ||
        error === "link-stale" ||
        error === "link-failed"));
  if (error && !confirmRetry) {
    const primary = methodsPrimary(ctx);
    // Sign-in errors sit under Sign in (DL7); the methods stay.
    return makeView(ctx, "SignIn", {
      state: "error",
      copy: [
        error === "sign-in-unavailable"
          ? "signIn.noMethods"
          : "signIn.methodError",
      ],
      args,
      primary,
      tone: "danger",
      errorSlot: primary,
    });
  }
  if (ctx.input.autoSignIn)
    return autoStepView(ctx, ctx.input.autoSignIn, {
      ...args,
      developer: id.developer ?? undefined,
      email: ctx.input.autoSignIn.email,
    });
  if (s.step) return holderStepView(ctx, s.step);
  if (
    s.outcome === "expired" ||
    (dc && (dc.phase === "expired" || codeExpired(dc.secondsLeft)))
  )
    return makeView(ctx, "SignIn", {
      state: "expired",
      copy:
        s.channel === "device-code"
          ? [
              "core.codes.sign-in-expired.title",
              "core.codes.sign-in-expired.message",
              "signin.again",
            ]
          : ["signin.handoff.tooLong", "signin.again"],
      args,
      primary: "signin.again",
      tone: "neutral",
    });
  if (s.outcome === "signedIn") {
    // How the form ends (SIGN-IN.md §3.17 item 4): Done when a license was added or issued now;
    // otherwise the form closes and the app opens with the toast. License off: no tier to name.
    const copy = !license
      ? ["signin.return.signedInShort"]
      : s.issuedNow
        ? [
            "signin.done.start",
            // One key for "You're signed in · Pro license", so no kit joins two with a separator.
            ctx.input.account?.tier
              ? "signin.return.signedInTier"
              : "signin.return.signedInShort",
          ]
        : ["signin.desktop.toast"];
    return makeView(ctx, "SignIn", {
      state: "done",
      copy,
      args: {
        ...args,
        name: ctx.input.account?.holder,
        tier: ctx.input.account?.tier,
      },
      primary: copy.includes("signin.done.start") ? "signin.done.start" : null,
      focus: copy.includes("signin.done.start") ? undefined : null,
    });
  }
  const inApp = choosesInApp(ctx);
  if (s.outcome === "choose" && inApp) {
    // Use a license key instead keeps the account: the key step is in the same form (Must not).
    if (s.event === "have-key" && license && ctx.caps.keyEntry) {
      const a = ctx.input.activation;
      const refusal = keyRefusalOf(a);
      // The refusals a different key cannot fix leave the field behind (DL6).
      if (a && refusal !== null) {
        const spec = keyRefusalSpec(ctx, refusal, a);
        return makeView(ctx, "SignIn", {
          state: "key-refused",
          copy: spec.copy,
          args,
          primary: spec.primary,
          tone: "neutral",
          link: spec.link,
          qr: spec.qr,
        });
      }
      return makeView(ctx, "SignIn", {
        state: "key",
        copy: [
          "signin.key.addTitle",
          "part.keyField.label",
          // `license_owned` never names the holder (S-16): only its core copy.
          ...(a && a.result !== "ok" ? activationCopy(a.result, a.code) : []),
        ],
        args: { ...args, code: a?.code },
        primary: "activate.submit",
        tone: a && a.result !== "ok" ? "neutral" : null,
        errorSlot: a && a.result !== "ok" ? "part.keyField.label" : null,
        focus: "part.keyField.label",
      });
    }
    if (
      s.event === "open-replace" &&
      s.replace === "inline" &&
      ctx.input.replaceView
    ) {
      const system = systemConfirm(ctx.platform, s.presentation);
      const rv = ctx.input.replaceView;
      const pick = rv.devices.find((d) => d.leastRecent) ?? rv.devices[0];
      return makeView(ctx, "SignIn", {
        state: "replace",
        copy: [
          "signin.replace.open",
          "signin.replace.lede",
          system ? "signin.replace.openSystem" : "signin.replace.title",
        ],
        args: { ...args, device: pick?.label ?? undefined },
        primary: system ? "signin.replace.openSystem" : "signin.replace.open",
      });
    }
    const desktop = platformClass(ctx.platform) === "desktop";
    return makeView(ctx, "SignIn", {
      state: "choose",
      copy: ["signin.choice.title", desktop && "signin.desktop.notifyChoose"],
      args,
      extraActions:
        s.event === "open-replace" && s.replace === "browser"
          ? ["replace-in-browser"]
          : [],
      // LicenseChoice draws the rows and Continue.
      primary: null,
      focus: null,
    });
  }
  if (s.redeeming || dc?.phase === "ok")
    return makeView(ctx, "SignIn", {
      state: "finishing",
      copy: ["signin.handoff.finishing", "a11y.busy"],
      args,
      focus: null,
    });
  if (s.channel === "device-code" || s.event === "use-code")
    // SignInHandoff draws the code view in the form's body.
    return makeView(ctx, "SignIn", {
      state: "code",
      copy: [],
      args,
      focus: null,
    });
  if (s.outcome === "pending")
    return makeView(ctx, "SignIn", {
      state: "handoff",
      copy: [
        "signin.handoff.title",
        "signin.handoff.browserBody",
        "signin.handoff.waiting",
        "signin.handoff.again",
        ctx.caps.deviceCode && "signin.handoff.useCode",
      ],
      args,
      primary: "signin.handoff.again",
    });
  // Cancel returns to step 1, with nothing else lost.
  return methodsView(ctx, args);
}

/** The form's steps after a key with no account (UK-42): the holders' screens in the form's body,
 *  under the form's own state names. Their copy, actions and decisions are the screens' own. */
function holderStepView(
  ctx: Context,
  step: "key-done" | "attach" | "added",
): View<"SignIn", SignInState> {
  const v =
    step === "key-done"
      ? activateDoneView(ctx)
      : addToAccountView(ctx, step === "added" ? "added" : undefined);
  // A screen that is hidden here (a service is off) leaves the form on its first step.
  if (v.state === "hidden") return hiddenView(ctx, "SignIn");
  return { ...v, component: "SignIn", state: step };
}

/** The provider's identity is per developer: Apple always, Google unless shared across apps. */
function perDeveloper(
  provider: string,
  reach: AutoSignInInput["reach"],
): boolean {
  return provider === "Apple" || reach !== "global";
}

/** Automatic sign-in's steps, drawn in the form's body (plans/auto-sign-in.md §3): confirm the
 *  account, offer to link the provider, and the nearby wait. Every outcome has a title that takes
 *  focus and one way on (Continue). */
function autoStepView(
  ctx: Context,
  auto: AutoSignInInput,
  args: Record<string, string | undefined>,
): View<"SignIn", SignInState> {
  const provider = ctx.input.provider ?? DEFAULT_PROVIDER;
  const view = (
    state: SignInState,
    copy: (string | false | undefined)[],
    o: {
      primary?: string | null;
      tone?: "neutral" | "danger";
      focus?: string | null;
    } = {},
  ) =>
    makeView(ctx, "SignIn", {
      state,
      copy,
      args: {
        ...args,
        provider,
        tier: ctx.input.account?.tier,
        code: auto.code,
        // The existing-license line's arguments (the kit words `term` itself, from its copy).
        license: auto.anchor?.name,
        device: auto.device,
        position:
          auto.anchor?.position !== undefined
            ? String(auto.anchor.position)
            : undefined,
        limit:
          auto.anchor?.limit !== undefined
            ? String(auto.anchor.limit)
            : undefined,
      },
      primary: o.primary ?? null,
      tone: o.tone ?? null,
      focus: o.focus === undefined ? "heading" : o.focus,
    });
  switch (auto.step) {
    case "confirm":
      return view(
        "confirm",
        [
          "signin.auto.confirm.title",
          auto.email ? "signin.auto.confirm.as" : "signin.auto.confirm.asApple",
          // What Continue does: the license this device gets, and what the app also receives.
          auto.license && "signin.consent.license",
          auto.license === "new" && "signin.consent.newLicense",
          auto.license === "existing" && "signin.consent.licenseLine",
          auto.alsoGets && "signin.consent.alsoGets",
          auto.alsoGets && "signin.consent.profile",
          auto.alsoGets && "signin.consent.pairwise",
          "signin.auto.confirm.primary",
          "signin.auto.confirm.other",
          // Continue failed on the network: the grant is still good, Continue tries again.
          ctx.input.error?.code === "network" && "core.codes.network.message",
        ],
        {
          primary: "signin.auto.confirm.primary",
          ...(ctx.input.error?.code === "network"
            ? { tone: "danger" as const }
            : {}),
        },
      );
    case "link-offer": {
      // Per developer: named when the developer is known, else the app and its developer's others.
      const body = !perDeveloper(provider, auto.reach)
        ? "signin.linkOffer.bodyGlobal"
        : args.developer
          ? "signin.linkOffer.bodyDeveloper"
          : "signin.linkOffer.bodyApp";
      // A failed Link keeps the offer and says why. Too old a sign-in swaps Link for Sign in
      // again; the handle lives on, so the next Link is one tap.
      const code = ctx.input.error?.code;
      const stale = code === "link-stale";
      const line =
        code === "network"
          ? "core.codes.network.message"
          : stale
            ? "signin.linkOffer.stale"
            : code === "link-failed" && "signin.linkOffer.failed";
      // Retrying cannot fix a refused device: Link goes, and No thanks is the way on.
      const refused = code === "link-failed";
      const primary = stale
        ? "signin.again"
        : refused
          ? "signin.linkOffer.decline"
          : "signin.linkOffer.primary";
      return view(
        "link-offer",
        [
          "signin.linkOffer.title",
          body,
          !refused && primary,
          "signin.linkOffer.decline",
          line,
        ],
        { primary, ...(line ? { tone: "danger" as const } : {}) },
      );
    }
    case "link-done":
      return view("link-done", ["signin.linkOffer.done", "common.done"], {
        primary: "common.done",
      });
    case "link-conflict":
      return view(
        "link-conflict",
        [
          "signin.linkOffer.conflictTitle",
          "signin.linkOffer.conflict",
          "signin.linkOffer.join",
          "common.done",
        ],
        { primary: "common.done", tone: "neutral" },
      );
    case "nearby-prompt":
      return view(
        "nearby-prompt",
        [
          "signin.nearby.promptTitle",
          "signin.nearby.prePrompt",
          "common.continue",
          "common.notNow",
        ],
        { primary: "common.continue" },
      );
    case "nearby-wait":
      return view("nearby-wait", [
        "signin.nearby.title",
        "signin.nearby.body",
        "signin.nearby.match",
        auto.code && "a11y.nearbyCode",
        "signin.nearby.code",
      ]);
    case "device-limit": {
      // A device limit with no license rows, reached from automatic sign-in or a provider
      // sign-in: its own step, never the key screen. Replace opens the refusal's `manageUrl`.
      const link = linkVerdict(auto.manageUrl, ctx.platform, "replace-device");
      const replace = link.url !== null;
      return makeView(ctx, "SignIn", {
        state: "device-limit",
        copy: [
          "core.codes.device_limit.title",
          // The refusal's message tells the person to replace a device: with no link there is
          // one instruction only, to sign out on another device (`deviceLimit.noManage`).
          replace && "core.codes.device_limit.message",
          replace ? "signin.deviceLimit.replace" : "deviceLimit.noManage",
          replace && "a11y.externalLink",
          "signin.auto.confirm.other",
          "common.cancel",
        ],
        args: { ...args, provider },
        primary: replace ? "signin.deviceLimit.replace" : null,
        tone: "neutral",
        focus: "heading",
        link,
        extraActions: replace ? ["open-manage-url"] : [],
      });
    }
    case "nearby-done":
      return view(
        "nearby-done",
        ["signin.nearby.done", "common.continue", "signin.nearby.notYou"],
        { primary: "common.continue" },
      );
  }
}

// ── LicenseChoice ──────────────────────────────────────────────────────────────────────────────

export type LicenseChoiceState =
  | "loading"
  | "many"
  | "one"
  | "current"
  | "keep"
  | "new"
  | "create"
  | "all-full"
  | "mixed"
  | "replace-open"
  | "raced"
  | "none-keys"
  | "none-no-keys"
  | "grant-expired"
  | "hidden";

/** A license's origin in plain words (SIGN-IN.md O-17); `purchase` needs none. Keys whose
 *  facts `LicenseChoice` does not carry (a key's last six, a gift, an organization) wait for the
 *  packages that add them. */
const ORIGIN_KEY: Readonly<Record<string, string>> = {
  store: "signin.choice.origin.store",
  key: "signin.choice.origin.keyAdded",
  free: "signin.choice.origin.free",
  developer: "signin.choice.origin.developer",
  signin: "signin.choice.origin.signIn",
};

/** Step 3 of the form: choose a license for this device. */
export function licenseChoiceView(
  ctx: Context,
): View<"LicenseChoice", LicenseChoiceState> {
  const s = ctx.input.signIn;
  if (
    !signInOn(ctx) ||
    !ctx.on("license") ||
    !s ||
    !choosesInApp(ctx) ||
    s.outcome !== "choose"
  )
    return hiddenView(ctx, "LicenseChoice");
  const id = identityText(ctx);
  const args = { product: id.name, developer: id.developer ?? id.name };
  if (ctx.input.loading)
    return makeView(ctx, "LicenseChoice", {
      state: "loading",
      copy: loadingVisible(ctx.input.elapsedMs)
        ? ["signin.choice.title", "common.loading"]
        : [],
      args,
      focus: null,
    });
  if (s.grantExpired)
    return makeView(ctx, "LicenseChoice", {
      state: "grant-expired",
      copy: ["signin.handoff.tooLong", "signin.again"],
      args,
      primary: "signin.again",
      tone: "neutral",
    });
  const view = ctx.input.choices;
  if (!view)
    return makeView(ctx, "LicenseChoice", {
      state: "loading",
      copy: ["signin.choice.title", "common.loading"],
      args,
      focus: null,
    });
  const replaceBrowser = s.event === "open-replace" && s.replace === "browser";
  const extraActions = replaceBrowser ? (["replace-in-browser"] as const) : [];
  const full = view.choices.filter((r) => r.state !== "free");
  const replaceable = full.find((r) => r.replace?.allowed);
  const replaceLink = linkVerdict(
    replaceable?.freeDeviceUrl,
    ctx.platform,
    "replace-device",
  );
  if (s.raced)
    return makeView(ctx, "LicenseChoice", {
      state: "raced",
      copy: [
        s.event === "confirm-replace"
          ? "signin.replace.raced"
          : "signin.choice.raced",
      ],
      args,
      primary: "signin.choice.continue",
      tone: "neutral",
    });
  if (
    s.event === "open-replace" &&
    s.replace === "inline" &&
    ctx.input.replaceView
  ) {
    const rv = ctx.input.replaceView;
    const pick = rv.devices.find((d) => d.leastRecent) ?? rv.devices[0];
    return makeView(ctx, "LicenseChoice", {
      state: "replace-open",
      copy: [
        "signin.replace.title",
        "signin.replace.open",
        "signin.replace.confirm",
        "signin.replace.consequence",
        "signin.replace.back",
      ],
      args: { ...args, device: pick?.label ?? undefined },
      primary: "signin.replace.confirm",
    });
  }
  if (view.state === "none") {
    const get = view.getLicense;
    if (get?.keyEntry && ctx.caps.keyEntry)
      return makeView(ctx, "LicenseChoice", {
        state: "none-keys",
        copy: [
          "signin.none.title",
          "signin.none.body",
          "signin.choice.keyInstead",
        ],
        args,
        primary: "signin.choice.keyInstead",
      });
    const purchase = linkVerdict(get?.purchaseUrl, ctx.platform, "purchase");
    return makeView(ctx, "LicenseChoice", {
      state: "none-no-keys",
      copy: [
        "signin.none.title",
        "signin.none.body",
        purchase.url !== null && "signin.none.get",
        "signin.none.otherAccount",
      ],
      args,
      primary:
        purchase.url !== null ? "signin.none.get" : "signin.none.otherAccount",
      link: purchase.url !== null ? purchase : null,
    });
  }
  if (view.state === "autoIssue")
    return makeView(ctx, "LicenseChoice", {
      state: "new",
      copy: [
        "signin.choice.ledeNew",
        "signin.choice.metaNew",
        "signin.choice.tag.new",
      ],
      args: { ...args, tier: view.create?.tierName },
      primary: "signin.choice.continue",
    });
  if ((ctx.input.selected ?? view.preselected) === "create" && view.create)
    return makeView(ctx, "LicenseChoice", {
      state: "create",
      copy: ["signin.choice.create", "signin.choice.createMeta"],
      args: { ...args, tier: view.create.tierName },
      primary: "signin.choice.continue",
    });
  const free = view.choices.filter((r) => r.state === "free");
  if (free.length === 0 && !view.keep)
    // A full license is a limit, not an error (DL6): its fix is the primary.
    return makeView(ctx, "LicenseChoice", {
      state: "all-full",
      copy: [
        "signin.choice.tag.full",
        view.create
          ? "signin.choice.allFullCreate"
          : replaceable
            ? "signin.choice.allFull"
            : "signin.choice.noneReplaceable",
      ],
      args,
      extraActions,
      primary: view.create
        ? "signin.choice.create"
        : replaceable
          ? "signin.replace.open"
          : null,
      tone: "neutral",
      link: replaceBrowser ? replaceLink : null,
    });
  if (view.keep)
    // Keep is its own row and outcome: never blurred with create or a new license (Must not).
    return makeView(ctx, "LicenseChoice", {
      state: "keep",
      copy: ["signin.choice.keep", "signin.choice.keepMeta"],
      args,
      extraActions,
      primary: "signin.choice.continue",
    });
  if (view.choices.some((r) => r.current))
    return makeView(ctx, "LicenseChoice", {
      state: "current",
      copy: ["signin.choice.tag.current"],
      args,
      extraActions,
      primary: "signin.choice.continue",
    });
  const access = new Set(view.choices.map((r) => r.access));
  if (access.has("account") && access.has("seats"))
    return makeView(ctx, "LicenseChoice", {
      state: "mixed",
      // `signin.choice.combined` waits for an SDK result that carries the entitlement model.
      copy: [],
      args,
      extraActions,
      primary: "signin.choice.continue",
    });
  if (view.choices.length === 1)
    return makeView(ctx, "LicenseChoice", {
      state: "one",
      copy: [
        "signin.choice.title",
        "signin.choice.lede",
        "signin.choice.continue",
      ],
      args: { ...args, tier: view.choices[0]!.tierName },
      extraActions,
      primary: "signin.choice.continue",
    });
  return makeView(ctx, "LicenseChoice", {
    state: "many",
    copy: [
      "signin.choice.title",
      "signin.choice.lede",
      "signin.choice.group",
      "signin.choice.meta",
      "signin.choice.devices",
      "signin.choice.continue",
      ...rowCopy(view.choices),
    ],
    args,
    extraActions,
    primary: "signin.choice.continue",
  });
}

/** The origin and term keys the rows' meta lines use. */
function rowCopy(rows: readonly LicenseChoiceRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const origin = ORIGIN_KEY[r.origin];
    if (origin) out.push(origin);
    out.push(
      r.expiresAt === null ? "signin.term.lifetime" : "signin.term.until",
    );
  }
  return out;
}
