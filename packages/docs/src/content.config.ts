import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

// The docs collection: everything under src/content/docs. Repo files that must stay at their
// canonical homes (SDK READMEs — they render on the package registries; docs/RUNBOOK.md and
// friends — they are the operator's greppable source) are pulled in by thin MDX wrapper pages
// that IMPORT the markdown (see e.g. build/sdks/node.mdx), so there is exactly one source per
// document and the site can never drift from it.
export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
};
