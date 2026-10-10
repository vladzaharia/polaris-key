// One scenario per component × state the Node terminal kit draws (packages/brand/kit-copy/
// components.json names), each named `<component>-<state>[-<variant>]` in kebab case so the docs
// file the baselines under the right component page. `data` lists the strings a scenario shows
// that are data, not copy (names, versions, ids, commands, URLs); the string lint allows only
// those and catalog text.

import {
  activateFlow,
  changelogFlow,
  checkFlow,
  configListFlow,
  devicesListFlow,
  doctorFlow,
  importBundleFlow,
  loginFlow,
  logoutFlow,
  offlineRequestFlow,
  statusFlow,
  updateApplyFlow,
  updateCheckFlow,
} from "../../src/cli/flows.js";
import { renderHelp, renderVerbHelp } from "../../src/cli/help.js";
import { CLI_VERBS } from "../../src/cli/kit.js";
import {
  deferred,
  KEY,
  NOW,
  settle,
  stubClient,
  type Harness,
  type RunOptions,
} from "./harness.js";

export interface Scenario {
  name: string;
  opts?: Omit<RunOptions, "variant">;
  data: string[];
  run(h: Harness): Promise<unknown>;
}

const DAY = 86_400;
const now = NOW / 1000;
const COMMON = ["Tidewater Studio", "tidewater"];

const statusScenario = (
  name: string,
  status: string,
  extra: Partial<{
    graceUntil: number;
    info: unknown;
    /** `identity.current()`; null is a key only device. */
    identity: unknown;
  }> = {},
): Scenario => ({
  name,
  data: [
    ...COMMON,
    "status",
    "2.4.1",
    "stable",
    "Pro",
    "mara@fennick.studio",
    "tidewater activate",
    "tidewater login",
    "tidewater update apply",
  ],
  run: (h) =>
    statusFlow(
      h.ctx,
      stubClient({
        status: () => ({
          status,
          ...(extra.graceUntil !== undefined
            ? { graceUntil: extra.graceUntil }
            : {}),
        }),
        ...(extra.info !== undefined ? { licenseInfo: extra.info } : {}),
        ...(extra.identity !== undefined
          ? { identity: { current: async () => extra.identity } }
          : {}),
      }),
    ),
});

const decision = (d: unknown) =>
  stubClient({ update: { decide: async () => ({ decision: d }) } });
const release = { version: "2.5.0", seq: 7 };

