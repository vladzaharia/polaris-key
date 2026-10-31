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
  ["access/", "landing", "public"],
  ["help/", "help", "public"],
  ["start/", "developers", "public"],
  ["build/", "developers", "public"],
  ["features/", "developers", "public"],
  ["reference/", "developers", "public"],
  ["operate/platform/", "operate", "admin"],
  ["operate/", "operate", "member"],
  ["contribute/", "operate", "admin"],
];

/**
 * The Pagefind bundles, lowest tier first: each holds its tier's pages and every tier below it.
 * `scripts/build-search-bundles.ts` builds them; the worker serves each at its tier
 * (`SEARCH_BUNDLES`, `packages/worker/src/docs.ts`, pinned by `docsGate.test.ts`).
 */
export const SEARCH_BUNDLES: ReadonlyArray<readonly [dir: string, tier: Tier]> =
  [
    ["pagefind", "public"],
    ["pagefind-member", "member"],
    ["pagefind-admin", "admin"],
    // Help's own search (polaris.locker): the Help pages only, so a customer's results are all
    // pages the customer host serves. Help's pages load this one (see HELP_SEARCH_BUNDLE).
    ["pagefind-help", "public"],
  ];

/** The bundle that holds only the Help pages; Help's search loads it (astro.config.mjs). */
export const HELP_SEARCH_BUNDLE = "pagefind-help";

