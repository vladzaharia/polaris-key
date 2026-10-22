import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The React 19 fixture is its own workspace package: react-dom must resolve the same React
// major, which an alias inside the SDK package cannot guarantee.
const react19 = (path: string) =>
  fileURLToPath(
    new URL(`./test/react19/node_modules/${path}`, import.meta.url),
  );

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    projects: [
      {
        extends: true,
        test: {
          name: "react18",
          setupFiles: ["test/setupKitParts.ts"],
          include: ["test/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
          exclude: [
            "test/browser/**",
            "test/react19.test.tsx",
            "**/node_modules/**",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "react19",
          environment: "node",
          include: ["test/react19.test.tsx"],
          server: { deps: { inline: [/@polaris-key\/react/] } },
        },
        resolve: {
          alias: [
            { find: /^react$/, replacement: react19("react/index.js") },
            {
              find: /^react\/jsx-runtime$/,
              replacement: react19("react/jsx-runtime.js"),
            },
            {
              find: /^react\/jsx-dev-runtime$/,
              replacement: react19("react/jsx-dev-runtime.js"),
            },
            {
              find: /^react-dom\/server$/,
              replacement: react19("react-dom/server.node.js"),
            },
          ],
        },
      },
    ],
  },
});
