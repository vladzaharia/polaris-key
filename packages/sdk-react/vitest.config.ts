import "../../tools/pin-test-env.mjs"; // TZ and locale pinned for the run
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The React 19 fixture is its own workspace package: react-dom must resolve the same React
// major, which an alias inside the SDK package cannot guarantee.
const react19 = (path: string) =>
  fileURLToPath(
    new URL(`./test/react19/node_modules/${path}`, import.meta.url),
  );

// Files that need no DOM and no kit setup: they run in the node environment, which skips the
// jsdom window and the kit preload (setupKitParts.ts) their file would otherwise pay for. A file
// that starts to need either fails in this project: move it out of the list.
const NODE_FILES = [
  "test/accountCalls.test.ts",
  "test/apiSurface.generated.test.ts",
  "test/autoSignIn.test.ts",
  "test/backend.test.ts",
  "test/bearerAdapter.test.ts",
  "test/bearerBackoff.test.ts",
  "test/bearerExchange.test.ts",
  "test/bearerSignInRetry.test.ts",
  "test/boot.test.ts",
  "test/bootGuard.test.ts",
  "test/bridge.test.ts",
  "test/browserAdapter.test.ts",
  "test/bundleImport.test.ts",
  "test/capabilities.test.ts",
  "test/catalog.test.ts",
  "test/cloudSyncFiles.browser.test.ts",
  "test/cloudSyncHost.test.ts",
  "test/cloudSyncSaves.test.ts",
  "test/configMatrix.test.ts",
  "test/connectIdentity.test.ts",
  "test/connectRelay.test.ts",
  "test/connectTransfer.test.ts",
  "test/consumerTypes.test.ts",
  "test/copy.test.ts",
  "test/coreAdapter.test.ts",
  "test/credentials.test.ts",
  "test/desktopAdapter.test.ts",
  "test/desktopNativeRedirect.test.ts",
  "test/download.test.ts",
  "test/errorCodes.test.ts",
  "test/fedcm.test.ts",
  "test/feedUrlMatrix.test.ts",
  "test/gateMatrixParity.test.ts",
  "test/headers.test.ts",
  "test/keyring.test.ts",
  "test/keyringCodec.test.ts",
  "test/kitHolders.integration.test.ts",
  "test/kitOpener.test.ts",
  "test/lazyChunkFailure.test.ts",
  "test/licenseIdRefresh.test.ts",
  "test/linkEngine.test.ts",
  "test/localTrust.test.ts",
  "test/nativePayload.test.ts",
  "test/outletDetection.test.ts",
  "test/packTypes.test.ts",
  "test/packs.test.ts",
  "test/redeemGuard.test.ts",
  "test/report.test.ts",
  "test/sdkConfig.test.ts",
  "test/signInSession.test.ts",
  "test/sizeBudget.test.ts",
  "test/storeNamespace.test.ts",
  "test/supports.test.ts",
  "test/transcripts.test.ts",
  "test/transferBrowserNode.test.ts",
  "test/trustCustody.test.ts",
  "test/updateDecision.test.ts",
  "test/updateDriver.test.ts",
  "test/updateEventFlush.test.ts",
  "test/updateEvents.test.ts",
  "test/updateMatrixParity.test.ts",
  "test/version.test.ts",
];

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
          name: "react18-dom",
          // One module graph and one jsdom window per worker: the kit preload in setupKitParts.ts
          // runs once per worker, not once per file. RTL unmounts after each test.
          isolate: false,
          setupFiles: ["test/setupKitParts.ts"],
          include: ["test/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
          exclude: [
            "test/browser/**",
            "test/react19.test.tsx",
            "**/node_modules/**",
            ...NODE_FILES,
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "react18-core",
          environment: "node",
          include: NODE_FILES,
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
