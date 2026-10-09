// The goldens' harness: a terminal variant (colour level, symbols, width, scheme), a fake TTY
// stdin that takes keypresses, a stub client with the Tidewater Studio fixture (UI-KITS §8:
// Tidewater Studio by Harbor Audio; the user's devices Work laptop, Mara's iPad, MacBook Pro),
// and a pinned clock. A scenario runs one flow and the golden is the screen it leaves (or the
// screen at the moment the scenario calls `snap()`).

import { PassThrough } from "node:stream";
import type { PolarisKeyClient } from "../../src/client.js";
import { createKitContext, type KitContext } from "../../src/cli/context.js";
import type { Ticker } from "../../src/cli/term/live.js";
import type {
  PolarisKeyTerminalTheme,
  ProductPresentation,
} from "../../src/cli/theme.js";
import { Screen } from "./screen.js";

/** One rendering of a state (UI-KITS §7.1 "Terminal": truecolor, ANSI-16, NO_COLOR, ascii; 80 and 60). */
export interface Variant {
  id: string;
  color: "truecolor" | "ansi16" | "none";
  ascii: boolean;
  columns: 80 | 60 | 32;
  scheme: "dark" | "light";
}

export const VARIANTS: readonly Variant[] = [
  {
    id: "truecolor-80-dark",
    color: "truecolor",
    ascii: false,
    columns: 80,
    scheme: "dark",
  },
  {
    id: "truecolor-80-light",
    color: "truecolor",
    ascii: false,
    columns: 80,
    scheme: "light",
  },
  {
    id: "ansi16-80",
    color: "ansi16",
    ascii: false,
    columns: 80,
    scheme: "dark",
  },
  {
    id: "no-color-80",
    color: "none",
    ascii: false,
    columns: 80,
    scheme: "dark",
  },
  { id: "ascii-80", color: "ansi16", ascii: true, columns: 80, scheme: "dark" },
  {
    id: "truecolor-60-dark",
    color: "truecolor",
    ascii: false,
    columns: 60,
    scheme: "dark",
  },
  {
    id: "truecolor-60-light",
    color: "truecolor",
    ascii: false,
    columns: 60,
    scheme: "light",
  },
  {
    id: "ansi16-60",
    color: "ansi16",
    ascii: false,
    columns: 60,
    scheme: "dark",
  },
  {
    id: "no-color-60",
    color: "none",
    ascii: false,
    columns: 60,
    scheme: "dark",
  },
  { id: "ascii-60", color: "ansi16", ascii: true, columns: 60, scheme: "dark" },
];

/** 2026-10-05 12:00 UTC: every date and countdown in the goldens is relative to it. */
export const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

/** Tidewater Studio's presentation (its accent is the one derived from its icon, UI-KITS §3.3). */
export const TIDEWATER: ProductPresentation = {
  name: "Tidewater Studio",
  developerName: "Harbor Audio",
  accent: "#369186",
};

/** The fixture key. Its secret must never appear in any output. */
export const KEY = "pkey_tidewater_7Q2Mx9cLr4TbV0aZ3WPLDA";
export const KEY_SECRET = KEY.slice("pkey_tidewater_".length);

export class FakeStdin extends PassThrough {
  isTTY: boolean;
  rawMode = false;
  constructor(tty: boolean) {
    super();
    this.isTTY = tty;
  }
  setRawMode(mode: boolean): this {
    this.rawMode = mode;
    return this;
  }
  /** One keypress, as readline would emit it. */
  press(name: string, opts: { ctrl?: boolean; sequence?: string } = {}): void {
    this.emit("keypress", opts.sequence ?? name, {
      name,
      sequence: opts.sequence ?? name,
      ctrl: opts.ctrl ?? false,
      meta: false,
    });
  }
  /** Type text, one keypress per character. */
  type(text: string): void {
    for (const ch of text) this.press(ch.toLowerCase(), { sequence: ch });
  }
}

/** A ticker that never fires: every spinner shows its first frame. */
export const frozenTicker: Ticker = {
  setInterval: () => 0,
  clearInterval: () => undefined,
};

/** Let the flow run until it waits on something again. */
export const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
};

export interface Harness {
  ctx: KitContext;
  screen: Screen;
  stdin: FakeStdin;
  /** Take the golden now (the screen while the flow is still waiting). */
  snap(): void;
  /** URLs the flow asked the browser to open. */
  opened: string[];
}

export interface RunOptions {
  variant: Variant;
  interactive?: boolean;
  /** stdin's content when it is not a terminal. */
  piped?: string;
  json?: boolean;
  theme?: PolarisKeyTerminalTheme;
  presentation?: ProductPresentation | null;
  /** The OS opener's answer (default: it opened). */
  openUrl?: boolean;
  headless?: boolean;
  copy?: (text: string) => string;
}

