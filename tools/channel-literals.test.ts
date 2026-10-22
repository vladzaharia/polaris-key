// A-19b: the store-name literal lint and the per-channel docs check.
//
// The repo has no ESLint, so a test is the lint. Rule 5 of AGENTS.md: a store's display name is
// DATA, owned by tools/channels.json and read through `channelLabel` / `findChannel`
// (@polaris-key/manifest). A string literal in the console, the Locker portal, the Worker or the
// CLI that is exactly a catalogue label ("Steam", "Google Play", "itch.io", ...) fails here.
//
// The rule is "the whole literal is a store name" (a quoted string, or JSX text between tags), not
// "the word appears": prose such as "App Store Connect" or a sentence naming a store is copy and
// is out of scope. Comment lines are skipped. A label that is also its own id or is a brand, not
// a store ("winget", "Web", "Polaris Locker"), is not matched.
//
// BASELINE: the literals that remain, per file, with the reason. It only shrinks: a file with
// fewer hits than its row (or none) fails until the row is lowered, so a migration cannot
// quietly regress. A new literal in a new file fails outright.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadTable } from "./gen-channels.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Store names the catalogue does not carry yet, so a literal is refused before the entry lands. */
const EXTRA_NAMES = [
  "Epic",
  "Epic Games Store",
  "Mac App Store",
  "Google Play Store",
  "Play Store",
  "Windows Store",
];

/** Labels that are brands or their own id, not a store display name. */
const NOT_STORE_NAMES = new Set(["Web", "Polaris Locker"]);

export function forbiddenNames(): string[] {
  const labels = loadTable()
    .channels.filter((c) => !NOT_STORE_NAMES.has(c.label) && c.label !== c.id)
    .map((c) => c.label);
  return [...new Set([...labels, ...EXTRA_NAMES])];
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The store-name literals in one source text: `{ line, name }` per hit. */
export function findLiterals(
  source: string,
  names: readonly string[] = forbiddenNames(),
): { line: number; name: string }[] {
  const alt = names.map(esc).join("|");
  const quoted = new RegExp(`(["'\`])(${alt})\\1`, "g");
  const jsx = new RegExp(`>\\s*(${alt})\\s*<`, "g");
  const hits: { line: number; name: string }[] = [];
  source.split("\n").forEach((text, i) => {
    if (/^\s*(\*|\/\/|\/\*)/.test(text)) return;
    for (const m of text.matchAll(quoted))
      hits.push({ line: i + 1, name: m[2]! });
    for (const m of text.matchAll(jsx)) hits.push({ line: i + 1, name: m[1]! });
  });
  return hits;
}

const SCAN_ROOTS = [
  "packages/admin/src",
  "packages/worker/src",
  "packages/cli/src",
];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.generated\.|\.test\./.test(name))
      out.push(path);
  }
}

export function scan(
  roots: readonly string[],
  base: string,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const root of roots) {
    const files: string[] = [];
    walk(join(base, root), files);
    for (const f of files) {
      const n = findLiterals(readFileSync(f, "utf8")).length;
      if (n > 0) counts.set(relative(base, f), n);
    }
  }
  return counts;
}

/**
 * What is left, and why. Sign-in providers are not channels (Steam the sign-in provider is not
 * Steam the store); stories and docs-of-copy are fixtures. Each row only shrinks.
 */
const DECLARATION =
  "declaration module: may import only types from the manifest package (boundaries test), so it spells its label; gen-channels.test.ts keeps it equal to the catalogue";

