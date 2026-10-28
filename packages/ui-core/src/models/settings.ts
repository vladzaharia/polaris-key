// The settings and paywall families (ui-matrix.json `settings`, `paywall`): AccountAndLicense,
// Settings, Paywall and EntitlementGate, and the should-tier About and
// ChannelPicker (CloudSyncStatus is in cloudSync.ts). A floating license is never silently attached to an account; a theme never
// reveals a hidden value; the paywall never invents checkout; a style override is never
// authorization.

import type { Context } from "../input.js";
import { platformClass } from "../input.js";
import { linkVerdict } from "../link.js";
import { loadingVisible } from "../loading.js";
import { hiddenView, identityText, makeView, type View } from "../view.js";

// ── AccountAndLicense ──────────────────────────────────────────────────────────────────────────

export type AccountState = "loading" | "signed-in" | "key-only" | "offline";

/** The settings pane for the license and the account. */
export function accountView(
  ctx: Context,
): View<"AccountAndLicense", AccountState> {
  const id = identityText(ctx);
  const args = { product: id.name, developer: id.developer ?? undefined };
  if (ctx.input.loading)
    return makeView(ctx, "AccountAndLicense", {
      state: "loading",
      copy: loadingVisible(ctx.input.elapsedMs)
        ? ["account.title", "common.loading"]
        : [],
      args,
      focus: null,
    });
  if (ctx.on("license") && ctx.input.gate?.status === "grace")
    return makeView(ctx, "AccountAndLicense", {
      state: "offline",
      copy: ["account.offline", "part.status.grace"],
      args,
    });
  const account = ctx.input.account;
  const license = ctx.on("license");
  const update = ctx.on("update");
  // A floating license shows no holder: it is never attached to an account behind the person's
  // back (Must not), and the holder is only ever the account signed in on this device (S-19).
  if (!ctx.on("identity") || !account?.signedIn) {
    // A floating license (the holder is known and has no email, UK-42) says so, and offers Add your
    // name and email: with Identity off that opens the portal. A license waiting for an email
    // keeps the key-only line.
    const holder = ctx.input.licenseHolder;
    const floating = license && !!holder && !holder.email;
    return makeView(ctx, "AccountAndLicense", {
      state: "key-only",
      copy: [
        "account.title",
        license && "account.tier",
        license && !floating && "account.keyOnly",
        floating && "account.notInAccount",
        floating && "activate.recommend.action",
        update && "account.updates",
        "common.signOut",
      ],
      args: { ...args, tier: account?.tier },
    });
  }
  return makeView(ctx, "AccountAndLicense", {
    state: "signed-in",
    copy: [
      "account.title",
      license && "account.tier",
      "account.holder",
      account.canManage !== false && "common.manage",
      account.canManage !== false && "a11y.externalLink",
      license && "account.devices",
      ctx.on("sync") && "account.cloudSync",
      update && "account.updates",
      update && "account.autoUpdate",
      update && "account.channel",
      update && "update.checkNow",
      "account.version",
      ctx.on("config") && "account.managedSettings",
      "common.signOut",
      ctx.input.integrator?.poweredBy !== undefined && "part.poweredBy",
    ],
    args: {
      ...args,
      name: account.holder,
      tier: account.tier,
      version: ctx.input.bundle?.version,
    },
  });
}

// ── Settings ───────────────────────────────────────────────────────────────────────────────────

export type SettingsState =
  | "loading"
  | "list"
  | "dirty"
  | "saving"
  | "locked"
  | "error"
  | "hidden";

/** Settings rows are shown with a search field above this many (UI-KITS.md §4.1). */
export const SETTINGS_SEARCH_ABOVE = 12;

/** The sources a row's provenance names in text (`settings.source.*`). */
const SOURCES = new Set(["default", "local", "env"]);

