/**
 * The three doors, the access tiers and the sidebar data (docs plan §3.1, §3.2).
 *
 * Audience and access are not frontmatter: they come from the directory, so they cannot
 * disagree with the gate. `TIER_PREFIXES` is the single table DOC-03b's build turns into
 * `dist/docs-access.json`; `doors.test.ts` pins every content directory to a door and a tier.
 * Each door renders only its own tree (DOC-02b's `Sidebar.astro` picks the tree by path
 * prefix); until then the config concatenates the trees in door order.
 */

export type DoorId = "landing" | "help" | "developers" | "operate";
export type Tier = "public" | "member" | "admin";

/** Longest prefix wins. A prefix names a content id path, with no leading slash. */
export const TIER_PREFIXES: ReadonlyArray<
  readonly [prefix: string, door: DoorId, tier: Tier]
> = [
  ["index", "landing", "public"],
  ["access", "landing", "public"],
  ["help/", "help", "public"],
  ["start/", "developers", "public"],
  ["build/", "developers", "public"],
  ["features/", "developers", "public"],
  ["reference/", "developers", "public"],
  ["operate/platform/", "operate", "admin"],
  ["operate/", "operate", "member"],
  ["contribute/", "operate", "admin"],
];

/** The door and tier of a content id such as `help/activate`. Null for a path no door owns. */
export function doorOf(
  id: string,
): { door: DoorId; tier: Tier; prefix: string } | null {
  let best: (typeof TIER_PREFIXES)[number] | null = null;
  for (const row of TIER_PREFIXES) {
    const hit = row[0].endsWith("/") ? id.startsWith(row[0]) : id === row[0];
    if (hit && (best === null || row[0].length > best[0].length)) best = row;
  }
  return best === null
    ? null
    : { prefix: best[0], door: best[1], tier: best[2] };
}

export interface SidebarLeaf {
  /** A content id, such as `features/licensing/model`. */
  id: string;
  /** Overrides the page title in the sidebar. */
  label?: string;
}
export interface SidebarGroup {
  label: string;
  collapsed?: boolean;
  items: ReadonlyArray<SidebarLeaf | SidebarGroup>;
}
export interface DoorTree {
  door: Exclude<DoorId, "landing">;
  label: string;
  groups: readonly SidebarGroup[];
}

const leaf = (id: string, label?: string): SidebarLeaf =>
  label === undefined ? { id } : { id, label };
const leaves = (...ids: string[]): SidebarLeaf[] => ids.map((id) => leaf(id));

const sdkPages = (sdk: string, label: string): SidebarGroup => ({
  label,
  collapsed: true,
  items: [
    leaf(`build/quickstart/${sdk}`, "Quickstart"),
    leaf(`build/sdks/${sdk}`, "Reference"),
  ],
});

/**
 * The trees, in the plan's order. Only pages that exist and are not stubs appear: a page joins
 * its tree in the package that writes it (`doors.test.ts` fails on a stub listed here and on a
 * live page listed nowhere).
 */
