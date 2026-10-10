/**
 * THE CI PLANE (A-18h; notes/S-15 §4.4, §6.2, §6.3): every vendor CLI the publish action may run,
 * as one command allow-list per store. This is the CI-plane counterpart of the Worker gate's rule
 * tables, and a change to it is a THREAT-MODEL §9 review trigger.
 *
 *   store     tool             allowed                                       never
 *   itch      butler           push <dir> <user/game>:<channel> --userversion  any other command;
 *                              (the target is the outlet identity's)           collections and page
 *                                                                              edits have no CLI
 *   snap      snapcraft        upload <snap> --release=<identity channels>;    close, collaborators
 *                              upload-metadata <snap>                         (package_manage),
 *                                                                              release, register
 *   steam     steamcmd         +login <account> +run_app_build <vdf> +quit,    setlive on default or
 *                              the VDF's setlive on a named branch only        public; a setlive argv
 *   msstore   msstore          publish <package> --appId <identity productId>, submission delete,
 *                              never while the ledger shows a Worker-staged    rollout halt/finalize
 *                              draft (A-18f)
 *   epic      BuildPatchTool   -mode=UploadBinary only, the secret by env var  DeleteBinary,
 *                                                                              UnlabelBinary, an argv
 *                                                                              client secret
 *
 * `itch`, `snap` and `steam` are storefront adapters (`stores/itch.ts`, `stores/snap.ts`,
 * `stores/steam.ts`) whose `ci` is the list here. Microsoft's adapter (A-18f) is registered as
 * `microsoft-store`, so its list (`msstore`) is reachable through `pkey storefront exec` and the
 * report-back rather than as the adapter's `ci`. Epic is not an
 * outlet kind (owner decision 8): its list exists so a BuildPatchTool step is constrained, and no
 * Epic adapter ships.
 *
 * Store ids are the ledger's `store_operations.store`: A-18f and A-18g register their adapters
 * under `msstore` and `steam`, and A-18f names its Worker-plane draft operations
 * `submission.create` and `submission.commit` (the msstore guard below reads those rows).
 *
 * Pure data (`test/boundaries.test.ts`): the CLI's copy is the generated
 * `packages/cli/src/storefronts/ciPlane.generated.ts` (`pnpm gen storefront-ci`; a worker test
 * fails when it is stale). `test/storefront/conformance.test.ts` asserts every `never` argv
 * matches no command and no literal spells a `neverTokens` entry.
 */

import type { CiAllowList, CiParam } from "./ci.js";

/** A store of the CI plane: its ledger id, its allow-list, and what must never run. */
export interface CiPlaneStore {
  /** The `store_operations.store` id. */
  readonly store: CiStoreId;
  readonly label: string;
  readonly list: CiAllowList;
  /** The outlet kinds whose identity binds parameters (none for Epic). */
  readonly outletKinds: readonly string[];
  /** Argv lines that must match no command (the conformance suite runs each). */
  readonly never: readonly (readonly string[])[];
  /** Lower-case substrings no literal token may contain. */
  readonly neverTokens: readonly string[];
}

export const CI_STORE_IDS = [
  "itch",
  "snap",
  "steam",
  "msstore",
  "epic",
] as const;
export type CiStoreId = (typeof CI_STORE_IDS)[number];

// ── Shared patterns ─────────────────────────────────────────────────────────────────────────

/**
 * A path a workflow passes: no leading `-` (never an option), no `..` segment, no shell
 * metacharacters (the tool is spawned without a shell, so this is defence in depth).
 */
const PATH = String.raw`(?!-)(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[A-Za-z0-9 ._/\\:+-]{1,512}`;
/** A release version or build label. */
const VERSION = String.raw`[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}`;
const param = (
  name: string,
  pattern: string,
  more: Omit<CiParam, "param" | "pattern"> = {},
): CiParam => ({ param: name, pattern, ...more });

// ── itch.io: butler ──────────────────────────────────────────────────────────────────────────

