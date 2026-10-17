// A Vite plugin for the pages that render a repository Markdown file whole (an SDK README,
// DEPLOYMENT.md, PRIVACY.md, the style guide: `import { Content } from "…/README.md"`). The
// page's frontmatter title is its H1, so the file's own H1 would be a second one. The plugin
// resolves such an import to a copy with its H1 lines removed, written under .astro/imported/
// (a build product, gitignored with .astro). The file itself is never edited.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const docsRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(docsRoot, ".astro", "imported");
const CONTENT = join(docsRoot, "src", "content") + "/";

/** The text without its level-1 headings (fenced code left alone). */
export function withoutH1(text) {
  let fence = false;
  return text
    .split("\n")
    .filter((line) => {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence;
      return fence || !/^# /.test(line);
    })
    .join("\n");
}

export default function importedMarkdown() {
  return {
    name: "pk-imported-markdown",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!source.endsWith(".md") || !importer) return null;
      if (!/\.mdx(\?|$)/.test(importer)) return null;
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      const id = resolved?.id;
      if (!id || !id.endsWith(".md") || id.startsWith(CONTENT)) return null;
      mkdirSync(OUT, { recursive: true });
      const out = join(
        OUT,
        `${createHash("sha1").update(id).digest("hex").slice(0, 8)}-${basename(id)}`,
      );
      writeFileSync(out, withoutH1(readFileSync(id, "utf8")));
      return out;
    },
  };
}
