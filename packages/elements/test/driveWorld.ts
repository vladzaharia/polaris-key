// The Worker the gate tests play: discovery, the identity session and the key route, over a
// stateful fake `fetch`, so the real browser adapter runs end to end (drive.test.ts, the browser
// flow in test/browser/holders.browser.test.ts).

export const NOW = 2000;
/** The page is the Worker's origin, so the browser adapter signs in with its cookie session. */
export const PAGE = {
  product: "acme",
  baseUrl: location.origin,
  auth: "cookie",
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
              session: `/acme/identity/session`,
              authStart: `/acme/identity/auth/start`,
            },
          }
        : { enabled: false },
    ]),
  );

export interface World {
  /** The session's license document (`null`: signed out). */
  doc: { expiresAt: number; graceUntil: number } | null;
  services: readonly string[];
  /** What `update/version` answers, if anything. */
  update?: { version: string; tag: string; url: string };
  changelog?: { version: string; summary: string | null; url: string }[];
  posted: unknown[];
  /** The key route refuses with this body (a device limit), when set. */
  refuse?: { status: number; body: unknown };
}

export function world(over: Partial<World> = {}): World {
  return {
    doc: null,
    services: ["license", "identity"],
    posted: [],
    ...over,
  };
}

export const fused = (d: NonNullable<World["doc"]>) => ({
  schemaVersion: 1,
  aud: "acme",
  iss: "key.plrs.im",
  licenseId: "lic-1",
  deviceId: "dev-1",
  issuedAt: 1000,
  expiresAt: d.expiresAt,
  graceUntil: d.graceUntil,
  profile: { name: "Ada", firstName: "Ada", activatedAt: 900 },
  payload: { config: {}, secrets: {}, entitlements: {} },
});

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
    if (url.includes("/identity/session/license")) {
      w.posted.push(JSON.parse(String(init?.body ?? "{}")));
      if (w.refuse) return json(w.refuse.body, w.refuse.status);
      w.doc = { expiresAt: 4600, graceUntil: 90_000 };
      return json({ ok: true }, 201);
    }
    if (url.includes("/identity/session"))
      return json({
        authenticated: w.doc !== null,
        doc: w.doc ? fused(w.doc) : null,
        csrfToken: "csrf-1",
      });
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