/** The door and tier of a content id such as `help/activate`. Null for a path no door owns. */
export function doorOf(
  id: string,
): { door: DoorId; tier: Tier; prefix: string } | null {
  let best: (typeof TIER_PREFIXES)[number] | null = null;
  // Starlight's route id for the site's root page is empty; the table calls it `index`.
  if (id === "") id = "index";
  for (const row of TIER_PREFIXES) {
    // A section's own page (`help` for help/index) belongs to the section.
    const hit = row[0].endsWith("/")
      ? id.startsWith(row[0]) || `${id}/` === row[0]
      : id === row[0];
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

/** An SDK's pages. `ownUi`: the SDK's reference is a folder with a "Your own UI" page. */
const sdkPages = (sdk: string, label: string, ownUi = false): SidebarGroup => ({
  label,
  collapsed: true,
  items: ownUi
    ? [
        leaf(`build/quickstart/${sdk}`, `${label} quickstart`),
        leaf(`build/sdks/${sdk}/index`, `${label} reference`),
        leaf(`build/sdks/${sdk}/your-own-ui`, `${label}: your own UI`),
      ]
    : [
        leaf(`build/quickstart/${sdk}`, `${label} quickstart`),
        leaf(`build/sdks/${sdk}`, `${label} reference`),
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
      {
        label: "Get started",
        items: [
          leaf("help/index", "Help home"),
          ...leaves(
            "help/what-is-polaris-locker",
            "help/activate",
            "help/emails",
            "help/contact",
          ),
        ],
      },
      {
        label: "Sign in",
        items: leaves(
          "help/sign-in",
          "help/code-didnt-arrive",
          "help/passkeys",
          "help/approve-a-sign-in",
          "help/secure-your-account",
          "help/work-account",
          "help/messages/signing-in",
        ),
      },
      {
        label: "Your library",
        items: leaves(
          "help/library",
          "help/add-a-license",
          "help/discover",
          "help/lost-key",
          "help/license-status",
          "help/messages/license-status",
          "help/remove-from-library",
          "help/messages/license-key",
        ),
      },
      {
        label: "Devices",
        items: leaves(
          "help/devices",
          "help/nearby-devices",
          "help/new-computer",
          "help/device-limit",
          "help/offline-activation",
          "help/messages/devices",
        ),
      },
      {
        label: "Downloads and updates",
        items: leaves(
          "help/download",
          "help/check-a-download",
          "help/install-sources",
          "help/update",
          "help/packages",
          "help/messages/downloads-and-updates",
        ),
      },
      {
        label: "Purchases",
        items: leaves("help/restore-purchase", "help/refunds"),
      },
      {
        label: "Account and privacy",
        items: leaves(
          "help/account",
          "help/join-accounts",
          "help/delete-account",
          "help/your-data",
          "help/manage-your-data",
          "help/sync",
          "help/messages/accounts",
        ),
      },
      {
        label: "Messages",
        items: leaves("help/messages/index", "help/messages/other"),
      },
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
          leaf("start/choose-your-integration"),
          leaf("start/how-it-works"),
          leaf("start/concepts"),
        ],
      },
      {
        label: "Build",
        items: [
          leaf("build/index", "Build map"),
          leaf("build/install"),
          leaf("build/upgrade-to-0-9"),
          sdkPages("node", "Node", true),
          sdkPages("react", "React", true),
          sdkPages("python", "Python", true),
          sdkPages("swift", "Swift", true),
          sdkPages("kotlin", "Kotlin", true),
          sdkPages("godot", "Godot", true),
          leaf("build/sdks/index", "All SDKs"),
          {
            label: "Your server",
            collapsed: true,
            items: [
              leaf("build/servers/index", "Verify licenses on your server"),
              ...leaves(
                "build/servers/express",
                "build/servers/hono",
                "build/servers/next",
                "build/servers/fastapi",
                "build/servers/starlette",
                "build/servers/flask",
                "build/servers/django",
                "build/servers/drf",
                "build/servers/ktor",
                "build/servers/spring",
              ),
            ],
          },
          {
            label: "Drop-in UI kits",
            collapsed: true,
            items: leaves(
              "build/ui/index",
              "build/ui/theming",
              "build/ui/localization",
              "build/ui/components/index",
              "build/ui/frameworks/index",
              "build/ui/recipes",
              "build/ui/frameworks/react",
              "build/ui/frameworks/elements",
              "build/ui/frameworks/electron",
              "build/ui/frameworks/swiftui",
              "build/ui/frameworks/compose",
              "build/ui/frameworks/godot",
              "build/ui/frameworks/terminal-node",
              "build/ui/frameworks/qt",
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
              "build/manifest/register",
              "build/manifest/product",
              "build/manifest/catalog",
              "build/manifest/release",
              "build/manifest/distribution",
              "build/manifest/json-schema",
            ),
          },
          leaf("build/web-apps"),
          leaf("build/local", "Run Polaris Key locally"),
          leaf("build/test-your-integration"),
          leaf("build/go-live"),
          leaf("build/troubleshooting"),
        ],
      },
      {
        label: "Licensing",
        collapsed: true,
        items: leaves(
          "features/licensing/index",
          "features/licensing/add-licensing",
          "features/licensing/manage-licenses",
          "features/licensing/invitations",
          "features/licensing/device-limit",
          "features/licensing/attestation",
          "features/licensing/server-verification",
          "features/licensing/server-node",
          "features/licensing/server-python",
          "features/licensing/server-kotlin",
          "features/licensing/model",
          "features/licensing/activation",
          "features/licensing/access",
          "features/licensing/relicensing",
          "features/licensing/offline",
          "features/licensing/fingerprints",
          "features/licensing/device-trust",
          "features/licensing/troubleshooting",
        ),
      },
      {
        label: "Managed config",
        collapsed: true,
        items: leaves(
          "features/managed-config/index",
          "features/managed-config/add-config",
          "features/managed-config/catalog",
          "features/managed-config/management-states",
          "features/managed-config/profiles",
          "features/managed-config/edge-mint",
          "features/managed-config/crash-tags",
          "features/managed-config/troubleshooting",
        ),
      },
      {
        label: "Ship builds",
        collapsed: true,
        items: [
          leaf("features/ship-builds/index"),
          leaf("features/ship-builds/publish-first-release"),
          leaf("features/ship-builds/ci"),
          {
            label: "Releases",
            collapsed: true,
            items: leaves(
              "features/ship-builds/releases/index",
              "features/ship-builds/releases/github-sync",
              "features/ship-builds/releases/artifacts",
              "features/ship-builds/releases/trusted-publishing",
              "features/ship-builds/releases/channels",
              "features/ship-builds/releases/compatibility",
            ),
          },
          {
            label: "Channels",
            collapsed: true,
            items: leaves(
              "features/ship-builds/channels/index",
              "features/ship-builds/channels/distribution-matrix",
              "features/ship-builds/channels/delivery",
              "features/ship-builds/channels/rollouts",
              "features/ship-builds/channels/availability",
              "features/ship-builds/channels/app-store",
              "features/ship-builds/channels/app-store-distribute",
              "features/ship-builds/channels/google-play",
              "features/ship-builds/channels/microsoft-store",
              "features/ship-builds/channels/steam",
              "features/ship-builds/channels/feeds",
              "features/ship-builds/channels/itch",
              "features/ship-builds/channels/snap",
              "features/ship-builds/channels/homebrew",
              "features/ship-builds/channels/scoop",
              "features/ship-builds/channels/winget",
              "features/ship-builds/channels/flathub",
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
              "features/ship-builds/packages/publish",
              "features/ship-builds/packs/index",
              "features/ship-builds/packs/ship-a-pack",
              "features/ship-builds/packs/transports",
            ),
          },
          leaf("features/ship-builds/troubleshooting"),
        ],
      },
      {
        label: "Sign-in",
        collapsed: true,
        items: leaves(
          "features/sign-in/index",
          "features/sign-in/add-sign-in",
          "features/sign-in/oidc",
          "features/sign-in/web-redirect",
          "features/sign-in/device-flow",
          "features/sign-in/sessions",
          "features/sign-in/customer-portal",
          "features/sign-in/troubleshooting",
        ),
      },
      {
        label: "Cloud Sync",
        collapsed: true,
        items: leaves("features/cloud-sync/index"),
      },
      {
        label: "Commerce",
        collapsed: true,
        items: leaves("features/commerce/index"),
      },
      {
        label: "Cloud Connect",
        collapsed: true,
        items: leaves(
          "features/cloud-connect/index",
          "features/cloud-connect/channels",
          "features/cloud-connect/relay",
        ),
      },
      {
        label: "Reference",
        collapsed: true,
        items: [
          leaf("reference/index", "Overview"),
          ...leaves(
            "reference/http-api",
            "reference/cli",
            "reference/github-action",
            "reference/error-codes",
            "reference/validation-codes",
            "reference/settings",
            "reference/roles",
            "reference/config-entry",
            "reference/parity",
            "reference/routes",
            "reference/portal-api",
            "reference/generators",
            "reference/api-names",
            "reference/channels",
            "reference/changelog/index",
            "reference/compatibility",
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
              "reference/protocol/peer",
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
          "operate/console/product-actions",
          "operate/console/users",
          "operate/console/members",
          "operate/console/presentation",
          "operate/console/keys-and-secrets",
          "operate/console/activity",
          "operate/console/help-a-customer",
        ),
      },
      {
        label: "Platform",
        collapsed: true,
        items: leaves(
          "operate/platform/incidents",
          "operate/platform/runbook/index",
          "operate/platform/runbook/deploy-a-release",
          "operate/platform/runbook/rotate-the-kek",
          "operate/platform/runbook/respond-to-a-key-compromise",
          "operate/platform/runbook/run-product-operations",
          "operate/platform/runbook/set-up-sign-in-email",
          "operate/platform/runbook/set-up-the-login-card",
          "operate/platform/runbook/change-licensing-data",
          "operate/platform/runbook/restore-data-and-run-storage-jobs",
          "operate/platform/runbook/migration-ledger",
          "operate/platform/runbook/load-test-cloud-sync",
          "operate/platform/runbook/troubleshooting",
          "operate/platform/deploy",
          "operate/platform/email",
          "operate/platform/security",
          "operate/platform/settings",
          "operate/platform/jobs",
          "operate/platform/connections",
          "operate/platform/sign-in-connections",
          "operate/platform/outlet-credentials",
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
          "contribute/corpus-cases",
          "contribute/service-model",
          "contribute/writing-docs",
          "contribute/releasing",
          "contribute/package-feeds",
          "contribute/data-model",
          "contribute/docs-components",
          "contribute/console",
          "contribute/motion",
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