/** Config-catalog-driven settings with typed controls and provenance as text. */
export function settingsView(ctx: Context): View<"Settings", SettingsState> {
  if (!ctx.on("config")) return hiddenView(ctx, "Settings");
  const { config, edit, error, pending } = ctx.input;
  const id = identityText(ctx);
  const args = { developer: id.developer ?? id.name };
  if (ctx.input.loading)
    return makeView(ctx, "Settings", {
      state: "loading",
      copy: loadingVisible(ctx.input.elapsedMs)
        ? ["settings.title", "common.loading"]
        : [],
      args,
      focus: null,
    });
  if (error) {
    const save = edit?.kind === "value";
    return makeView(ctx, "Settings", {
      state: "error",
      copy: [
        save ? "settings.error" : "settings.loadFailed",
        "common.tryAgain",
      ],
      args,
      primary: "common.tryAgain",
      tone: "danger",
      errorSlot: save ? "common.save" : "screen",
    });
  }
  if (pending === "save" || ctx.input.saved)
    return makeView(ctx, "Settings", {
      state: "saving",
      copy: [pending === "save" ? "settings.saving" : "settings.saved"],
      args,
      primary: "common.save",
      focus: pending === "save" ? undefined : null,
    });
  if (edit?.kind === "value")
    return makeView(ctx, "Settings", {
      state: "dirty",
      copy: ["settings.unsaved", "common.save"],
      args,
      primary: "common.save",
      focus: null,
    });
  const rows = config ?? [];
  const locked = rows.find((r) => r.locked);
  if (locked)
    // A locked row names who set it: the organization, or the platform's guardian controls. A
    // host's own reason is the host's string, never invented here.
    return makeView(ctx, "Settings", {
      state: "locked",
      copy: [
        locked.org ? "settings.setBy" : "settings.setByGuardian",
        "a11y.locked",
      ],
      args: { ...args, org: locked.org },
    });
  if (rows.length === 0)
    return makeView(ctx, "Settings", {
      state: "list",
      copy: ["settings.title", "settings.empty"],
      args,
    });
  // The theme decides nothing here: the rows are what config.list returned (Must not).
  return makeView(ctx, "Settings", {
    state: "list",
    copy: [
      "settings.title",
      rows.length > SETTINGS_SEARCH_ABOVE && "settings.search",
      rows.some((r) => r.source === "default") && "settings.fromDeveloper",
      ...rows
        .map((r) => r.source)
        .filter((s) => SOURCES.has(s))
        .map((s) => `settings.source.${s}`),
      rows.some((r) => r.source === "local") && "settings.reset",
      rows.some((r) => r.advanced) && "settings.advanced",
      rows.some(
        (r) =>
          r.type === "number" && r.min !== undefined && r.max !== undefined,
      ) && "settings.range",
      rows.some((r) => r.type === "boolean") && "settings.on",
      rows.some((r) => r.type === "boolean") && "settings.off",
    ],
    args,
  });
}

// ── Paywall ────────────────────────────────────────────────────────────────────────────────────

export type PaywallState =
  | "loading"
  | "offers"
  | "purchasing"
  | "purchased"
  | "restore"
  | "not-available"
  | "hidden";

/** True where the platform's own store sells the offer in the app (StoreKit, Play Billing). */
function storePurchase(ctx: Context): boolean {
  return (
    ctx.caps.purchase &&
    (ctx.platform?.os === "ios" || ctx.platform?.os === "android") &&
    platformClass(ctx.platform) === "handheld"
  );
}

