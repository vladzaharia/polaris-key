import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * `examples/server-*` install the package from the feed and have no node_modules here. For
 * test/examples.test.ts only: a bare import from a file under examples/ resolves as if the file
 * lived in this package, so `@polaris-key/server/*` finds src/ and `express`/`hono`/`fastify`/`koa`/`@nestjs/*` find the dev
 * dependencies.
 */
function examplesAsConsumers(): Plugin {
  return {
    name: "examples-as-consumers",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer || !importer.includes("/examples/")) return null;
      const sub =
        /^@polaris-key\/server\/(express|hono|next|fastify|koa|nestjs|testing)$/.exec(
          source,
        );
      if (sub) return join(here, "src", `${sub[1]}.ts`);
      if (
        /^(express|hono|@hono\/|fastify|koa|@koa\/|@nestjs\/|reflect-metadata|rxjs)/.test(
          source,
        )
      )
        return this.resolve(source, join(here, "src", "index.ts"), {
          ...options,
          skipSelf: true,
        });
      return null;
    },
  };
}

// Default timeouts sized for a loaded machine or a slow CI runner, where vitest's 5 s / 10 s
// defaults trip on tests that take well under a second when idle. A test that bounds its own
// time asserts that bound itself; these only keep the runner from failing it first.
export default defineConfig({
  plugins: [examplesAsConsumers()],
  test: {
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
