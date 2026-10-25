// The recipes import `@polaris-key/elements`, which is not on a feed yet. Inside the repo it is
// aliased to the package's build (`pnpm --filter @polaris-key/elements build` first), as
// ../elements/vite.repo.config.ts does. Once the package is published, delete this file and
// depend on it.
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(
  new URL("../../../packages/elements/dist/", import.meta.url),
);

/** Vite `resolve.alias` entries for the repo's build of @polaris-key/elements. */
export const elementsAlias = [
  {
    find: /^@polaris-key\/elements\/(headless|contract)$/,
    replacement: `${dist}$1.js`,
  },
  { find: /^@polaris-key\/elements$/, replacement: `${dist}index.js` },
];

/** Vite `server.fs.allow`: the dev server may read the repo's build. */
export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
