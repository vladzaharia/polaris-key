// The activate family (ui-matrix.json `activate`): Welcome, Activate and OfflineActivation.
// Welcome offers only the paths the build and the services support; the key field parses as the
// person types (UI-KITS.md §4.3 "Live verdict"); a full license hands off to DeviceLimit, never an
// error string; a floating key never needs an account; a loaded offline response is not an
// activation until its signature verifies.

import { activationCopy } from "../errors.js";
import type { Context } from "../input.js";
import { linkVerdict } from "../link.js";
import { identityText, hiddenView, makeView, type View } from "../view.js";

// ── Welcome ────────────────────────────────────────────────────────────────────────────────────

export type WelcomeState = "default" | "busy" | "capability-limited" | "hidden";

/** The gate's first screen: product hero, Sign in, Use a license key and the product's extras. */
export function welcomeView(ctx: Context): View<"Welcome", WelcomeState> {
  const signIn = ctx.caps.signIn && ctx.on("identity");
  const key = ctx.caps.keyEntry && ctx.on("license");
  // License off with open registration: there is nothing to sign in or activate for.
  if (!ctx.on("license") && ctx.registration === "open")
    return hiddenView(ctx, "Welcome");
  const id = identityText(ctx);
  const args = { product: id.name, developer: id.developer ?? undefined };
  // The one primary follows the state: Sign in on an empty Welcome (DL4).
  const primary = signIn ? "welcome.signIn" : key ? "welcome.useKey" : null;
  if (ctx.input.pending)
    return makeView(ctx, "Welcome", {
      state: "busy",
      copy: ["welcome.title", "common.working", "a11y.busy"],
      args,
      // A busy control keeps its label and its focus (DL4, DL9).
      primary,
    });
  if (!signIn || !key)
    return makeView(ctx, "Welcome", {
      state: "capability-limited",
      copy: [
        "welcome.title",
        signIn ? "welcome.ledeSignInOnly" : "welcome.ledeKeyOnly",
      ],
      args,
      primary,
    });
  return makeView(ctx, "Welcome", {
    state: "default",
    copy: [
      "a11y.productIcon",
      "welcome.title",
      id.developer !== null && "common.byDeveloper",
      "welcome.lede",
      "welcome.signIn",
      "welcome.useKey",
      ctx.caps.trial && "welcome.trial",
      ctx.caps.enroll && "welcome.continueFree",
      ctx.caps.restore && "welcome.restore",
      ctx.caps.offlineActivation && "welcome.offline",
    ],
    args,
    primary,
  });
}

// ── Activate: the key field ──────────────────────────────────────────────────────────────────

/** A license key's secret: exactly 22 base64url characters (packages/worker/src/crypto.ts). */
export const KEY_SECRET_LENGTH = 22;
const KEY_PREFIX = "pkey_";
const KEY_SHAPE = /^pkey_([a-z0-9-]+)_([A-Za-z0-9_-]*)$/;

/** What the key field holds, read as the person types. */
export interface KeyParse {
  kind: "empty" | "typing" | "parsed" | "short" | "malformed";
  /** The product slug the key names, once it parses that far. */
  slug?: string;
  /** `pkey_<slug>_`: the key's public prefix. */
  prefix?: string;
  /** Secret characters present (the cut-short line counts them). */
  used?: number;
  limit: number;
}

/**
 * Parse the key field. A prefix of `pkey_<slug>_` and a short secret are still `typing`; a short
 * secret only becomes `short` when submitted (EXPERIENCE P2), and anything that can never become
 * a key is `malformed` at once.
 */
export function parseKey(text: string, submitted = false): KeyParse {
  const key = text.trim();
  const limit = KEY_SECRET_LENGTH;
  if (key === "") return { kind: "empty", limit };
  if (!key.startsWith(KEY_PREFIX))
    return {
      kind: KEY_PREFIX.startsWith(key) && !submitted ? "typing" : "malformed",
      limit,
    };
  const m = KEY_SHAPE.exec(key);
  if (!m)
    return {
      kind:
        /^pkey_[a-z0-9-]*$/.test(key) && !submitted ? "typing" : "malformed",
      limit,
    };
  const slug = m[1]!;
  const used = [...m[2]!].length;
  const prefix = `${KEY_PREFIX}${slug}_`;
  const kind =
    used === limit
      ? "parsed"
      : used > limit
        ? "malformed"
        : submitted
          ? "short"
          : "typing";
  return { kind, slug, prefix, used, limit };
}

export type ActivateState =
  | "empty"
  | "typing"
  | "parsed"
  | "cut-short"
  | "busy"
  | "rejected"
  | "device-limit"
  | "done"
  | "hidden";

const FIELD = "part.keyField.label";
const SUBMIT = "activate.submit";

