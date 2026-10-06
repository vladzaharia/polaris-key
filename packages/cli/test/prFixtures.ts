/**
 * A-18i — the fixture release and listing every PR-plane generator's golden files come from: the
 * shape `GET /<p>/distribution/pr/<store>` answers (`packages/worker/src/services/distribution/
 * prInputs.ts`; its own suite pins that shape against the real dispatcher).
 */

import type { PrInputBuild, PrInputs } from "../src/storefronts/prInputs.js";

export const BASE = "https://key.example.test";
const DIST = `${BASE}/diceroll/distribution`;
const sha = (c: string) => c.repeat(64);

const BUILDS: PrInputBuild[] = [
  {
    platform: "windows",
    arch: "arm64",
    name: "Diceroll-1.2.0-windows-arm64.zip",
    url: `${DIST}/blobs/sha256/${sha("a")}`,
    sha256: sha("a"),
    size: 41_000_000,
  },
  {
    platform: "windows",
    arch: "x86_64",
    name: "Diceroll-1.2.0-windows-x86_64.zip",
    url: `${DIST}/blobs/sha256/${sha("b")}`,
    sha256: sha("b"),
    size: 42_000_000,
  },
];

const APP: PrInputs["app"] = {
  defaultLocale: "en-US",
  name: "Diceroll",
  subtitle: "Roll the bones",
  shortDescription: "A cozy dice-rolling roguelite.",
  description:
    "Roll, reroll, repeat.\n\nNow with more dice:\n- loaded dice\n- cursed dice",
  developerName: "Vlad",
  copyright: "© 2026 Vlad",
  website: "https://diceroll.example.test",
  supportUrl: "https://diceroll.example.test/help",
  privacyUrl: "https://diceroll.example.test/privacy",
  tint: "#3b1f1f",
  tintDark: "#f0c0c0",
  contentDescriptors: {
    violenceCartoon: "mild",
    chat: "none",
    gambling: "moderate",
    lootBoxes: "none",
  },
  locales: {
    "en-US": { name: null, subtitle: "Roll the bones" },
    de: { name: "Würfelwurf", subtitle: "Wirf die Knochen" },
  },
  screenshots: [
    `https://img.plrs.im/diceroll/a/${"1a".repeat(32)}`,
    `https://img.plrs.im/diceroll/a/${"2b".repeat(32)}`,
  ],
};

const LINKS: PrInputs["links"] = {
  downloadJson: `${DIST}/download.json`,
  scoopFeed: `${DIST}/scoop/stable.json`,
  flathubFeed: `${DIST}/flathub/stable.json`,
};

const NOTES = {
  "en-US": { text: "Faster rolls.\n\n- Fixed the d20 bias", short: null },
};

function base(over: Partial<PrInputs>): PrInputs {
  return {
    store: "winget",
    channel: "stable",
    product: { slug: "diceroll", name: "Diceroll" },
    outlet: { id: "winget", kind: "winget", identity: {} },
    release: {
      releaseId: "app@1.2.0",
      version: "1.2.0",
      publishedAt: 1790000000,
      builds: BUILDS,
    },
    notes: NOTES,
    listing: null,
    app: APP,
    links: LINKS,
    selfUpdates: false,
    ...over,
  };
}

export const WINGET_INPUTS: PrInputs = base({
  store: "winget",
  outlet: {
    id: "winget",
    kind: "winget",
    identity: { packageIdentifier: "Vlad.Diceroll" },
  },
  listing: {
    exists: true,
    status: "green",
    issues: [],
    payload: {
      app: {
        Publisher: "Vlad",
        PublisherSupportUrl: "https://diceroll.example.test/help",
        PrivacyUrl: "https://diceroll.example.test/privacy",
        Copyright: "© 2026 Vlad",
      },
      locales: {
        "en-US": {
          PackageName: "Diceroll",
          ShortDescription: "A cozy dice-rolling roguelite.",
          Description: APP.description,
          Tags: ["dice", "roguelite", "Board Game", "dice"],
          ReleaseNotes: NOTES["en-US"].text,
        },
        de: {
          PackageName: "Würfelwurf",
          ShortDescription: "Ein gemütliches Würfel-Roguelite.",
          Tags: ["würfel"],
        },
      },
    },
  },
});

const DIRECT_IDENTITY = {
  platforms: ["macos", "windows", "linux"],
  homebrewCask: "diceroll",
  homebrewTap: "vlad/homebrew-games",
  scoop: { bin: "Diceroll/diceroll.exe" },
  scoopBucket: "vlad/scoop-games",
};

export const HOMEBREW_INPUTS: PrInputs = base({
  store: "homebrew",
  outlet: { id: "direct", kind: "direct", identity: DIRECT_IDENTITY },
  release: {
    releaseId: "app@1.2.0",
    version: "1.2.0",
    publishedAt: 1790000000,
    builds: [
      {
        platform: "macos",
        arch: "universal",
        name: "Diceroll-1.2.0-macos.dmg",
        url: `${DIST}/blobs/sha256/${sha("c")}`,
        sha256: sha("c"),
        size: 90_000_000,
      },
    ],
  },
  selfUpdates: true,
});

export const SCOOP_INPUTS: PrInputs = base({
  store: "scoop",
  outlet: { id: "direct", kind: "direct", identity: DIRECT_IDENTITY },
  scoop: {
    version: "1.2.0",
    description: "Roll the bones",
    homepage: "https://diceroll.example.test",
    architecture: {
      "64bit": { url: BUILDS[1]!.url, hash: sha("b") },
      arm64: { url: BUILDS[0]!.url, hash: sha("a") },
    },
    bin: "Diceroll/diceroll.exe",
    checkver: { url: LINKS.scoopFeed, jsonpath: "$.version" },
  },
});

export const FLATHUB_INPUTS: PrInputs = base({
  store: "flathub",
  outlet: {
    id: "flathub",
    kind: "flathub",
    identity: { appId: "gg.vlad.Diceroll" },
  },
  release: {
    releaseId: "app@1.2.0",
    version: "1.2.0",
    publishedAt: 1790000000,
    builds: [
      {
        platform: "linux",
        arch: "arm64",
        name: "Diceroll-1.2.0-linux-arm64.tar.gz",
        url: `${DIST}/blobs/sha256/${sha("d")}`,
        sha256: sha("d"),
        size: 50_000_000,
      },
      {
        platform: "linux",
        arch: "x86_64",
        name: "Diceroll-1.2.0-linux-x86_64.tar.gz",
        url: `${DIST}/blobs/sha256/${sha("e")}`,
        sha256: sha("e"),
        size: 51_000_000,
      },
    ],
  },
  listing: {
    exists: true,
    status: "amber",
    issues: [],
    payload: {
      app: {
        homepage: "https://diceroll.example.test",
        developerName: "Vlad",
      },
      locales: {
        "en-US": {
          name: "Diceroll",
          summary: "Roll the bones",
          description: APP.description,
          keywords: ["dice", "roguelite"],
          releases: NOTES["en-US"].text,
        },
        de: {
          name: "Würfelwurf",
          summary: "Wirf die Knochen",
          description: "Würfeln, neu würfeln, wiederholen.",
        },
      },
    },
  },
});