/** Entitlement-gated upsell: the platform's store, or the portal; never an invented checkout. */
export function paywallView(ctx: Context): View<"Paywall", PaywallState> {
  if (!ctx.on("license")) return hiddenView(ctx, "Paywall");
  const offers = ctx.input.offers;
  const args = {
    product: identityText(ctx).name,
    tier: ctx.input.entitlement?.tier,
  };
  if (ctx.input.loading)
    return makeView(ctx, "Paywall", {
      state: "loading",
      copy: loadingVisible(ctx.input.elapsedMs) ? ["common.loading"] : [],
      args,
      focus: null,
    });
  const buy = storePurchase(ctx) ? "paywall.upgrade" : "paywall.portal";
  if (ctx.input.pending === "purchase")
    return makeView(ctx, "Paywall", {
      state: "purchasing",
      copy: ["paywall.purchasing", "a11y.busy"],
      args,
      primary: buy,
    });
  if (ctx.input.pending === "restore")
    return makeView(ctx, "Paywall", {
      state: "restore",
      copy: ["paywall.restore"],
      args,
      focus: null,
    });
  if (offers?.purchased)
    return makeView(ctx, "Paywall", {
      state: "purchased",
      copy: ["paywall.purchased", "common.done"],
      args,
      primary: "common.done",
    });
  if (!offers?.available) {
    // Not sold here: hand off to the page that sells it, only when the opener accepts it (DL14).
    const portal = linkVerdict(offers?.url, ctx.platform, "purchase");
    return makeView(ctx, "Paywall", {
      state: "not-available",
      copy: [
        "paywall.title",
        "paywall.notAvailable",
        portal.url !== null && "paywall.portal",
      ],
      args,
      primary: portal.url !== null ? "paywall.portal" : undefined,
      link: portal.url !== null ? portal : null,
      tone: "neutral",
    });
  }
  return makeView(ctx, "Paywall", {
    state: "offers",
    copy: ["paywall.title", "paywall.includes", buy, "paywall.redeem"],
    args,
    primary: buy,
  });
}

// ── EntitlementGate ────────────────────────────────────────────────────────────────────────────

export type EntitlementState = "entitled" | "not-entitled" | "loading";

/** Renders its children only when the entitlement holds. */
export function entitlementGateView(
  ctx: Context,
): View<"EntitlementGate", EntitlementState> {
  if (ctx.input.loading)
    return makeView(ctx, "EntitlementGate", {
      state: "loading",
      copy: loadingVisible(ctx.input.elapsedMs) ? ["common.loading"] : [],
      focus: null,
    });
  // License off: no license document, so the entitlement is false; the paywall is hidden, so
  // there is no unlock. An integrator's style never changes this (Must not).
  const license = ctx.on("license");
  if (license && ctx.input.entitlement?.entitled === true)
    return makeView(ctx, "EntitlementGate", {
      state: "entitled",
      copy: [],
      focus: null,
    });
  return makeView(ctx, "EntitlementGate", {
    state: "not-entitled",
    copy: ["entitlement.locked", license && "entitlement.unlock"],
    args: { tier: ctx.input.entitlement?.tier },
    primary: license ? "entitlement.unlock" : null,
    focus: null,
  });
}

// ── The should tier: About, ChannelPicker ─────────────────────────────────────

/** Product, version, build, notices and Copy diagnostics (always redacted). */
export function aboutView(ctx: Context): View<"About", "default"> {
  const id = identityText(ctx);
  return makeView(ctx, "About", {
    state: "default",
    copy: [
      "about.title",
      "about.version",
      "about.licenses",
      "about.copyDiagnostics",
      ctx.input.integrator?.poweredBy !== undefined && "part.poweredBy",
    ],
    args: { product: id.name, version: ctx.input.bundle?.version },
  });
}

/** The release channel choice: locked only with its reason. */
export function channelPickerView(
  ctx: Context,
): View<"ChannelPicker", "default" | "locked" | "hidden"> {
  if (!ctx.on("release")) return hiddenView(ctx, "ChannelPicker");
  return ctx.input.channel?.locked
    ? makeView(ctx, "ChannelPicker", {
        state: "locked",
        copy: ["channel.locked", "a11y.locked"],
        args: { store: ctx.input.channel?.store },
      })
    : makeView(ctx, "ChannelPicker", {
        state: "default",
        copy: ["channel.title"],
      });
}