export const DOOR_TREES: readonly DoorTree[] = [
  {
    door: "help",
    label: "Help",
    groups: [
      { label: "Get started", items: leaves("help/index", "help/activate") },
      { label: "Sign in", items: leaves("help/sign-in") },
      { label: "Devices", items: leaves("help/devices") },
      {
        label: "Downloads and updates",
        items: leaves("help/download", "help/update"),
      },
      { label: "Messages", items: leaves("help/messages/index") },
    ],
  },
  {
    door: "developers",
    label: "Developers",
    groups: [
      {
        label: "Start here",
        items: [
          leaf("start/index", "Overview"),
          leaf("start/first-product"),
          leaf("start/how-it-works"),
          leaf("start/concepts"),
        ],
      },
      {
        label: "Build",
        items: [
          leaf("build/index", "Build map"),
          leaf("build/install"),
          sdkPages("node", "Node"),
          sdkPages("react", "React"),
          sdkPages("python", "Python"),
          sdkPages("swift", "Swift"),
          sdkPages("kotlin", "Kotlin"),
          sdkPages("godot", "Godot"),
          leaf("build/sdks/index", "All SDKs"),
          leaf("build/quickstart/index", "Quickstarts"),
          {
            label: "Drop-in UI kits",
            collapsed: true,
            items: leaves(
              "build/ui/index",
              "build/ui/theming",
              "build/ui/localisation",
              "build/ui/recipes",
              "build/ui/components/index",
              "build/ui/frameworks/index",
              "build/ui/frameworks/compose",
              "build/ui/frameworks/terminal-node",
              "build/ui/frameworks/terminal-python",
            ),
          },
          {
            label: "UI kit components",
            collapsed: true,
            items: leaves(
              "build/ui/components/about",
              "build/ui/components/account-and-license",
              "build/ui/components/activate",
              "build/ui/components/boot",
              "build/ui/components/channel-picker",
              "build/ui/components/cloud-sync-status",
              "build/ui/components/device-limit",
              "build/ui/components/devices",
              "build/ui/components/entitlement-gate",
              "build/ui/components/grace-banner",
              "build/ui/components/license-choice",
              "build/ui/components/offline-activation",
              "build/ui/components/paywall",
              "build/ui/components/polaris-key-gate",
              "build/ui/components/release-notes",
              "build/ui/components/settings",
              "build/ui/components/sign-in-handoff",
              "build/ui/components/sign-in",
              "build/ui/components/status-screen",
              "build/ui/components/toast",
              "build/ui/components/update-progress",
              "build/ui/components/update-prompt",
              "build/ui/components/welcome",
            ),
          },
          {
            label: "The .pkey manifest",
            collapsed: true,
            items: leaves(
              "build/manifest/index",
              "build/manifest/product",
              "build/manifest/distribution",
              "build/manifest/register",
              "build/manifest/json-schema",
            ),
          },
          leaf("build/web-apps"),
        ],
      },
      {
        label: "Licensing",
        collapsed: true,
        items: leaves(
          "features/licensing/index",
          "features/licensing/model",
          "features/licensing/activation",
          "features/licensing/access",
          "features/licensing/relicensing",
          "features/licensing/offline",
          "features/licensing/device-trust",
          "features/licensing/fingerprints",
          "features/licensing/attestation",
          "features/licensing/device-limit",
          "features/licensing/server-verification",
          "features/licensing/manage-licenses",
        ),
      },
      {
        label: "Managed config",
        collapsed: true,
        items: leaves(
          "features/managed-config/index",
          "features/managed-config/catalog",
          "features/managed-config/profiles",
          "features/managed-config/edge-mint",
          "features/managed-config/management-states",
          "features/managed-config/crash-tags",
        ),
      },
      {
        label: "Ship builds",
        collapsed: true,
        items: [
          leaf("features/ship-builds/ci"),
          {
            label: "Releases",
            collapsed: true,
            items: leaves(
              "features/ship-builds/releases/index",
              "features/ship-builds/releases/github-sync",
              "features/ship-builds/releases/artifacts",
              "features/ship-builds/releases/channels",
              "features/ship-builds/releases/compatibility",
            ),
          },
          {
            label: "Channels",
            collapsed: true,
            items: leaves(
              "features/ship-builds/channels/index",
              "features/ship-builds/channels/delivery",
              "features/ship-builds/channels/rollouts",
              "features/ship-builds/channels/availability",
              "features/ship-builds/channels/app-store",
              "features/ship-builds/channels/google-play",
              "features/ship-builds/channels/microsoft-store",
              "features/ship-builds/channels/steam",
              "features/ship-builds/channels/feeds",
              "features/ship-builds/channels/update-health",
              "features/ship-builds/channels/storefronts",
              "features/ship-builds/channels/polaris-key",
            ),
          },
          {
            label: "Updates",
            collapsed: true,
            items: leaves(
              "features/ship-builds/updates/index",
              "features/ship-builds/updates/signed-feed",
              "features/ship-builds/updates/updater-feeds",
              "features/ship-builds/updates/appcast",
              "features/ship-builds/updates/eligibility",
              "features/ship-builds/updates/godot-desktop",
              "features/ship-builds/updates/sparkle",
            ),
          },
          {
            label: "Packages and packs",
            collapsed: true,
            items: leaves(
              "features/ship-builds/packages/index",
              "features/ship-builds/packs/index",
              "features/ship-builds/packs/transports",
            ),
          },
          leaf("features/ship-builds/commerce"),
        ],
      },
      {
        label: "Sign-in",
        collapsed: true,
        items: leaves(
          "features/sign-in/index",
          "features/sign-in/oidc",
          "features/sign-in/device-flow",
          "features/sign-in/sessions",
          "features/sign-in/customer-portal",
        ),
      },
      {
        label: "Cloud Sync",
        collapsed: true,
        items: leaves("features/cloud-sync/index"),
      },
      {
        label: "Reference",
        collapsed: true,
        items: [
          leaf("reference/index", "Overview"),
          ...leaves(
            "reference/http-api",
            "reference/error-codes",
            "reference/validation-codes",
            "reference/settings",
            "reference/config-entry",
            "reference/parity",
            "reference/routes",
            "reference/generators",
            "reference/what-apps-collect",
          ),
          {
            label: "Protocol",
            collapsed: true,
            items: leaves(
              "reference/protocol/index",
              "reference/protocol/envelope",
              "reference/protocol/trust",
              "reference/protocol/discovery",
              "reference/protocol/device-principal",
              "reference/protocol/errors",
              "reference/protocol/cache-and-clock",
              "reference/protocol/license-document",
              "reference/protocol/config-document",
              "reference/protocol/bundles",
              "reference/protocol/packs",
              "reference/protocol/fingerprint-constants",
              "reference/protocol/corpus",
            ),
          },
        ],
      },
    ],
  },
  {
    door: "operate",
    label: "Operate",
    groups: [
      {
        label: "Console",
        items: leaves(
          "operate/index",
          "operate/console/tour",
          "operate/console/products",
          "operate/console/users",
          "operate/console/presentation",
          "operate/console/keys-and-secrets",
          "operate/console/activity",
        ),
      },
      {
        label: "Platform",
        collapsed: true,
        items: leaves(
          "operate/platform/runbook/index",
          "operate/platform/deploy",
          "operate/platform/security",
          "operate/platform/settings",
          "operate/platform/jobs",
          "operate/platform/connections",
        ),
      },
      {
        label: "Contribute",
        collapsed: true,
        items: leaves(
          "contribute/index",
          "contribute/setup",
          "contribute/layout",
          "contribute/architecture",
          "contribute/release-truth-store",
          "contribute/waves",
          "contribute/corpus",
          "contribute/releasing",
          "contribute/package-feeds",
          "contribute/data-model",
          "contribute/docs-components",
          "contribute/agents/index",
          "contribute/agents/recipes",
          "contribute/agents/conventions",
        ),
      },
    ],
  },
];

