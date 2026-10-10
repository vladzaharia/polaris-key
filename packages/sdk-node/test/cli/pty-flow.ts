// The program the real-pty tests run (pty.test.ts): one flow on the process's own terminal, with
// a stub client, so the key reader, the OSC 11 question, the cursor-position question and SIGWINCH
// are the real ones. Run with tsx: `pty-flow.ts login [long]`.

import { createKitContext } from "../../src/cli/context.js";
import {
  activateFlow,
  devicesListFlow,
  loginFlow,
  statusFlow,
  updateApplyFlow,
} from "../../src/cli/flows.js";
import { KEY, NOW, stubClient, TIDEWATER } from "./harness.js";

const mode = process.argv[2] ?? "login";
const long = process.argv[3] === "long";
const code = long ? "WDJB-MJHT-QXRP-LMNV" : "WDJB-MJHT";
const url = long
  ? "https://licensing.tidewater-studio-professional.example.com/activate/device?region=eu-west-2&channel=stable-26"
  : "https://key.plrs.im/device";
const expireAfterMs = Number(process.env.PTY_EXPIRE_MS ?? 4000);

const ctx = await createKitContext({
  slug: "tidewater",
  bin: "tidewater",
  io: {
    env: {
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: "en_US.UTF-8",
      DISPLAY: ":0",
      ...(process.env.PKEY_THEME ? { PKEY_THEME: process.env.PKEY_THEME } : {}),
      // The frame matrix: no colour, and ASCII symbols (the run's own environment names them).
      ...(process.env.NO_COLOR ? { NO_COLOR: process.env.NO_COLOR } : {}),
      ...(process.env.PKEY_ASCII ? { PKEY_ASCII: process.env.PKEY_ASCII } : {}),
    },
    platform: "linux",
    openUrl: () => true,
    // The key given on the command line warns on stderr; the screens under test are stdout's.
    stderr: { isTTY: false, write: () => true },
  },
  presentation: {
    presentation: () => ({
      ...TIDEWATER,
      name: long
        ? "Tidewater Studio Professional Mastering Suite for Podcasters"
        : TIDEWATER.name,
    }),
  },
  bundle: {},
});

const DAY = 86_400;
const binary = {
  action: "binary",
  method: "full",
  release: { version: "2.5.0", seq: 7 },
  build: "b",
  mandatory: false,
  critical: false,
  prestage: [],
  discardStaged: false,
};
const platform = { ...binary, action: "platform" };

let result;
if (mode === "status") {
  // `status [key-only | revoked | revoked-key-only]`
  const arg = process.argv[3] ?? "";
  result = await statusFlow(
    ctx,
    stubClient({
      status: () => ({
        status: arg.startsWith("revoked") ? "revoked" : "ok",
        graceUntil: NOW / 1000 + 14 * DAY,
      }),
      ...(arg.endsWith("key-only")
        ? { identity: { current: async () => null } }
        : {}),
    }),
  );
} else if (mode === "devices") {
  result = await devicesListFlow(
    ctx,
    stubClient({
      listDevices: async () => [
        {
          id: "dev_9fK2Lw7QmZ",
          current: true,
          status: "ok",
          label: "Work laptop",
          platform: "macos",
          arch: "arm64",
          lastVerifiedAt: Date.now() - 3600_000,
          lastSeen: Date.now() / 1000 - 3600,
        },
        {
          id: "dev_4hQ8",
          current: false,
          status: "ok",
          label: "Mara's iPad",
          platform: "ios",
          lastSeen: Date.now() / 1000 - 3 * DAY,
        },
      ],
    }),
  );
} else if (mode === "update") {
  // `update <npm | pnpm | homebrew | npx | no-driver | not-configured | verifying>`
  const arg = process.argv[3] ?? "npm";
  const decide = async () => ({
    decision: ["npm", "pnpm", "homebrew", "npx"].includes(arg)
      ? platform
      : binary,
  });
  result = await updateApplyFlow(
    ctx,
    stubClient({
      update:
        arg === "not-configured"
          ? { decidable: false }
          : arg === "no-driver"
            ? {
                driver: null,
                decide,
                check: async () => ({
                  updateAvailable: true,
                  version: "2.5.0",
                  url: "https://key.plrs.im/tidewater/download",
                }),
              }
            : arg === "verifying"
              ? {
                  decide,
                  install: async (
                    _d: unknown,
                    o: { onProgress(a: number, b: number): void },
                  ) => {
                    o.onProgress(30_000_000, 61_000_000);
                    await new Promise((r) => setTimeout(r, 1200));
                    o.onProgress(61_000_000, 61_000_000);
                    await new Promise((r) => setTimeout(r, 2500));
                    return { kind: "restartRequired", version: "2.5.0" };
                  },
                }
              : {
                  outlet: { id: arg, kind: "direct", subkind: arg },
                  packageName: "tidewater-cli",
                  decide,
                },
    }),
  );
} else if (mode === "activate-unauthorized") {
  result = await activateFlow(
    ctx,
    stubClient({
      license: {
        activateWithKey: async () => ({
          kind: "unauthorized",
          code: "unauthorized",
        }),
      },
    }),
    { key: KEY },
  );
} else if (mode === "device-limit") {
  result = await activateFlow(
    ctx,
    stubClient({
      license: {
        activateWithKey: async () => ({
          kind: "device-limit",
          code: "device_limit",
          limit: 3,
          deviceCount: 3,
          manageUrl: long
            ? url.replace("activate/device", "portal/devices")
            : "https://key.plrs.im/portal/tidewater/devices",
        }),
      },
    }),
    { key: KEY },
  );
} else {
  const client = stubClient({
    identity: {
      beginSignIn: async () => ({
        deviceCode: "dc_secret",
        userCode: code,
        verificationUri: url,
        verificationUriComplete: `${url}${url.includes("?") ? "&" : "?"}code=${code}`,
        expiresIn: 600,
        interval: 5,
        expiresAt: Date.now() / 1000 + 600,
      }),
      waitForSignIn: async (
        _p: unknown,
        o: {
          signal?: AbortSignal;
          confirm?: (w: unknown, attachable: boolean) => Promise<boolean>;
        } = {},
      ) => {
        // `login attach`: the device holds a key license, so the wait asks before adding it.
        if (mode === "attach" && o.confirm) {
          const who = { name: "Mara Fennick", email: "mara@fennick.studio" };
          const attach = await o.confirm(who, true);
          return {
            status: "ready",
            identity: who,
            ...(attach ? { attached: "claimed" } : {}),
          };
        }
        return new Promise((resolve, reject) => {
          const t = setTimeout(
            () => resolve({ status: "expired" }),
            expireAfterMs,
          );
          o.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("cancelled"));
          });
        });
      },
    },
  });
  result = await loginFlow(ctx, client, { deviceCode: true });
}
ctx.close();
process.exit(result.exitCode);
