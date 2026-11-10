// The Worker the gate tests play: discovery, the signed licence and config documents, the key
// route and the device-code start, over a stateful fake `fetch`, so the real browser adapter runs
// end to end (drive.test.ts, the browser flow in test/browser/holders.browser.test.ts).

import {
  memoryStore,
  type BrowserStore,
} from "@polaris-key/ui-core/browser/sdk/browser/bearer/store.js";

export const NOW = 2000;
const TOKEN = "pkeyt_world";
const DEVICE = "dev-1";

const b64url = (bytes: Uint8Array | string): string => {
  const raw =
    typeof bytes === "string"
      ? Array.from(new TextEncoder().encode(bytes))
      : Array.from(bytes);
  return btoa(String.fromCharCode(...raw))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
};

const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
  "sign",
  "verify",
])) as CryptoKeyPair;
const KID = "pkey-world";
const RAW = b64url(
  new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
);

async function sign(
  payload: unknown,
  typ: "pkey-license+jws" | "pkey-config+jws",
): Promise<string> {
  const input = `${b64url(JSON.stringify({ alg: "EdDSA", typ, kid: KID }))}.${b64url(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign(
    { name: "Ed25519" },
    pair.privateKey,
    new TextEncoder().encode(input),
  );
  return `${input}.${b64url(new Uint8Array(sig))}`;
}

/** The page: the Worker's origin, the key its documents are signed with pinned. */
export const PAGE = {
  product: "acme",
  baseUrl: location.origin,
  trust: { pinnedKeys: { [KID]: RAW } },
} as const;
export const SERVICES = (on: readonly string[]) =>
  Object.fromEntries(
    ["license", "config", "release", "update", "identity"].map((s) => [
      s,
      on.includes(s)
        ? {
            enabled: true,
            endpoints: {
              document: `/acme/${s}/document`,
              version: `/acme/update/version`,
            },
          }
        : { enabled: false },
    ]),
  );

export interface World {
  /** The page's licence (`null`: signed out). A key activation sets it. */
  doc: { expiresAt: number; graceUntil: number } | null;
  services: readonly string[];
  /** What `update/version` answers, if anything. */
  update?: { version: string; tag: string; url: string };
  changelog?: { version: string; summary: string | null; url: string }[];
  /** The keys the key route was given, as `{ key }`. */
  posted: unknown[];
  /** The key route refuses with this body (a device limit), when set. */
  refuse?: { status: number; body: unknown };
  /** The key route answers with these entries (Identity on). */
  keyEntries?: { used: number; limit: number };
  /** The licence is already in the page's cache (a reload): a document that arrives expired is
   *  refused, so grace and the blocking states come from what the page held. */
  cached?: boolean;
  /** How many device-code sign-ins the page started. */
  signIns?: number;
}

export function world(over: Partial<World> = {}): World {
  return {
    doc: null,
    services: ["license", "identity"],
    posted: [],
    ...over,
  };
}

/** The seams a gate over this world takes: its fetch, a store holding the device token while the
 *  world has a licence, and the clock. */
export async function seamsOf(w: World): Promise<{
  fetchImpl: typeof fetch;
  store: BrowserStore;
  now: () => number;
}> {
  const records = new Map<string, { deviceId: string }>([
    ["acme", { deviceId: DEVICE }],
  ]);
  const store = memoryStore("acme", {
    async read(p) {
      return records.get(p) ?? null;
    },
    async write(p, r) {
      records.set(p, r);
    },
  });
  if (w.doc) {
    await store.setToken(TOKEN);
    if (w.cached)
      await store.writeCache({
        v: 3,
        docs: {
          license: await signedLicense(w.doc),
          config: await signedConfig(w.doc),
        },
      });
  }
  return { fetchImpl: fakeFetch(w), store, now: () => NOW };
}

type Doc = NonNullable<World["doc"]>;
const claims = (d: Doc) => ({
  iss: "key.plrs.im",
  aud: "acme",
  deviceId: DEVICE,
  issuedAt: 1000,
  expiresAt: d.expiresAt,
  graceUntil: d.graceUntil,
});
const signedLicense = (d: Doc) =>
  sign(
    {
      ...claims(d),
      licenseId: "lic-1",
      entitlements: {},
      profile: { name: "Ada", firstName: "Ada", activatedAt: 900 },
    },
    "pkey-license+jws",
  );
const signedConfig = (d: Doc) =>
  sign(
    { ...claims(d), schemaVersion: 1, secrets: {}, config: {} },
    "pkey-config+jws",
  );

export function fakeFetch(w: World): typeof fetch {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const bearer = new Headers(init?.headers).get("authorization");
    if (url.includes("/.well-known/polaris.json"))
      return json({
        version: 2,
        protocolVersion: 4,
        product: "acme",
        slug: "acme",
        baseUrl: "https://key.plrs.im",
        core: { registration: "requires-license" },
        services: SERVICES(w.services),
      });
    if (url.includes("/.well-known/polaris-trust.jws"))
      return new Response("", { status: 404 });
    if (url.endsWith("/license/activate")) {
      w.posted.push({ key: bearer?.replace(/^Bearer /, "") });
      if (w.refuse) return json(w.refuse.body, w.refuse.status);
      w.doc = { expiresAt: 4600, graceUntil: 90_000 };
      return json({
        token: TOKEN,
        schemaVersion: 1,
        ...(w.keyEntries ? { keyEntries: w.keyEntries } : {}),
      });
    }
    if (url.endsWith("/license/document") || url.endsWith("/config/document")) {
      if (bearer !== `Bearer ${TOKEN}` || !w.doc)
        return json({ error: { code: "unauthorized" } }, 401);
      return new Response(
        url.endsWith("/license/document")
          ? await signedLicense(w.doc)
          : await signedConfig(w.doc),
        { status: 200 },
      );
    }
    if (url.endsWith("/identity/auth/device/start")) {
      w.signIns = (w.signIns ?? 0) + 1;
      return json({
        deviceCode: "dc-1",
        userCode: "ABCD-1234",
        verificationUri: "https://key.plrs.im/acme/device",
        verificationUriComplete:
          "https://key.plrs.im/acme/device?code=ABCD-1234",
        expiresIn: 600,
        interval: 5,
      });
    }
    if (url.endsWith("/devices/report")) return json({ ok: true });
    if (url.includes("/update/version"))
      return w.update ? json(w.update) : new Response("no", { status: 404 });
    if (url.includes("/release/changelog"))
      return json({
        entries: (w.changelog ?? []).map((e) => ({
          tag: `v${e.version}`,
          date: "2026-10-01T00:00:00Z",
          ...e,
        })),
      });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

/** Type a license key into the gate's key field, the way a person does. */
export async function typeKey(
  gate: HTMLElement & { updateComplete: Promise<unknown> },
  key: string,
): Promise<void> {
  const field = gate.shadowRoot!.querySelector<HTMLInputElement>("#pk-key")!;
  field.value = key;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await gate.updateComplete;
}
