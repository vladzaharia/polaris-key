// @pkey-feature ui.gate ui.activate ui.signin ui.update ui.settings ui.paywall ui.i18n
//
// The arguments the models fill (the raw-placeholder defect, uiMatrix.test.ts "no raw
// placeholder"): from the data a model already holds (identity, the stage emit, the account), from
// the display facts `UiInput` carries as text, and, for the update prompt, per key, because its
// title names the new `{version}` where "You have {version}" names the installed one.

import { describe, expect, it } from "vitest";
import { KIT_COPY_EN } from "@polaris-key/brand/kit-copy";

import { Copy, formatBytes, viewOf, type UiInput } from "../src/index.js";

const en = new Copy({ tables: { en: KIT_COPY_EN } });
const base: UiInput = {
  presentation: {
    name: "Tidewater Studio",
    developerName: "Harbor Audio",
    icon: true,
  },
};

describe("formatBytes", () => {
  it("reads a size the way the platform shows a file size, in the kit's locale", () => {
    expect(formatBytes(52_428_800)).toBe("52 MB");
    expect(formatBytes(1_500_000_000)).toBe("1.5 GB");
    expect(formatBytes(999_999)).toBe("1 MB");
    expect(formatBytes(1_500_000, "de")).toBe("1,5 MB");
    expect(formatBytes(0)).toBe("0 byte");
  });

  it("reads English for a locale tag Intl does not know", () => {
    expect(formatBytes(52_428_800, "not a locale")).toBe("52 MB");
  });
});

describe("the arguments a model fills from what it holds", () => {
  it("names the product on the boot and gate errors, and the code the boot stage ended with", () => {
    const error = {
      stage: {
        stage: "error",
        outcome: "error",
        emit: { type: "error", code: "sync-failed" },
      },
    };
    expect(viewOf("PolarisKeyGate", { ...base, ...error }).args).toEqual({
      product: "Tidewater Studio",
    });
    expect(en.strings(viewOf("Boot", { ...base, ...error }))).toMatchObject({
      "boot.error.body":
        "Tidewater Studio couldn't finish starting (sync-failed).",
    });
  });

  it("formats the boot stage's byte counts in the input's locale", () => {
    const consent = (locale?: string): UiInput => ({
      ...base,
      ...(locale ? { locale } : {}),
      stage: {
        stage: "fetch",
        outcome: "waiting",
        emit: { type: "consent_needed", bytes: 1_500_000, metered: false },
      },
    });
    expect(en.strings(viewOf("Boot", consent()))["boot.consent.body"]).toBe(
      "Tidewater Studio needs 1.5 MB of new content.",
    );
    expect(viewOf("Boot", consent("de")).args.size).toBe("1,5 MB");
    const fetching = viewOf("Boot", {
      ...base,
      stage: {
        stage: "fetch",
        outcome: "running",
        emit: { type: "fetch_progress", done: 20_971_520, total: 52_428_800 },
      },
    });
    expect(en.strings(fetching)["a11y.progress"]).toBe(
      "21 MB of 52 MB downloaded",
    );
  });

  it("gives the grace banner its date and the update toast and release notes their product", () => {
    const grace: UiInput = {
      ...base,
      gate: { status: "grace", graceDaysLeft: 5, graceDate: "Dec 4, 2026" },
    };
    expect(en.strings(viewOf("GraceBanner", grace))["grace.deadline"]).toBe(
      "Reconnect by Dec 4, 2026",
    );
    expect(
      en.strings(
        viewOf("GraceBanner", {
          ...grace,
          gate: { status: "grace", graceDaysLeft: 1 },
        }),
      )["grace.lastDay"],
    ).toBe("Offline · reconnect today to keep using Tidewater Studio");
    const toast = viewOf("Toast", {
      ...base,
      toast: { kind: "update", closesIn: "8 seconds" },
      update: { action: "binary", version: "2.5.0" },
    });
    expect(en.strings(toast)).toMatchObject({
      "toast.updateAvailable": "Tidewater Studio 2.5.0 is available",
      "a11y.toastTimer": "Closes in 8 seconds",
    });
    expect(
      en.strings(viewOf("ReleaseNotes", { ...base, loading: true }))[
        "releaseNotes.title"
      ],
    ).toBe("What's new in Tidewater Studio");
  });

  it("names the account holder only when an account is signed in here", () => {
    const account = { signedIn: true, holder: "Maya", tier: "Pro" };
    const signed = viewOf("AccountAndLicense", {
      ...base,
      account,
      bundle: { slug: "t", version: "2.4.1" },
    });
    expect(en.strings(signed)).toMatchObject({
      "account.holder": "Signed in as Maya",
      "account.tier": "Pro license",
      "account.version": "Version 2.4.1",
    });
    const floating = viewOf("AccountAndLicense", {
      ...base,
      account: { ...account, signedIn: false },
    });
    expect(floating.state).toBe("key-only");
    expect(floating.args).not.toHaveProperty("name");
  });

  it("passes the paywall's and the lock's tier, the store of a locked channel and the sync time", () => {
    const entitlement = { name: "pro.export", entitled: false, tier: "Pro" };
    expect(
      en.strings(viewOf("EntitlementGate", { ...base, entitlement }))[
        "entitlement.locked"
      ],
    ).toBe("This feature needs Pro.");
    expect(
      en.strings(
        viewOf("Paywall", {
          ...base,
          entitlement,
          offers: { available: true },
        }),
      )["paywall.title"],
    ).toBe("Get more with Tidewater Studio Pro");
    expect(
      en.strings(
        viewOf("ChannelPicker", {
          ...base,
          channel: { locked: true, store: "Steam" },
        }),
      )["channel.locked"],
    ).toBe("Steam sets the release channel.");
    expect(
      en.strings(
        viewOf("CloudSyncStatus", {
          ...base,
          cloudSync: { state: "synced", lastSynced: "2 min ago" },
        }),
      )["cloudSync.synced"],
    ).toBe("Synced 2 min ago");
  });
});