export const SCENARIOS: Scenario[] = [
  // ── Activate ──────────────────────────────────────────────────────────────────────────
  {
    name: "activate-empty",
    opts: { interactive: true },
    data: [...COMMON, "activate"],
    run: async (h) => {
      const done = activateFlow(h.ctx, stubClient());
      await settle();
      h.snap();
      h.stdin.press("escape", { sequence: "\x1b" });
      await done;
    },
  },
  {
    name: "activate-typing",
    opts: { interactive: true },
    data: [...COMMON, "activate", "pkey_tidewater_"],
    run: async (h) => {
      const done = activateFlow(h.ctx, stubClient());
      await settle();
      h.stdin.type(KEY.slice(0, 26));
      await settle();
      h.snap();
      h.stdin.press("escape", { sequence: "\x1b" });
      await done;
    },
  },
  {
    name: "activate-parsed",
    opts: { interactive: true },
    data: [...COMMON, "activate", "pkey_tidewater_"],
    run: async (h) => {
      const done = activateFlow(h.ctx, stubClient());
      await settle();
      h.stdin.type(KEY);
      await settle();
      h.snap();
      h.stdin.press("escape", { sequence: "\x1b" });
      await done;
    },
  },
  {
    name: "activate-cut-short",
    opts: { interactive: true },
    data: [...COMMON, "activate", "pkey_tidewater_", "15", "22"],
    run: async (h) => {
      const done = activateFlow(h.ctx, stubClient());
      await settle();
      h.stdin.type(KEY.slice(0, 30));
      h.stdin.press("return", { sequence: "\r" });
      await settle();
      h.snap();
      h.stdin.press("escape", { sequence: "\x1b" });
      await done;
    },
  },
  {
    name: "activate-rejected",
    opts: { interactive: true },
    data: [...COMMON, "activate", "pkey_"],
    run: async (h) => {
      const done = activateFlow(h.ctx, stubClient());
      await settle();
      h.stdin.type("tidewater-7Q2M");
      await settle();
      h.snap();
      h.stdin.press("escape", { sequence: "\x1b" });
      await done;
    },
  },
  {
    name: "activate-busy",
    opts: { piped: `${KEY}\n` },
    data: [...COMMON, "activate", "pkey_tidewater_"],
    run: async (h) => {
      const gate = deferred<unknown>();
      const done = activateFlow(
        h.ctx,
        stubClient({ license: { activateWithKey: () => gate.promise } }),
      );
      await settle();
      h.snap();
      gate.resolve({ kind: "ok", token: "pkeyt_x", schemaVersion: 1 });
      await done;
    },
  },
  {
    name: "activate-done",
    opts: { piped: `${KEY}\n` },
    data: [...COMMON, "activate", "pkey_tidewater_", "Pro"],
    run: (h) => activateFlow(h.ctx, stubClient()),
  },
  {
    name: "activate-rejected-key-entries",
    opts: { piped: `${KEY}\n` },
    data: [...COMMON, "activate", "pkey_tidewater_", "tidewater login"],
    run: (h) =>
      activateFlow(
        h.ctx,
        stubClient({
          license: {
            activateWithKey: async () => ({
              kind: "refused",
              code: "key_entry_limit",
              status: 403,
              message: "",
            }),
          },
        }),
      ),
  },
  {
    name: "activate-rejected-unauthorized",
    opts: { piped: `${KEY}\n` },
    data: [
      ...COMMON,
      "activate",
      "pkey_tidewater_",
      "key.plrs.im/activate?product=tidewater",
    ],
    run: (h) =>
      activateFlow(
        h.ctx,
        stubClient({
          license: {
            activateWithKey: async () => ({
              kind: "unauthorized",
              code: "unauthorized",
            }),
          },
        }),
      ),
  },
  {
    name: "activate-rejected-offline",
    opts: { piped: `${KEY}\n` },
    data: [...COMMON, "activate", "pkey_tidewater_", "Polaris Key"],
    run: (h) =>
      activateFlow(
        h.ctx,
        stubClient({
          license: {
            activateWithKey: async () => ({
              kind: "error",
              code: "network-error",
              message: "",
            }),
          },
        }),
      ),
  },
  // ── DeviceLimit ───────────────────────────────────────────────────────────────────────
  {
    name: "device-limit-browser-mode",
    opts: { interactive: true },
    data: [
      ...COMMON,
      "activate",
      "pkey_tidewater_",
      "key.plrs.im/portal/tidewater/devices",
      "3",
    ],
    run: async (h) => {
      const done = activateFlow(
        h.ctx,
        stubClient({
          license: {
            activateWithKey: async () => ({
              kind: "device-limit",
              code: "device_limit",
              limit: 3,
              deviceCount: 3,
              manageUrl: "https://key.plrs.im/portal/tidewater/devices",
            }),
          },
        }),
      );
      await settle();
      h.stdin.type(KEY);
      h.stdin.press("return", { sequence: "\r" });
      await settle();
      h.snap();
      h.stdin.press("escape", { sequence: "\x1b" });
      await done;
    },
  },
  {
    name: "device-limit-default",
    opts: { piped: `${KEY}\n` },
    data: [...COMMON, "activate", "pkey_tidewater_", "3"],
    run: (h) =>
      activateFlow(
        h.ctx,
        stubClient({
          license: {
            activateWithKey: async () => ({
              kind: "device-limit",
              code: "device_limit",
              limit: 3,
              deviceCount: 3,
            }),
          },
        }),
      ),
  },
  // ── SignInHandoff and SignIn ──────────────────────────────────────────────────────────
  {
    name: "sign-in-handoff-starting",
    data: [...COMMON, "login"],
    run: async (h) => {
      const gate = deferred<unknown>();
      const done = loginFlow(
        h.ctx,
        stubClient({ identity: { beginSignIn: () => gate.promise } }),
      );
      await settle();
      h.snap();
      gate.resolve(
        Promise.reject(Object.assign(new Error("x"), { code: "network" })),
      );
      await done;
    },
  },
  {
    name: "sign-in-handoff-waiting",
    opts: { interactive: true },
    data: [...COMMON, "login", "key.plrs.im/device?code=WDJB-MJHT"],
    run: async (h) => {
      const gate = deferred<unknown>();
      const done = loginFlow(
        h.ctx,
        stubClient({ identity: { waitForSignIn: () => gate.promise } }),
      );
      await settle();
      h.snap();
      gate.resolve({ status: "expired" });
      await done;
    },
  },
  {
    // A device that holds a key license is asked before that license goes to the account: the
    // question replaces the wait, and the answer is No unless the person says yes.
    name: "sign-in-handoff-finishing-attach",
    opts: { interactive: true },
    data: [...COMMON, "login", "Mara Fennick", "mara@fennick.studio"],
    run: async (h) => {
      const done = loginFlow(
        h.ctx,
        stubClient({
          identity: {
            waitForSignIn: async (
              _p: unknown,
              o: {
                confirm: (
                  who: { name: string; email: string },
                  attachable: boolean,
                ) => Promise<boolean>;
              },
            ) => {
              const who = {
                name: "Mara Fennick",
                email: "mara@fennick.studio",
              };
              const attach = await o.confirm(who, true);
              return {
                status: "ready",
                identity: who,
                ...(attach ? { attached: "claimed" } : {}),
              };
            },
          },
        }),
      );
      await settle();
      h.snap();
      h.stdin.press("n");
      await done;
    },
  },
  {
    name: "sign-in-handoff-no-browser",
    opts: { interactive: true, openUrl: false },
    data: [...COMMON, "login", "key.plrs.im/device", "WDJB-MJHT", "4:12"],
    run: async (h) => {
      const gate = deferred<unknown>();
      const done = loginFlow(
        h.ctx,
        stubClient({ identity: { waitForSignIn: () => gate.promise } }),
      );
      await settle();
      h.snap();
      gate.resolve({ status: "expired" });
      await done;
    },
  },
  {
    name: "sign-in-handoff-code",
    opts: { interactive: true, headless: true },
    data: [...COMMON, "login", "key.plrs.im/device", "WDJB-MJHT", "4:12"],
    run: async (h) => {
      const gate = deferred<unknown>();
      const done = loginFlow(
        h.ctx,
        stubClient({ identity: { waitForSignIn: () => gate.promise } }),
      );
      await settle();
      h.snap();
      gate.resolve({ status: "expired" });
      await done;
    },
  },
  {
    name: "sign-in-handoff-link-copied",
    opts: { interactive: true, headless: true },
    data: [...COMMON, "login", "key.plrs.im/device", "WDJB-MJHT", "4:12"],
    run: async (h) => {
      const gate = deferred<unknown>();
      const done = loginFlow(
        h.ctx,
        stubClient({ identity: { waitForSignIn: () => gate.promise } }),
      );
      await settle();
      h.stdin.press("c");
      await settle();
      h.snap();
      gate.resolve({ status: "expired" });
      await done;
    },
  },
  {
    name: "sign-in-handoff-expired",
    opts: { headless: true },
    data: [
      ...COMMON,
      "login",
      "key.plrs.im/device",
      "WDJB-MJHT",
      "4:12",
      "tidewater login",
    ],
    run: (h) =>
      loginFlow(
        h.ctx,
        stubClient({
          identity: { waitForSignIn: async () => ({ status: "expired" }) },
        }),
      ),
  },
  {
    name: "sign-in-handoff-denied",
    opts: { headless: true },
    data: [
      ...COMMON,
      "login",
      "key.plrs.im/device",
      "WDJB-MJHT",
      "4:12",
      "tidewater login",
    ],
    run: (h) =>
      loginFlow(
        h.ctx,
        stubClient({
          identity: {
            waitForSignIn: async () => ({ status: "error", message: "denied" }),
          },
        }),
      ),
  },
  {
    name: "sign-in-handoff-cancelled",
    opts: { interactive: true },
    data: [
      ...COMMON,
      "login",
      "key.plrs.im/device?code=WDJB-MJHT",
      "tidewater login",
    ],
    run: async (h) => {
      const done = loginFlow(
        h.ctx,
        stubClient({
          identity: {
            waitForSignIn: (_p: unknown, o: { signal: AbortSignal }) =>
              new Promise((_r, reject) =>
                o.signal.addEventListener("abort", () =>
                  reject(new Error("aborted")),
                ),
              ),
          },
        }),
      );
      await settle();
      h.stdin.press("escape", { sequence: "\x1b" });
      await done;
    },
  },
  {
    name: "sign-in-done",
    data: [
      ...COMMON,
      "login",
      "key.plrs.im/device?code=WDJB-MJHT",
      "Mara Fennick",
      "mara@fennick.studio",
    ],
    run: (h) => loginFlow(h.ctx, stubClient()),
  },
  {
    name: "sign-in-error-identity-off",
    data: [...COMMON, "login"],
    run: (h) =>
      loginFlow(
        h.ctx,
        stubClient({
          capabilities: {
            license: { enabled: true },
            identity: { enabled: false },
          },
        }),
      ),
  },
  // ── Status, gate and boot ─────────────────────────────────────────────────────────────
  statusScenario("account-and-license-signed-in", "ok", {
    graceUntil: now + 14 * DAY,
  }),
  statusScenario("account-and-license-key-only", "ok", {
    identity: null,
    graceUntil: now + 14 * DAY,
    info: {
      licenseId: "l",
      tier: "pro",
      tierLabel: "Pro",
      deviceLimit: 3,
      profile: null,
      entitledChannels: [],
      status: "ok",
    },
  }),
  // A signed-in account whose profile has an empty name and email (a provider that shared
  // neither): the row says it is signed in; it never ends in a dangling separator.
  statusScenario("account-and-license-signed-in-empty-profile", "ok", {
    graceUntil: now + 14 * DAY,
    identity: { name: "", email: "", signedInAt: now - DAY },
    info: {
      licenseId: "l",
      tier: "pro",
      deviceLimit: 3,
      profile: { name: "", email: "" },
      entitledChannels: [],
      status: "ok",
    },
  }),
  statusScenario("grace-banner-days-left", "grace", {
    graceUntil: now + 3 * DAY,
  }),
  statusScenario("grace-banner-last-day", "grace", {
    graceUntil: now + 6 * 3600,
  }),
  statusScenario("status-screen-revoked", "revoked"),
  statusScenario("status-screen-expired", "expired"),
  statusScenario("status-screen-version-too-old", "version-too-old"),
  statusScenario("status-screen-version-too-new", "version-too-new"),
  statusScenario("status-screen-channel-not-entitled", "channel-not-entitled"),
  statusScenario("polaris-key-gate-needs-activation", "needs-activation"),
  statusScenario("polaris-key-gate-licensed", "not-applicable"),
  {
    name: "boot-progress",
    data: [...COMMON],
    run: async (h) => {
      const gate = deferred<undefined>();
      const done = checkFlow(
        h.ctx,
        stubClient({ extra: { sync: () => gate.promise } }),
      );
      await settle();
      h.snap();
      gate.resolve(undefined);
      await done;
    },
  },
  {
    name: "polaris-key-gate-licensed-boot",
    data: [...COMMON, "Pro"],
    run: (h) => checkFlow(h.ctx, stubClient()),
  },
  // ── UpdatePrompt, UpdateProgress, ReleaseNotes ────────────────────────────────────────
  {
    name: "update-prompt-up-to-date",
    data: [...COMMON, "update check", "2.4.1"],
    run: (h) => updateCheckFlow(h.ctx, stubClient()),
  },
  {
    name: "update-prompt-available",
    data: [
      ...COMMON,
      "update check",
      "2.5.0",
      "tidewater update apply",
      "tidewater changelog",
    ],
    run: (h) =>
      updateCheckFlow(
        h.ctx,
        decision({
          action: "binary",
          method: "full",
          release,
          build: "b",
          mandatory: false,
          critical: false,
          prestage: [],
          discardStaged: false,
        }),
      ),
  },
  {
    name: "update-prompt-mandatory",
    data: [
      ...COMMON,
      "update check",
      "tidewater update apply",
      "tidewater changelog",
    ],
    run: (h) =>
      updateCheckFlow(
        h.ctx,
        decision({
          action: "binary",
          method: "full",
          release,
          build: "b",
          mandatory: true,
          critical: false,
          prestage: [],
          discardStaged: false,
        }),
      ),
  },
  {
    name: "update-prompt-store",
    data: [
      ...COMMON,
      "update check",
      "2.5.0",
      "apps.apple.com/app/tidewater-studio/id123",
    ],
    run: (h) =>
      updateCheckFlow(
        h.ctx,
        decision({
          action: "store",
          release,
          listingUrl: "https://apps.apple.com/app/tidewater-studio/id123",
          mandatory: false,
          critical: false,
          discardStaged: false,
        }),
      ),
  },
  {
    name: "update-prompt-platform",
    data: [...COMMON, "update check", "2.5.0"],
    run: (h) =>
      updateCheckFlow(
        h.ctx,
        decision({
          action: "platform",
          release,
          mandatory: false,
          critical: false,
          discardStaged: false,
        }),
      ),
  },
  {
    name: "update-prompt-ready",
    data: [...COMMON, "update check", "2.5.0"],
    run: (h) =>
      updateCheckFlow(
        h.ctx,
        decision({
          action: "code-ready",
          release,
          critical: false,
          discardStaged: false,
        }),
      ),
  },
  {
    name: "update-prompt-blocked",
    data: [...COMMON, "update check"],
    run: (h) =>
      updateCheckFlow(
        h.ctx,
        decision({
          action: "blocked",
          reason: "app-floor",
          discardStaged: false,
        }),
      ),
  },
  {
    name: "update-progress-downloading",
    opts: { interactive: true },
    data: [...COMMON, "update apply", "2.5.0", "62"],
    run: async (h) => {
      let clock = NOW;
      h.ctx.now = () => clock;
      const gate = deferred<unknown>();
      const done = updateApplyFlow(
        h.ctx,
        stubClient({
          update: {
            decide: async () => ({
              decision: {
                action: "binary",
                method: "full",
                release,
                build: "b",
                mandatory: false,
                critical: false,
                prestage: [],
                discardStaged: false,
              },
            }),
            install: async (
              _d: unknown,
              o: { onProgress(done: number, total: number): void },
            ) => {
              clock = NOW + 12_000;
              o.onProgress(38_000_000, 61_000_000);
              return gate.promise;
            },
          },
        }),
      );
      await settle();
      h.snap();
      gate.resolve({ kind: "restartRequired", version: "2.5.0" });
      await done;
    },
  },
  {
    name: "update-progress-done",
    data: [...COMMON, "update apply", "2.5.0", "100"],
    run: (h) =>
      updateApplyFlow(
        h.ctx,
        stubClient({
          update: {
            decide: async () => ({
              decision: {
                action: "binary",
                method: "full",
                release,
                build: "b",
                mandatory: false,
                critical: false,
                prestage: [],
                discardStaged: false,
              },
            }),
            install: async (
              _d: unknown,
              o: { onProgress(done: number, total: number): void },
            ) => {
              o.onProgress(61_000_000, 61_000_000);
              return { kind: "restartRequired", version: "2.5.0" };
            },
          },
        }),
      ),
  },
  // ── update apply: the next step when the kit cannot install the update itself ─────────────
  ...(
    [
      ["npm", "npm install -g tidewater-cli@latest"],
      ["pnpm", "pnpm add -g tidewater-cli@latest"],
      ["homebrew", "brew upgrade tidewater"],
      ["npx", "npx tidewater-cli@latest"],
    ] as const
  ).map(
    ([subkind, command]): Scenario => ({
      name: `update-prompt-platform-${subkind}`,
      data: [...COMMON, "update apply", "2.5.0", command],
      run: (h) =>
        updateApplyFlow(
          h.ctx,
          stubClient({
            update: {
              outlet: { id: subkind, kind: "direct", subkind },
              packageName: "tidewater-cli",
              decide: async () => ({
                decision: {
                  action: "platform",
                  release,
                  mandatory: false,
                  critical: false,
                  discardStaged: false,
                },
              }),
            },
          }),
        ),
    }),
  ),
  {
    // A direct build with no install driver: a download link, and a non-zero exit.
    name: "update-prompt-blocked-no-driver",
    data: [
      ...COMMON,
      "update apply",
      "2.5.0",
      "key.plrs.im/tidewater/download",
    ],
    run: (h) =>
      updateApplyFlow(
        h.ctx,
        stubClient({
          update: {
            driver: null,
            check: async () => ({
              updateAvailable: true,
              version: "2.5.0",
              url: "https://key.plrs.im/tidewater/download",
            }),
            decide: async () => ({
              decision: {
                action: "binary",
                method: "full",
                release,
                build: "b",
                mandatory: false,
                critical: false,
                prestage: [],
                discardStaged: false,
              },
            }),
          },
        }),
      ),
  },
  {
    // A build with no signed update feed: it says so and names the command that still works.
    name: "update-prompt-blocked-not-configured",
    data: [...COMMON, "update apply", "update check"],
    run: (h) =>
      updateApplyFlow(h.ctx, stubClient({ update: { decidable: false } })),
  },
  {
    // Every byte is here and the build is being checked: a spinner, not a bar at 100 %.
    name: "update-progress-installing-verifying",
    opts: { interactive: true },
    data: [...COMMON, "update apply", "2.5.0"],
    run: async (h) => {
      const gate = deferred<unknown>();
      const done = updateApplyFlow(
        h.ctx,
        stubClient({
          update: {
            decide: async () => ({
              decision: {
                action: "binary",
                method: "full",
                release,
                build: "b",
                mandatory: false,
                critical: false,
                prestage: [],
                discardStaged: false,
              },
            }),
            install: async (
              _d: unknown,
              o: { onProgress(done: number, total: number): void },
            ) => {
              o.onProgress(61_000_000, 61_000_000);
              return gate.promise;
            },
          },
        }),
      );
      await settle();
      h.snap();
      gate.resolve({ kind: "restartRequired", version: "2.5.0" });
      await done;
    },
  },
  {
    // Ready, with up to three lines of what is new when the release carries notes.
    name: "update-prompt-ready-whats-new",
    data: [
      ...COMMON,
      "update apply",
      "2.5.0",
      "Stem export in one click, with loudness matching.",
      "Track freeze now works with every plug-in.",
      "Faster project loading.",
    ],
    run: (h) =>
      updateApplyFlow(
        h.ctx,
        stubClient({
          release: {
            changelog: async () => [
              {
                version: "2.5.0",
                date: "2026-10-01T00:00:00Z",
                summary:
                  "- Stem export in one click, with loudness matching.\n- Track freeze now works with every plug-in.\n- Faster project loading.\n- A fourth line that is not shown.",
              },
            ],
          },
          update: {
            decide: async () => ({
              decision: {
                action: "binary",
                method: "full",
                release,
                build: "b",
                mandatory: false,
                critical: false,
                prestage: [],
                discardStaged: false,
              },
            }),
            install: async (
              _d: unknown,
              o: { onProgress(done: number, total: number): void },
            ) => {
              o.onProgress(61_000_000, 61_000_000);
              return { kind: "restartRequired", version: "2.5.0" };
            },
          },
        }),
      ),
  },
  {
    name: "release-notes-list",
    data: [
      ...COMMON,
      "changelog",
      "2.5.0",
      "2.4.1",
      "Stem export in one click, with loudness matching.",
      "Track freeze now works with every plug-in.",
    ],
    run: (h) =>
      changelogFlow(
        h.ctx,
        stubClient({
          release: {
            changelog: async () => [
              {
                version: "2.5.0",
                date: "2026-10-02T09:00:00Z",
                summary: "Stem export in one click, with loudness matching.",
              },
              {
                version: "2.4.1",
                date: "2026-09-12T09:00:00Z",
                summary: "Track freeze now works with every plug-in.",
              },
            ],
          },
        }),
      ),
  },
  {
    name: "release-notes-empty",
    data: [...COMMON, "changelog"],
    run: (h) => changelogFlow(h.ctx, stubClient()),
  },
  {
    name: "release-notes-error",
    data: [...COMMON, "changelog"],
    run: (h) =>
      changelogFlow(
        h.ctx,
        stubClient({
          release: {
            changelog: async () =>
              Promise.reject(
                Object.assign(new Error("x"), { code: "network" }),
              ),
          },
        }),
      ),
  },
  // ── Devices, Settings ─────────────────────────────────────────────────────────────────
  {
    name: "devices-list",
    data: [
      ...COMMON,
      "devices list",
      "Work laptop",
      "Mara's iPad",
      "MacBook Pro",
      "x64",
      "arm64",
      "dev_9fK2Lw7QmZ",
      "dev_4hQ8",
      "dev_7tR1",
      "3",
      "tidewater devices rename <id> <name>",
      "tidewater devices deauthorize <id>",
    ],
    run: (h) =>
      devicesListFlow(
        h.ctx,
        stubClient({
          listDevices: async () => [
            {
              id: "dev_4hQ8",
              current: false,
              status: "ok",
              label: "Mara's iPad",
              platform: "iPadOS",
              // The roster's last-seen time is epoch seconds.
              lastSeen: now - 3 * DAY,
            },
            {
              id: "dev_9fK2Lw7QmZ",
              current: true,
              status: "ok",
              label: "Work laptop",
              platform: "linux",
              arch: "x64",
              // The real client reports this device's own last verification in epoch milliseconds.
              lastVerifiedAt: NOW - 3_600_000,
            },
            {
              id: "dev_7tR1",
              current: false,
              status: "ok",
              label: "MacBook Pro",
              platform: "macOS",
              arch: "arm64",
              lastSeen: now - DAY,
            },
          ],
        }),
      ),
  },
  {
    name: "devices-empty",
    data: [...COMMON, "devices list"],
    run: (h) => devicesListFlow(h.ctx, stubClient()),
  },
  {
    name: "settings-list",
    data: [
      ...COMMON,
      "config list",
      "audio.sampleRate",
      "48000",
      "ui.theme",
      "dark",
      "telemetry.enabled",
      "false",
    ],
    run: async (h) =>
      configListFlow(
        h.ctx,
        stubClient({
          config: {
            listUserConfig: () => [
              { key: "audio.sampleRate", value: 48000, enforced: false },
              { key: "ui.theme", value: "dark", enforced: false },
            ],
            getConfigSource: (k: string) =>
              k === "ui.theme" ? "local" : "default",
          },
        }),
      ),
  },
  {
    name: "settings-locked",
    data: [
      ...COMMON,
      "config list",
      "telemetry.enabled",
      "false",
      "ui.theme",
      "dark",
    ],
    run: async (h) =>
      configListFlow(
        h.ctx,
        stubClient({
          config: {
            listUserConfig: () => [
              { key: "telemetry.enabled", value: false, enforced: true },
              { key: "ui.theme", value: "dark", enforced: false },
            ],
            getConfigSource: () => "default",
          },
        }),
      ),
  },
  // ── OfflineActivation, About, sign-out, help ──────────────────────────────────────────
  {
    name: "offline-activation-default",
    data: [
      ...COMMON,
      "offline-request",
      "dev_9fK2Lw7QmZ",
      "tidewater import-bundle <file>",
    ],
    run: async (h) => offlineRequestFlow(h.ctx, stubClient()),
  },
  {
    name: "offline-activation-done",
    data: [...COMMON, "import-bundle"],
    run: (h) => importBundleFlow(h.ctx, stubClient(), "eyJ.bundle"),
  },
  {
    name: "offline-activation-rejected-signature",
    data: [...COMMON, "import-bundle"],
    run: (h) =>
      importBundleFlow(
        h.ctx,
        stubClient({
          extra: {
            importBundle: async () =>
              Promise.reject(
                Object.assign(new Error("bad signature"), { code: "bundle" }),
              ),
          },
        }),
        "eyJ.bundle",
      ),
  },
  {
    name: "about-default",
    data: [
      ...COMMON,
      "doctor",
      "@polaris-key/node",
      "0.0.0",
      "2.4.1",
      "stable",
      "key.plrs.im",
      "dev_9fK2Lw7QmZ",
      "keyring",
      "license, config, release, distribution, update, identity",
    ],
    run: (h) => doctorFlow(h.ctx, stubClient()),
  },
  {
    name: "account-and-license-signed-in-sign-out",
    opts: { interactive: true },
    data: [...COMMON, "logout", "(y/N)", "tidewater login"],
    run: async (h) => {
      const done = logoutFlow(h.ctx, stubClient());
      await settle();
      h.stdin.press("y");
      await done;
    },
  },
  {
    name: "help",
    data: [
      ...COMMON,
      "<command>",
      "[options]",
      "--json",
      "--no-color",
      "--ascii",
      "-h, --help",
      "NO_COLOR=1",
      "ASCII",
      "<command> --help",
      ...CLI_VERBS.map((v) => [...v.path, ...v.args].join(" ")),
      "bash",
      "zsh",
      "fish",
    ],
    run: async (h) => {
      h.ctx.stdout.write(renderHelp(h.ctx, CLI_VERBS));
    },
  },
  {
    name: "help-activate",
    data: [
      ...COMMON,
      "activate",
      "[key]",
      "[options]",
      "--json",
      "--no-color",
      "--ascii",
      "-h, --help",
      "NO_COLOR=1",
      "ASCII",
    ],
    run: async (h) => {
      h.ctx.stdout.write(
        renderVerbHelp(h.ctx, CLI_VERBS.find((v) => v.path[0] === "activate")!),
      );
    },
  },
];