const BASELINE: Record<string, { count: number; why: string }> = {
  "packages/worker/src/core/storefront/listingProfiles.ts": {
    count: 6,
    why: DECLARATION,
  },
  "packages/worker/src/core/storefront/prPlane.ts": {
    count: 1,
    why: DECLARATION,
  },
  "packages/worker/src/core/storefront/stores/flathub.ts": {
    count: 2,
    why: DECLARATION,
  },
  "packages/worker/src/core/storefront/stores/googlePlay.ts": {
    count: 2,
    why: DECLARATION,
  },
  "packages/worker/src/core/storefront/stores/itch.ts": {
    count: 2,
    why: DECLARATION,
  },
  "packages/worker/src/core/storefront/stores/microsoftStore.ts": {
    count: 1,
    why: DECLARATION,
  },
  "packages/worker/src/core/storefront/stores/snap.ts": {
    count: 2,
    why: DECLARATION,
  },
  "packages/worker/src/core/storefront/ciPlane.ts": {
    count: 5,
    why: "declaration module; Epic Games Store is not a catalogue channel yet",
  },
  "packages/admin/src/console/sections/distribution/pages/CommercePage.tsx": {
    count: 1,
    why: "at its page-budget ceiling; the import line would grow it",
  },
  "packages/admin/src/console/sections/core/pages/UserRecord.tsx": {
    count: 2,
    why: "sign-in provider names (Steam, Epic), not channels",
  },
  "packages/admin/src/console/sections/identity/components/SignInSections.tsx":
    { count: 1, why: "sign-in provider name" },
  "packages/admin/src/kit/stories/data.tsx": {
    count: 4,
    why: "kit story fixtures",
  },
  "packages/admin/src/kit/stories/forms.tsx": {
    count: 2,
    why: "kit story fixtures",
  },
  "packages/admin/src/kit/stories/values.tsx": {
    count: 1,
    why: "kit story fixtures",
  },
  "packages/admin/src/portal/components/LinkAccountsDialog.tsx": {
    count: 1,
    why: "sign-in provider name",
  },
  "packages/admin/src/portal/components/signin/FinishStep.tsx": {
    count: 1,
    why: "sign-in provider name",
  },
  "packages/admin/src/portal/components/signin/HintStep.tsx": {
    count: 1,
    why: "sign-in provider name",
  },
  "packages/admin/src/portal/model/methods.ts": {
    count: 2,
    why: "sign-in provider name",
  },
  "packages/admin/src/portal/model/profile.ts": {
    count: 1,
    why: "sign-in provider name",
  },
  "packages/admin/src/ui/auth/ProviderRow.tsx": {
    count: 1,
    why: "sign-in provider name",
  },
  "packages/worker/src/console/handlers/platformConnections.ts": {
    count: 1,
    why: "sign-in provider name (BUILTIN_LABELS)",
  },
  "packages/worker/src/services/identity/accounts/links.ts": {
    count: 1,
    why: "sign-in provider name",
  },
  "packages/worker/src/services/identity/portal/methods.ts": {
    count: 1,
    why: "sign-in provider name",
  },
  "packages/worker/src/services/identity/providers/flow.ts": {
    count: 1,
    why: "sign-in provider name",
  },
};

describe("store-name literals come from the channel catalogue (rule 5)", () => {
  it("the current names are seeded from the catalogue", () => {
    const names = forbiddenNames();
    for (const n of [
      "Steam",
      "App Store",
      "Google Play",
      "itch.io",
      "Microsoft Store",
      "Epic",
      "Flathub",
    ])
      expect(names).toContain(n);
    expect(names).not.toContain("winget");
    expect(names).not.toContain("Web");
  });

  it("flags a store-name literal (negative controls)", () => {
    const bad = [
      `const x = { label: "Steam" };`,
      `const x = 'Google Play';`,
      "const x = `itch.io`;",
      `<span>App Store</span>`,
      `<b> Microsoft Store </b>`,
      `const x = "Epic";`,
    ];
    for (const src of bad) expect(findLiterals(src), src).toHaveLength(1);
  });

  it("does not flag the sanctioned forms (positive controls)", () => {
    const ok = [
      `const x = channelLabel("steam");`,
      `const x = "App Store Connect API key";`,
      `const x = "Open it in the App Store.";`,
      `const x = "winget";`,
      `const x = "Web";`,
      `// "Steam" in a comment`,
      ` * ("Google Play") in a doc comment`,
      `const steam = "steam";`,
    ];
    for (const src of ok) expect(findLiterals(src), src).toEqual([]);
  });

  it("fails a file outside the baseline (a planted literal is caught)", () => {
    const hits = findLiterals(`export const L = { play: "Google Play" };`);
    expect(hits).toEqual([{ line: 1, name: "Google Play" }]);
  });

  it("no source outside the baseline names a store, and the baseline only shrinks", () => {
    const found = scan(SCAN_ROOTS, ROOT);
    const problems: string[] = [];
    for (const [file, count] of found) {
      const row = BASELINE[file];
      if (!row)
        problems.push(
          `${file}: ${count} store-name literal(s); use channelLabel(id) from @polaris-key/manifest`,
        );
      else if (count > row.count)
        problems.push(`${file}: ${count} literals, baseline ${row.count}`);
      else if (count < row.count)
        problems.push(
          `${file}: ${count} literals, baseline ${row.count}; lower the baseline row`,
        );
    }
    for (const file of Object.keys(BASELINE))
      if (!found.has(file))
        problems.push(`${file}: clean now; delete its baseline row`);
    expect(problems).toEqual([]);
  });
});

