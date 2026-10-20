/**
 * The labels Help quotes from the portal are the portal's: each bold label a Help page quotes
 * below is a string in the portal source, and the page still quotes it. A portal copy change that
 * leaves a Help page quoting the old words fails here, at the docs build, not in front of a reader.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const docsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(docsRoot, "..", "..");
const portalRoot = join(repoRoot, "packages", "admin", "src", "portal");
const helpDir = join(docsRoot, "src", "content", "docs", "help");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx?|json)$/.test(name) ? [path] : [];
  });
}
const portalSource = sourceFiles(portalRoot)
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

/** Help page (file name) → the portal labels it quotes in bold. */
const QUOTED: Record<string, string[]> = {
  "delete-account.mdx": [
    "Delete account…",
    "Schedule your Polaris Locker account for deletion?",
    "Schedule deletion",
    "Cancel deletion",
    "Deletion canceled",
    "Confirm it's you first",
  ],
  "sign-in.mdx": [
    "Confirm it's you first",
    "Use your passkey",
    "Email me a code",
    "Use an email code instead",
    "Confirm",
  ],
  "passkeys.mdx": [
    "Confirm it's you first",
    "Use your passkey",
    "Use an email code instead",
    "Email me a code",
  ],
};

describe("labels Help quotes from the portal", () => {
  for (const [file, labels] of Object.entries(QUOTED))
    for (const label of labels)
      it(`${file} quotes "${label}", and the portal says it`, () => {
        const page = readFileSync(join(helpDir, file), "utf8").replace(
          /\s+/g,
          " ",
        );
        expect(page, `${file} no longer quotes it`).toContain(`**${label}**`);
        expect(
          portalSource.includes(label) ||
            portalSource.includes(label.replace(/'/g, "’")),
          `the portal source has no "${label}"`,
        ).toBe(true);
      });
});
