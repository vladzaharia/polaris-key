// The program the real-pty tests run (pty.test.ts): one flow on the process's own terminal, with
// a stub client, so the key reader, the OSC 11 question, the cursor-position question and SIGWINCH
// are the real ones. Run with tsx: `pty-flow.ts login [long]`.

import { createKitContext } from "../../src/cli/context.js";
import { activateFlow, loginFlow } from "../../src/cli/flows.js";
import { KEY, stubClient, TIDEWATER } from "./harness.js";

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

let result;
if (mode === "device-limit") {
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
      waitForSignIn: (_p: unknown, o: { signal?: AbortSignal } = {}) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(
            () => resolve({ status: "expired" }),
            expireAfterMs,
          );
          o.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("cancelled"));
          });
        }),
    },
  });
  result = await loginFlow(ctx, client, { deviceCode: true });
}
ctx.close();
process.exit(result.exitCode);
