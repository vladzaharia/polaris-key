/** The settings hub's reads for the layout lint: hosted assets, their quotas and the admin list. */

import { createHash } from "node:crypto";

const NOW = Math.floor(Date.now() / 1000);
const MiB = 1024 * 1024;
const P = "/manage/api/products/djdl";
const IMG = "https://img.layout.test";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function asset(slot: string, over: Record<string, unknown> = {}) {
  const h = sha(`djdl-${slot}`);
  return {
    slot,
    locale: "",
    origin: "manifest",
    sourceKind: "url",
    sourceRef: "https://cdn.example.com/icon.png",
    status: "ready",
    error: null,
    sha256: h,
    size: 126_268,
    contentType: "image/png",
    width: 1024,
    height: 1024,
    checkedAt: NOW,
    modifiedAt: NOW,
    wanted: { kind: "url", src: "https://cdn.example.com/icon.png" },
    pullPending: false,
    attempts: 0,
    nextAttemptAt: null,
    sizesPending: false,
    widths: [64, 128, 256, 512],
    url: `${IMG}/djdl/a/${h}`,
    previewUrl: `${IMG}/djdl/a/${h}/256.webp`,
    uploadable: true,
    maxBytes: 10 * MiB,
    ...over,
  };
}

export const SETTINGS_ROUTES: Record<string, unknown> = {
  [`${P}/assets`]: {
    assets: [
      asset("presentation.icon"),
      asset("listing.header", {
        origin: "console",
        sourceKind: "upload",
        sourceRef: null,
        width: 2400,
        height: 1050,
        size: 569_622,
        maxBytes: 20 * MiB,
        wanted: { kind: "repo", src: "art/header.png" },
      }),
      asset("listing.screenshot:1", {
        status: "stale",
        error: "status:404",
        maxBytes: 20 * MiB,
      }),
    ],
  },
  [`${P}/assets/usage`]: {
    hosting: true,
    media: { bytes: 128 * MiB, files: 7, quota: 512 * MiB, full: false },
    release: {
      bytes: 512 * MiB,
      files: 3,
      quota: 2048 * MiB,
      full: false,
    },
    settings: [
      {
        key: "assets.releases.mirror",
        label: "Mirror release files",
        description: "Keeps Polaris Key's own copy of every app release file.",
        spec: { kind: "switch" },
        confirm: { on: "L0", off: "L1" },
        value: "on",
        source: "default",
        inherited: "on",
        own: false,
        version: 0,
      },
      {
        key: "assets.quota.mediaBytes",
        label: "Media quota",
        description: "How many bytes of hosted images this product may hold.",
        spec: { kind: "integer", unit: "bytes", min: 0, max: 1024 ** 4 },
        confirm: { up: "L1", down: "L1" },
        value: 512 * MiB,
        source: "default",
        inherited: 512 * MiB,
        own: false,
        version: 0,
      },
      {
        key: "assets.quota.releaseBytes",
        label: "Release-file quota",
        description:
          "How many bytes of mirrored release files this product may hold.",
        spec: { kind: "integer", unit: "bytes", min: 0, max: 10 * 1024 ** 4 },
        confirm: { up: "L1", down: "L1" },
        value: 2048 * MiB,
        source: "default",
        inherited: 2048 * MiB,
        own: false,
        version: 0,
      },
    ],
  },
  "/manage/api/access/admins": {
    scope: "djdl",
    area: "core",
    admins: [
      { name: "Kenji Mori", email: "kenji@example.com", role: "product_admin" },
      { name: "Ada Lindqvist", email: "ada@example.com", role: "superadmin" },
      { name: "Jonas Weber", email: "jonas@example.com", role: "superadmin" },
    ],
  },
};
