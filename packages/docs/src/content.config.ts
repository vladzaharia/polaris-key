import { readFileSync } from "node:fs";
import { defineCollection, z } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import services from "../../../tools/services.json";
import {
  LANE_IDS,
  PAGE_STATUSES,
  PAGE_TYPES,
  RUNBOOK_FILES,
  SDK_IDS,
} from "./lib/docs";
import { splitSections } from "./lib/runbook";

const SERVICE_SLUGS = (
  services as { services: { slug: string }[] }
).services.map((s) => s.slug) as [string, ...string[]];

// The docs collection: everything under src/content/docs. Repo files that must stay at their
// canonical homes (SDK READMEs — they render on the package registries; docs/RUNBOOK.md and
// friends — they are the operator's greppable source) are pulled in by thin MDX wrapper pages
// that IMPORT the markdown (see e.g. build/sdks/node.mdx), so there is exactly one source per
// document and the site can never drift from it.
//
// Frontmatter beyond Starlight's (docs plan §2). The audience and the access tier are NOT
// frontmatter: they come from the directory (src/lib/doors.ts). Every field is optional in the
// schema so a page written before the plan still builds; `scripts/lint-docs.mjs` is what asks a
// page for `type` and `lastReviewed`, and its ledger (lint-debt.json) only shrinks.
const docs = defineCollection({
  loader: docsLoader(),
  schema: docsSchema({
    extend: z.object({
      // overview | quickstart | how-to | concept | reference | troubleshooting | help |
      // help-messages | runbook
      type: z.enum(PAGE_TYPES).optional(),
      // Service slugs from tools/services.json: the accent, the Requires chips, search filters.
      services: z.array(z.enum(SERVICE_SLUGS)).optional(),
      // Shows the SDK picker; the console's link test reads it.
      sdks: z.array(z.enum(SDK_IDS)).optional(),
      // Shows the lane tabs; the console's link test reads it.
      lanes: z.array(z.enum(LANE_IDS)).optional(),
      // Required on hand-written pages (the lint asks); generated pages show their source.
      lastReviewed: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/, "lastReviewed is YYYY-MM-DD")
        .optional(),
      // `stub` is a hidden placeholder that reserves a path (gone by the 0.9.x exit).
      status: z.enum(PAGE_STATUSES).optional(),
    }),
  }),
});

// The operator files (docs/RUNBOOK.md, docs/DEPLOYMENT.md) stay whole at their canonical homes;
// this collection holds one entry per H2 section so `<RunbookSection>` can render a section as a
// page of its own. The source is read, never copied: there is one copy to keep current.
const runbook = defineCollection({
  loader: {
    name: "runbook-sections",
    load: async ({ store, renderMarkdown, generateDigest }) => {
      store.clear();
      for (const file of RUNBOOK_FILES) {
        const text = readFileSync(
          new URL(`../../../docs/${file}.md`, import.meta.url),
          "utf8",
        );
        for (const part of splitSections(text)) {
          store.set({
            id: `${file}/${part.slug}`,
            data: { file, heading: part.heading },
            body: part.body,
            rendered: await renderMarkdown(part.body),
            digest: generateDigest(part.body),
          });
        }
      }
    },
  },
  schema: z.object({ file: z.enum(RUNBOOK_FILES), heading: z.string() }),
});

export const collections = { docs, runbook };
