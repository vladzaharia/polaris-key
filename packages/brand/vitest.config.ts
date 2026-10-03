import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// React 19 lives in a fixture workspace package (test/react19) so its react-dom resolves its own
// react peer; aliasing two majors inside one package would pair react-dom 19 with react 18.
const r19 = (p: string) =>
  fileURLToPath(new URL(`./test/react19/node_modules/${p}`, import.meta.url));

// Two projects: every suite under React 18 (the dev dependency), and the React rendering suite
// again under React 19, because the peer range is ">=18" and both majors must work.
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "react18",
          environment: "node",
          include: ["test/**/*.test.{ts,tsx}"],
        },
      },
      {
        extends: true,
        test: {
          name: "react19",
          environment: "node",
          include: ["test/react.test.tsx"],
          server: { deps: { inline: [/@polaris-key\/brand/] } },
        },
        resolve: {
          alias: [
            { find: /^react$/, replacement: r19("react/index.js") },
            {
              find: /^react\/jsx-runtime$/,
              replacement: r19("react/jsx-runtime.js"),
            },
            {
              find: /^react\/jsx-dev-runtime$/,
              replacement: r19("react/jsx-dev-runtime.js"),
            },
            {
              find: /^react-dom\/server$/,
              replacement: r19("react-dom/server.node.js"),
            },
          ],
        },
      },
    ],
  },
});