/** Every content id in the trees. */
export function treeIds(trees: readonly DoorTree[] = DOOR_TREES): string[] {
  const out: string[] = [];
  const walk = (items: SidebarGroup["items"]): void => {
    for (const item of items) {
      if ("id" in item) out.push(item.id);
      else walk(item.items);
    }
  };
  for (const tree of trees) for (const group of tree.groups) walk(group.items);
  return out;
}

/** Starlight's `slug` for a content id: an index page is its directory. */
export const slugOf = (id: string): string =>
  id === "index" ? "index" : id.replace(/\/index$/, "");

type StarlightItem =
  | { slug: string; label?: string }
  | { label: string; collapsed?: boolean; items: StarlightItem[] };

const toStarlight = (item: SidebarLeaf | SidebarGroup): StarlightItem =>
  "id" in item
    ? item.label === undefined
      ? { slug: slugOf(item.id) }
      : { slug: slugOf(item.id), label: item.label }
    : {
        label: item.label,
        ...(item.collapsed === undefined ? {} : { collapsed: item.collapsed }),
        items: item.items.map(toStarlight),
      };

/** The Starlight `sidebar` option: the trees' groups in door order. */
export function starlightSidebar(
  trees: readonly DoorTree[] = DOOR_TREES,
): StarlightItem[] {
  return trees.flatMap((tree) =>
    tree.groups.map((group) => toStarlight(group)),
  );
}