describe("the sign-in provider", () => {
  const form: UiInput = {
    ...base,
    signIn: { presentation: "inline", replace: "inline", channel: "browser" },
  };

  it("is Polaris Key's own sign-in unless the product names a provider's row", () => {
    expect(en.strings(viewOf("SignIn", form))["signin.provider.continue"]).toBe(
      "Continue with Polaris Key",
    );
    expect(
      en.strings(viewOf("SignIn", { ...form, provider: "Apple" }))[
        "signin.provider.continue"
      ],
    ).toBe("Continue with Apple");
  });

  it("names the sign-in that failed", () => {
    const failed = viewOf("SignIn", {
      ...form,
      provider: "Google",
      error: { code: "sign-in-failed" },
    });
    expect(en.strings(failed)["signIn.methodError"]).toBe(
      "Google sign-in didn't finish. Try another way.",
    );
  });

  it("names who signed in and with which license when an existing license opens the app", () => {
    const done = viewOf("SignIn", {
      ...form,
      signIn: { ...form.signIn!, outcome: "signedIn", issuedNow: false },
      account: { signedIn: true, holder: "Maya", tier: "Pro" },
    });
    expect(en.strings(done)["signin.desktop.toast"]).toBe(
      "Signed in as Maya · Pro license",
    );
  });
});

describe("the update prompt", () => {
  const update = { action: "binary", version: "2.5.0", size: "52 MB" };

  it("says the installed version where it says what you have, and the new one in its title", () => {
    const view = viewOf("UpdatePrompt", {
      ...base,
      update,
      bundle: { slug: "t", version: "2.4.1" },
    });
    expect(view.args.version).toBe("2.5.0");
    expect(view.keyArgs?.["update.current"]).toEqual({
      version: "2.4.1",
      size: "52 MB",
    });
    expect(en.strings(view)).toMatchObject({
      "update.title": "Tidewater Studio 2.5.0",
      "update.current": "You have 2.4.1 · 52 MB download",
      "update.allChanges": "All changes in 2.5.0",
    });
  });

  it("never reads the new version as the installed one when the app's version is unknown", () => {
    const view = viewOf("UpdatePrompt", { ...base, update });
    expect(en.strings(view)["update.current"]).toBe(
      "You have {version} · 52 MB download",
    );
  });

  it("names the store, the command and the download", () => {
    const store = viewOf("UpdatePrompt", {
      ...base,
      update: { action: "store", outlet: "ms-store", version: "2.5.0" },
    });
    expect(en.strings(store)["update.openStore"]).toBe("Open Microsoft Store");
    expect(
      en.strings(
        viewOf("UpdatePrompt", {
          ...base,
          update: { action: "store", outlet: "x", store: "F-Droid" },
        }),
      )["update.openStore"],
    ).toBe("Open F-Droid");
    const command = viewOf("UpdatePrompt", {
      ...base,
      update: {
        action: "platform",
        outlet: "winget",
        command: "winget upgrade Harbor.Tidewater",
      },
    });
    expect(en.strings(command)["update.platform.command"]).toBe(
      "Run winget upgrade Harbor.Tidewater to install it.",
    );
    const progress = {
      phase: "download" as const,
      fraction: 0.4,
      size: "21 MB",
      total: "52 MB",
      timeLeft: "20 seconds",
    };
    const downloading = viewOf("UpdateProgress", {
      ...base,
      update: { action: "binary", progress },
    });
    expect(en.strings(downloading)["updateProgress.downloading"]).toBe(
      "21 MB of 52 MB · 20 seconds left",
    );
  });
});
