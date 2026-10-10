// The update family (ui-matrix.json `update`): UpdatePrompt, UpdateProgress and ReleaseNotes over
// the update decision (update-matrix.json actions and outlets). The verb follows the outlet; the
// web never offers a restart the browser cannot perform; nothing says installed when only the
// download verified; release notes are text, never markup.

import type { Context } from "../input.js";
import { loadingVisible } from "../loading.js";
import { hiddenView, identityText, makeView, type View } from "../view.js";

// ── UpdatePrompt ───────────────────────────────────────────────────────────────────────────────

export type UpdatePromptState =
  | "available"
  | "downloading"
  | "ready"
  | "mandatory"
  | "blocked"
  | "store"
  | "platform"
  | "revoked-required-content"
  | "up-to-date"
  | "hidden";

/** The store an outlet opens, by its verb ("Update on the App Store", "Get it on Steam"). */
const STORE_VERB: Readonly<Record<string, string>> = {
  "app-store": "update.appStore",
  play: "update.googlePlay",
  "play-testing": "update.googlePlay",
  testflight: "update.testflight",
  altstore: "update.altstore",
  "altstore-pal": "update.altstore",
  steam: "update.steam",
};

/** Who installs an update the app cannot install itself (update-matrix.json `platform`). */
const PLATFORM_BODY: Readonly<Record<string, string>> = {
  steam: "update.platform.steam",
  itch: "update.platform.itch",
  flathub: "update.platform.store",
  snap: "update.platform.store",
  "ms-store": "update.platform.store",
  "app-installer": "update.platform.appInstaller",
  winget: "update.platform.command",
  "fdroid-repo": "update.platform.package",
  web: "update.platform.web",
};

/** The update decision as a prompt, with the verb its outlet allows. */
export function updatePromptView(
  ctx: Context,
): View<"UpdatePrompt", UpdatePromptState> {
  const u = ctx.input.update;
  if (!ctx.on("update") || !u) return hiddenView(ctx, "UpdatePrompt");
  const id = identityText(ctx);
  const args = { product: id.name, version: u.version };
  const phase = u.progress?.phase;
  if (u.action === "binary" && (phase === "download" || phase === "verify"))
    return makeView(ctx, "UpdatePrompt", {
      state: "downloading",
      // Restart when ready queues the restart, so the primary is never disabled mid-download.
      copy: [
        "update.downloading",
        "update.timeLeft",
        "a11y.progress",
        "update.restartWhenReady",
        "update.later",
      ],
      args: { ...args, fraction: u.progress?.fraction },
      primary: "update.restartWhenReady",
    });
  switch (u.action) {
    case "binary":
      if (u.mandatory)
        // A mandatory update has no dismissal.
        return makeView(ctx, "UpdatePrompt", {
          state: "mandatory",
          copy: [
            "update.mandatoryTitle",
            "update.mandatoryBody",
            "update.install",
          ],
          args,
          primary: "update.install",
        });
      return makeView(ctx, "UpdatePrompt", {
        state: "available",
        copy: u.version
          ? [
              "update.title",
              "update.current",
              u.critical && "update.critical",
              "update.whatsNew",
              "update.allChanges",
              "update.install",
              "update.restartWhenReady",
              "update.later",
              "update.skipVersion",
            ]
          : [
              "update.availableTitle",
              "update.install",
              "update.restartWhenReady",
              "update.later",
              "update.skipVersion",
            ],
        args,
        primary: "update.install",
      });
    case "code-ready":
      return makeView(ctx, "UpdatePrompt", {
        state: "ready",
        copy: [
          "update.readyTitle",
          "update.readyBody",
          "update.restartNow",
          "update.later",
        ],
        args,
        primary: "update.restartNow",
      });
    case "blocked":
      if (u.reason === "revoked-content")
        return makeView(ctx, "UpdatePrompt", {
          state: "revoked-required-content",
          copy: [
            "core.codes.pack-revoked.title",
            "update.revokedContent",
            "update.install",
          ],
          args,
          primary: "update.install",
          tone: "neutral",
        });
      return makeView(ctx, "UpdatePrompt", {
        state: "blocked",
        copy: ["update.blockedTitle", "update.blockedBody"],
        args,
        tone: "neutral",
      });
    case "store": {
      const verb = STORE_VERB[u.outlet ?? ""] ?? "update.openStore";
      return makeView(ctx, "UpdatePrompt", {
        state: "store",
        copy: [verb],
        args,
        primary: verb,
      });
    }
    case "platform":
      // The host installs it; the web never offers a restart (Must not).
      return makeView(ctx, "UpdatePrompt", {
        state: "platform",
        copy: [
          "update.availableTitle",
          PLATFORM_BODY[u.outlet ?? ""] ?? "update.platform.generic",
        ],
        args,
      });
    case "none":
      return makeView(ctx, "UpdatePrompt", {
        state: "up-to-date",
        copy: ["update.upToDate", "update.checkNow"],
        args,
      });
    default:
      return hiddenView(ctx, "UpdatePrompt");
  }
}