/** A butler channel: a platform word first, so itch.io tags the upload (S-15 §4.4). */
export const ITCH_CHANNEL_PATTERN = String.raw`(?:windows|linux|mac|osx|android)(?:-[a-z0-9]{1,32}){0,3}`;
const ITCH_TARGET = String.raw`[A-Za-z0-9_-]{1,64}/[A-Za-z0-9_-]{1,64}`;

export const ITCH_CI: CiPlaneStore = {
  store: "itch",
  label: "itch.io",
  outletKinds: ["itch"],
  list: {
    tool: "butler",
    commands: {
      push: {
        argv: [
          "push",
          param("dir", PATH),
          param("target", `${ITCH_TARGET}:${ITCH_CHANNEL_PATTERN}`, {
            identity: { field: "target", match: "prefix", separator: ":" },
          }),
          "--userversion",
          param("version", VERSION),
        ],
        confirm: "plain",
        why: "a build to one channel of the outlet's own game; the channel name tags its platform",
      },
    },
  },
  never: [
    ["login"],
    ["logout"],
    ["upgrade"],
    ["fetch", "vlad/dice:windows", "out"],
    ["push", "build", "vlad/dice:windows"],
    [
      "push",
      "build",
      "vlad/dice:windows",
      "--userversion",
      "1.0.0",
      "--fix-permissions",
    ],
  ],
  neverTokens: ["delete", "collection", "login", "logout", "fetch"],
};

// ── Snap Store: snapcraft ────────────────────────────────────────────────────────────────────

/** `[<track>/]<risk>[/<branch>]`. */
export const SNAP_CHANNEL_PATTERN = String.raw`(?:[a-z0-9][a-z0-9.-]{0,63}/)?(?:stable|candidate|beta|edge)(?:/[a-z0-9][a-z0-9-]{0,63})?`;
const SNAP_FILE = `${PATH}\\.snap`;

export const SNAP_CI: CiPlaneStore = {
  store: "snap",
  label: "Snap Store",
  outletKinds: ["snap"],
  list: {
    tool: "snapcraft",
    commands: {
      upload: {
        argv: [
          "upload",
          param("snap", SNAP_FILE),
          param(
            "release",
            `${SNAP_CHANNEL_PATTERN}(?:,${SNAP_CHANNEL_PATTERN}){0,7}`,
            {
              prefix: "--release=",
              identity: { field: "channels", match: "each", separator: "," },
            },
          ),
        ],
        confirm: "plain",
        why: "upload a revision and release it only to channels the outlet's identity declares",
      },
      "upload-metadata": {
        argv: ["upload-metadata", param("snap", SNAP_FILE)],
        confirm: "plain",
        why: "the summary, description and icon the snap carries (written from the listing model by pkey storefront snap metadata)",
      },
    },
  },
  never: [
    ["close", "dice", "beta"],
    ["collaborate", "dice", "someone"],
    ["release", "dice", "12", "stable"],
    ["register", "dice"],
    ["promote", "dice", "--from-channel", "beta", "--to-channel", "stable"],
    ["set-default-track", "dice", "2.0"],
    [
      "export-login",
      "--snaps",
      "dice",
      "--acls",
      "package_manage",
      "creds.txt",
    ],
    ["upload", "dice_1.0_amd64.snap"],
    ["upload", "dice_1.0_amd64.snap", "--release=stable", "--force"],
  ],
  neverTokens: [
    "close",
    "collaborat",
    "package_manage",
    "register",
    "promote",
    "export-login",
    "progressive",
  ],
};

// ── Steam: steamcmd ──────────────────────────────────────────────────────────────────────────

export const STEAM_CI: CiPlaneStore = {
  store: "steam",
  label: "Steam",
  outletKinds: ["steam"],
  list: {
    tool: "steamcmd",
    commands: {
      "run-app-build": {
        argv: [
          "+login",
          param("account", "[A-Za-z0-9_]{1,64}"),
          "+run_app_build",
          param("script", `${PATH}\\.vdf`),
          "+quit",
        ],
        confirm: "plain",
        why: "a SteamPipe build; the script's setlive, if any, names a branch other than default and public (owner decision 5)",
        fileChecks: [{ param: "script", check: "steam-vdf-setlive-named" }],
      },
    },
  },
  never: [
    ["+login", "builder", "+app_set_config", "480", "+quit"],
    ["+login", "builder", "+run_app_build", "app.vdf", "+setlive", "public"],
    ["+login", "builder", "+app_uninstall", "480", "+quit"],
    ["+login", "builder", "builder-password", "+run_app_build", "app.vdf"],
  ],
  neverTokens: ["delete", "setlive", "+app_set_config", "+app_uninstall"],
};