/** Run `scenario` in `variant` and return the screen (or the snapshot) and the raw stream. */
export async function render(
  o: RunOptions,
  scenario: (h: Harness) => Promise<unknown>,
): Promise<{ text: string; raw: string; stderr: string }> {
  const v = o.variant;
  const screen = new Screen({ tty: true, columns: v.columns, rows: 30 });
  const err = new Screen({ tty: true, columns: v.columns });
  const stdin = new FakeStdin(o.interactive === true);
  if (!o.interactive) {
    if (o.piped !== undefined) stdin.end(o.piped);
    else stdin.end();
  }
  const env: Record<string, string> = {
    TERM: "xterm-256color",
    PKEY_THEME: v.scheme,
    LANG: "en_US.UTF-8",
    DISPLAY: ":0",
    ...(v.color === "truecolor" ? { COLORTERM: "truecolor" } : {}),
    ...(v.color === "none" ? { NO_COLOR: "1" } : {}),
    ...(o.headless ? { SSH_CONNECTION: "10.0.0.2 51234 10.0.0.9 22" } : {}),
  };
  const opened: string[] = [];
  const ctx = await createKitContext({
    slug: "tidewater",
    bin: "tidewater",
    flags: {
      ...(v.ascii ? { ascii: true } : {}),
      ...(o.json ? { json: true } : {}),
    },
    io: {
      stdout: screen,
      stderr: err,
      stdin,
      env,
      platform: "linux",
      ticker: frozenTicker,
      now: () => NOW,
      openUrl: (u) => {
        opened.push(u);
        return o.openUrl ?? true;
      },
    },
    ...(o.theme ? { theme: o.theme } : {}),
    presentation:
      o.presentation === null
        ? null
        : { presentation: () => o.presentation ?? TIDEWATER },
    bundle: {},
    queryScheme: false,
  });
  let snapshot: string | null = null;
  try {
    await scenario({
      ctx,
      screen,
      stdin,
      snap: () => {
        snapshot = screen.text();
      },
      opened,
    });
  } finally {
    ctx.close();
  }
  return {
    text: snapshot ?? screen.text(),
    raw: screen.raw,
    stderr: err.text(),
  };
}

/** A deferred: the stub waits on it so a scenario can snapshot mid-flow. */
export function deferred<T>(): { promise: Promise<T>; resolve(v: T): void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

type Stub = Record<string, unknown>;

/** A stub client: the Tidewater fixture, with `over` replacing any part. */
export function stubClient(
  over: {
    status?: () => { status: string; graceUntil?: number };
    licenseInfo?: unknown;
    license?: Stub;
    identity?: Stub;
    update?: Stub;
    release?: Stub;
    config?: Stub;
    capabilities?: Record<string, { enabled: boolean }>;
    listDevices?: () => Promise<unknown[]>;
    extra?: Stub;
  } = {},
): PolarisKeyClient {
  const caps = over.capabilities ?? {
    license: { enabled: true },
    config: { enabled: true },
    release: { enabled: true },
    distribution: { enabled: true },
    update: { enabled: true },
    identity: { enabled: true },
    sync: { enabled: false },
  };
  const info =
    over.licenseInfo === undefined
      ? {
          licenseId: "lic_tw",
          tier: "pro",
          tierLabel: "Pro",
          deviceLimit: 3,
          profile: { name: "Mara Fennick", email: "mara@fennick.studio" },
          entitledChannels: ["stable"],
          status: "ok",
        }
      : over.licenseInfo;
  const status =
    over.status ??
    (() => ({ status: "ok", graceUntil: NOW / 1000 + 14 * 86_400 }));
  return {
    product: "tidewater",
    status,
    storeStatus: async () => ({ backend: "keyring" }),
    capabilities: () => caps,
    supports: () => ({ supported: true }),
    sync: async () => undefined,
    discover: async () => ({ kind: "ok" }),
    listDevices: over.listDevices ?? (async () => []),
    renameDevice: async () => undefined,
    deauthorizeDevice: async () => undefined,
    importBundle: async () => ({ bundleId: "bdl_1", imported: ["license"] }),
    core: {
      version: "2.4.1",
      channel: "stable",
      deviceId: "dev_9fK2Lw7QmZ",
      baseUrl: "https://key.plrs.im",
    },
    license: {
      licenseInfo: () => info,
      activateWithKey: async () => ({
        kind: "ok",
        token: "pkeyt_secret",
        schemaVersion: 1,
      }),
      enroll: async () => ({
        kind: "ok",
        token: "pkeyt_secret",
        schemaVersion: 1,
      }),
      deactivate: async () => undefined,
      ...over.license,
    },
    identity: {
      beginSignIn: async () => ({
        deviceCode: "dc_secret",
        userCode: "WDJB-MJHT",
        verificationUri: "https://key.plrs.im/device",
        verificationUriComplete: "https://key.plrs.im/device?code=WDJB-MJHT",
        expiresIn: 600,
        interval: 5,
        expiresAt: NOW / 1000 + 252,
        deviceName: "Mara's MacBook Pro",
      }),
      waitForSignIn: async () => ({
        status: "ready",
        identity: { name: "Mara Fennick", email: "mara@fennick.studio" },
      }),
      signOut: async () => undefined,
      ...over.identity,
    },
    update: {
      decidable: true,
      outlet: null,
      decide: async () => ({
        decision: {
          action: "none",
          reason: "up-to-date",
          behind: false,
          discardStaged: false,
        },
      }),
      check: async () => ({
        updateAvailable: false,
        version: "2.4.1",
        url: "",
      }),
      install: async () => ({ kind: "restartRequired", version: "2.5.0" }),
      packs: {
        state: async () => ({
          active: {},
          running: {},
          inflight: {},
          stateIssue: null,
        }),
        ensure: async () => [],
        on: () => () => undefined,
      },
      ...over.update,
    },
    release: { changelog: async () => [], ...over.release },
    config: {
      listUserConfig: () => [],
      getConfigSource: () => "default",
      getConfig: (_k: string, fallback: unknown) => fallback,
      getSecret: () => null,
      set: async () => undefined,
      clear: async () => undefined,
      mintToken: async () => ({ token: "tok", expiresAt: 0 }),
      ...over.config,
    },
    devices: {
      register: async () => ({ kind: "ok", deviceId: "dev_9fK2Lw7QmZ" }),
    },
    ...over.extra,
  } as unknown as PolarisKeyClient;
}