/** License key entry with a live verdict, and the activation's answer. */
export function activateView(ctx: Context): View<"Activate", ActivateState> {
  if (!ctx.on("license")) return hiddenView(ctx, "Activate");
  const { keyField, activation, pending } = ctx.input;
  const product = identityText(ctx).name;
  if (pending === "activate")
    return makeView(ctx, "Activate", {
      state: "busy",
      copy: ["activate.busy", "a11y.busy"],
      primary: SUBMIT,
    });
  if (activation) {
    if (activation.result === "ok")
      return makeView(ctx, "Activate", {
        state: "done",
        copy: [
          "core.activation.ok.title",
          "core.activation.ok.message",
          "part.keyField.verdict",
        ],
        args: { product },
        // The done step (UK-42's ActivateDone) carries the way on; the heading takes focus.
      });
    if (activation.result === "device-limit") {
      const link = linkVerdict(
        activation.manageUrl,
        ctx.platform,
        "replace-device",
      );
      const known = activation.limit !== undefined;
      return makeView(ctx, "Activate", {
        state: "device-limit",
        copy: [
          "core.activation.device-limit.title",
          "core.activation.device-limit.message",
          "deviceLimit.title",
          known && "part.seatMeter.caption",
          // With no link the fix is named in words (DL6).
          link.url === null && "deviceLimit.noManage",
        ],
        args: {
          product,
          used: activation.deviceCount,
          limit: activation.limit,
        },
        // The fix is the only primary and takes focus (DL6): Replace a device, which opens the
        // link (DeviceLimit's browser mode).
        primary: link.url !== null ? "deviceLimit.title" : null,
        tone: "neutral",
        errorSlot: FIELD,
        link,
      });
    }
    // A refusal of a well-formed key: the key is not wrong, so no danger stroke on the field.
    return makeView(ctx, "Activate", {
      state: "rejected",
      copy: activationCopy(activation.result, activation.code),
      args: { product },
      primary: SUBMIT,
      tone: activation.result === "error" ? "danger" : "neutral",
      errorSlot: FIELD,
      focus: FIELD,
    });
  }
  const parse = parseKey(keyField?.text ?? "", keyField?.submitted === true);
  const args = {
    product,
    slug: parse.slug,
    prefix: parse.prefix,
    used: parse.used,
    limit: parse.limit,
  };
  switch (parse.kind) {
    case "empty":
      if (keyField?.submitted)
        return makeView(ctx, "Activate", {
          state: "rejected",
          copy: ["part.keyField.empty"],
          args,
          primary: SUBMIT,
          tone: "danger",
          errorSlot: FIELD,
          focus: FIELD,
        });
      return makeView(ctx, "Activate", {
        state: "empty",
        copy: [
          "activate.title",
          "activate.lede",
          FIELD,
          "part.keyField.placeholder",
          "common.paste",
          SUBMIT,
        ],
        args,
        primary: SUBMIT,
        focus: FIELD,
      });
    case "typing":
      return makeView(ctx, "Activate", {
        state: "typing",
        copy: [FIELD, SUBMIT],
        args,
        primary: SUBMIT,
        focus: FIELD,
      });
    case "parsed":
      return makeView(ctx, "Activate", {
        state: "parsed",
        copy: ["part.keyField.forProduct", SUBMIT],
        args,
        primary: SUBMIT,
        focus: FIELD,
      });
    case "short":
      return makeView(ctx, "Activate", {
        state: "cut-short",
        copy: ["part.keyField.cutShort"],
        args,
        primary: SUBMIT,
        tone: "danger",
        errorSlot: FIELD,
        focus: FIELD,
      });
    case "malformed":
      return makeView(ctx, "Activate", {
        state: "rejected",
        copy: ["part.keyField.malformed"],
        args,
        primary: SUBMIT,
        tone: "danger",
        errorSlot: FIELD,
        focus: FIELD,
      });
  }
}

// ── OfflineActivation ────────────────────────────────────────────────────────────────────────

export type OfflineState =
  | "default"
  | "loaded"
  | "rejected-signature"
  | "done"
  | "hidden";

/** Two numbered actions: send the request, load the response; then the verdict. */
export function offlineActivationView(
  ctx: Context,
): View<"OfflineActivation", OfflineState> {
  if (!ctx.on("license")) return hiddenView(ctx, "OfflineActivation");
  const o = ctx.input.offline ?? {};
  const product = identityText(ctx).name;
  if (o.submitted && o.file && o.verified === true)
    return makeView(ctx, "OfflineActivation", {
      state: "done",
      copy: ["offlineActivation.done"],
      args: { product },
    });
  if (o.submitted && o.file && o.verified === false)
    return makeView(ctx, "OfflineActivation", {
      state: "rejected-signature",
      copy: [
        "core.codes.bundle-jws-rejected.title",
        "core.codes.bundle-jws-rejected.message",
      ],
      primary: "offlineActivation.loadFile",
      tone: "danger",
      errorSlot: "offlineActivation.loadFile",
      focus: "offlineActivation.loadFile",
    });
  // A loaded file is not an activation until its signature verifies (Must not).
  if (o.file || o.copied)
    return makeView(ctx, "OfflineActivation", {
      state: "loaded",
      copy: [
        o.copied && !o.submitted && !o.file && "offlineActivation.codeCopied",
        o.submitted && !o.file && "offlineActivation.empty",
        "offlineActivation.submit",
      ],
      primary: "offlineActivation.submit",
      tone: o.submitted && !o.file ? "danger" : null,
      errorSlot: o.submitted && !o.file ? "offlineActivation.submit" : null,
      // The request code may be drawn as a QR on any screen that fits it (DL14).
      qr: true,
    });
  return makeView(ctx, "OfflineActivation", {
    state: "default",
    copy: [
      "offlineActivation.title",
      "offlineActivation.request",
      "offlineActivation.product",
      "offlineActivation.copyCode",
      "offlineActivation.loadHint",
      "offlineActivation.loadFile",
      "offlineActivation.paste",
      "offlineActivation.dropHint",
      "offlineActivation.submit",
    ],
    args: { product },
    primary: "offlineActivation.copyCode",
    qr: true,
  });
}