// ── UpdateProgress ─────────────────────────────────────────────────────────────────────────────

export type UpdateProgressState =
  | "queued"
  | "downloading"
  | "installing"
  | "paused"
  | "failed"
  | "done"
  | "hidden";

/** Download and install progress for an app update or content packs. */
export function updateProgressView(
  ctx: Context,
): View<"UpdateProgress", UpdateProgressState> {
  const u = ctx.input.update;
  const p = u?.progress;
  if (!ctx.on("update") || !u || !p) return hiddenView(ctx, "UpdateProgress");
  const args = { fraction: p.fraction };
  switch (p.phase) {
    case "queued":
      return makeView(ctx, "UpdateProgress", {
        state: "queued",
        copy: [
          u.action === "packs" && "updateProgress.contentTitle",
          "updateProgress.queued",
        ],
        args,
        focus: null,
      });
    case "download":
    case "verify":
      // Verification happens inside downloading: never "installed" before apply (Must not).
      return makeView(ctx, "UpdateProgress", {
        state: "downloading",
        copy: ["updateProgress.downloading", "a11y.progress"],
        args,
        focus: null,
      });
    case "install":
      return makeView(ctx, "UpdateProgress", {
        state: "installing",
        copy: ["updateProgress.installing"],
        args,
        focus: null,
      });
    case "paused":
      return makeView(ctx, "UpdateProgress", {
        state: "paused",
        copy: ["updateProgress.paused", "updateProgress.resume"],
        args,
        primary: "updateProgress.resume",
        focus: null,
      });
    case "failed":
      return makeView(ctx, "UpdateProgress", {
        state: "failed",
        copy: ["updateProgress.failed", "common.tryAgain"],
        args,
        primary: "common.tryAgain",
        tone: "danger",
        errorSlot: "updateProgress.failed",
        focus: null,
      });
    case "done":
      return makeView(ctx, "UpdateProgress", {
        state: "done",
        copy: ["updateProgress.done"],
        args,
        focus: null,
      });
  }
}

// ── ReleaseNotes ───────────────────────────────────────────────────────────────────────────────

export type ReleaseNotesState =
  | "loading"
  | "list"
  | "empty"
  | "error"
  | "hidden";

/** The changelog. Notes are plain text: a renderer never executes their markup (Must not). */
export function releaseNotesView(
  ctx: Context,
): View<"ReleaseNotes", ReleaseNotesState> {
  if (!ctx.on("release")) return hiddenView(ctx, "ReleaseNotes");
  if (ctx.input.loading)
    return makeView(ctx, "ReleaseNotes", {
      state: "loading",
      copy: loadingVisible(ctx.input.elapsedMs)
        ? ["releaseNotes.title", "common.loading"]
        : [],
      focus: null,
    });
  if (ctx.input.error)
    return makeView(ctx, "ReleaseNotes", {
      state: "error",
      copy: ["releaseNotes.error", "common.tryAgain"],
      primary: "common.tryAgain",
      tone: "danger",
      errorSlot: "screen",
    });
  const notes = ctx.input.releaseNotes ?? [];
  if (notes.length === 0)
    return makeView(ctx, "ReleaseNotes", {
      state: "empty",
      copy: ["releaseNotes.empty"],
    });
  return makeView(ctx, "ReleaseNotes", {
    state: "list",
    copy: [
      "releaseNotes.title",
      "releaseNotes.version",
      "releaseNotes.released",
    ],
  });
}