// ── The per-channel docs check ──────────────────────────────────────────────────────────────────

const DOCS = join(ROOT, "packages/docs/src/content/docs/features/ship-builds");
const CHANNEL_PAGES = join(DOCS, "channels");

/** GitHub-style heading slug (what Starlight emits). */
export function slug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

function headings(file: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    const m = !fenced && /^#{2,6}\s+(.*?)\s*$/.exec(line);
    if (m) out.push(slug(m[1]!.replace(/`/g, "")));
  }
  return out;
}

const pageFile = (rel: string): string | null => {
  for (const ext of [".md", ".mdx"]) {
    const p = join(DOCS, rel + ext);
    if (existsSync(p)) return p;
  }
  return null;
};

/**
 * Where a channel without its own `channels/<id>` page is documented: `page#anchor`, relative to
 * features/ship-builds. The anchor must be a heading on that page, and the page must name the
 * channel's catalogue label.
 */
const DOCS_HOMES: Record<string, string> = {
  testflight: "channels/app-store",
  "play-testing": "channels/google-play",
  altstore: "channels/feeds#altstore-sidestore-and-altstore-pal",
  "altstore-pal": "channels/feeds#altstore-sidestore-and-altstore-pal",
  obtainium: "channels/feeds#obtainium",
  fdroid: "channels/feeds#the-f-droid-repository",
  scoop: "channels/feeds#scoop",
  flathub: "channels/feeds#flathub",
  "app-installer": "updates/updater-feeds#msix-app-installer",
  winget: "ci-stores#pull-request-steps-winget-homebrew-scoop-and-flathub",
  homebrew: "ci-stores#pull-request-steps-winget-homebrew-scoop-and-flathub",
  itch: "ci-stores#storefront-steps-itchio-and-snap",
  snap: "ci-stores#storefront-steps-itchio-and-snap",
  web: "channels/index#channels-and-transports",
};

describe("every catalogue channel has its docs page or anchor", () => {
  const channels = loadTable().channels;

  it("a channel has its own page or a DOCS_HOMES row, never both stale", () => {
    const missing: string[] = [];
    for (const c of channels) {
      const own = pageFile(`channels/${c.id}`) !== null;
      if (!own && !(c.id in DOCS_HOMES))
        missing.push(`${c.id}: no channels/${c.id} page and no DOCS_HOMES row`);
      if (own && c.id in DOCS_HOMES)
        missing.push(`${c.id}: has its own page; delete its DOCS_HOMES row`);
    }
    for (const id of Object.keys(DOCS_HOMES))
      if (!channels.some((c) => c.id === id))
        missing.push(
          `${id}: DOCS_HOMES row for a channel not in the catalogue`,
        );
    expect(missing).toEqual([]);
  });

  it("each home page exists, has the anchor, and names the channel", () => {
    const problems: string[] = [];
    for (const c of channels) {
      const home = DOCS_HOMES[c.id] ?? `channels/${c.id}`;
      const [rel, anchor] = home.split("#") as [string, string | undefined];
      const file = pageFile(rel);
      if (!file) {
        problems.push(`${c.id}: page ${rel} does not exist`);
        continue;
      }
      if (anchor && !headings(file).includes(anchor))
        problems.push(`${c.id}: ${rel} has no heading #${anchor}`);
      if (
        c.id !== "web" &&
        !new RegExp(`${esc(c.label)}|\`${esc(c.id)}\``, "i").test(
          readFileSync(file, "utf8"),
        )
      )
        problems.push(`${c.id}: ${rel} never names "${c.label}"`);
    }
    expect(problems).toEqual([]);
  });

  it("a renamed heading is caught (negative control)", () => {
    const file = pageFile("channels/feeds")!;
    expect(headings(file)).toContain("obtainium");
    expect(headings(file)).not.toContain("obtainium-renamed");
  });
});