// ── Microsoft Store: msstore ─────────────────────────────────────────────────────────────────

export const MSSTORE_CI: CiPlaneStore = {
  store: "msstore",
  label: "Microsoft Store",
  outletKinds: ["ms-store"],
  list: {
    tool: "msstore",
    commands: {
      publish: {
        argv: [
          "publish",
          param("package", PATH),
          "--appId",
          param("productId", "[A-Za-z0-9]{12}", {
            identity: { field: "productId", match: "equal" },
          }),
        ],
        confirm: "plain",
        why: "a package submission from CI, never over a draft the Worker staged (A-18f): the CLI would replace it",
        unlessWorkerStaged: {
          workerStore: "microsoft-store",
          opens: ["submission.create"],
          closes: ["submission.commit"],
        },
      },
    },
  },
  never: [
    ["submission", "delete", "9NBLGGH4R315"],
    ["submission", "rollout", "halt", "9NBLGGH4R315"],
    ["submission", "rollout", "finalize", "9NBLGGH4R315"],
    ["apps", "list"],
  ],
  neverTokens: ["delete", "rollout", "halt", "finalize"],
};

// ── Epic Games Store: BuildPatchTool (no adapter; decision 8) ──────────────────────────────

const EPIC_ID = "[A-Za-z0-9][A-Za-z0-9-]{0,63}";

export const EPIC_CI: CiPlaneStore = {
  store: "epic",
  label: "Epic Games Store",
  outletKinds: [],
  list: {
    tool: "BuildPatchTool",
    commands: {
      "upload-binary": {
        argv: [
          "-mode=UploadBinary",
          param("organization", EPIC_ID, { prefix: "-OrganizationId=" }),
          param("product", EPIC_ID, { prefix: "-ProductId=" }),
          param("artifact", EPIC_ID, { prefix: "-ArtifactId=" }),
          param("client", EPIC_ID, { prefix: "-ClientId=" }),
          param("secretEnv", "[A-Z_][A-Z0-9_]{0,63}", {
            prefix: "-ClientSecretEnvVar=",
          }),
          param("buildRoot", PATH, { prefix: "-BuildRoot=" }),
          param("cloudDir", PATH, { prefix: "-CloudDir=" }),
          param("buildVersion", VERSION, { prefix: "-BuildVersion=" }),
          param("appLaunch", PATH, { prefix: "-AppLaunch=" }),
          param("appArgs", "[A-Za-z0-9 ._=-]{0,256}", { prefix: "-AppArgs=" }),
        ],
        confirm: "plain",
        why: "upload a binary only; labelling it live stays in the Developer Portal, and the secret is read from an environment variable, never argv",
      },
    },
  },
  never: [
    ["-mode=DeleteBinary", "-BuildVersion=1.0.0"],
    ["-mode=UnlabelBinary", "-BuildVersion=1.0.0", "-Label=Live"],
    ["-mode=LabelBinary", "-BuildVersion=1.0.0", "-Label=Live"],
    ["-mode=UploadBinary", "-ClientSecret=hunter2"],
  ],
  neverTokens: ["deletebinary", "labelbinary", "-clientsecret="],
};

/** THE CI PLANE: one row per store. */
export const CI_PLANE: readonly CiPlaneStore[] = [
  ITCH_CI,
  SNAP_CI,
  STEAM_CI,
  MSSTORE_CI,
  EPIC_CI,
];

/** A CI-plane store by id, or null. */
export function ciPlaneStore(store: string): CiPlaneStore | null {
  return CI_PLANE.find((s) => s.store === store) ?? null;
}
