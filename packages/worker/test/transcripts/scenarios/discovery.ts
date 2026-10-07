/// <reference types="@cloudflare/workers-types" />
// discovery-capabilities and discovery-failure: `GET /<p>/.well-known/polaris.json` and what a
// client believes about the product's services afterwards (D-21). discovery-presentation (HA-12):
// the unsigned `core.presentation` member a client exposes, present and then gone.

import { expect } from "vitest";
import { TranscriptRecorder } from "../recorder.js";
import { discovery, DEVICE, T0, VERSION } from "../client.js";
import {
  CONFIG_ONLY,
  emptyWorld,
  LICENSED,
  pinned,
  PRODUCT,
  productWorld,
  type Scenario,
} from "../world.js";
import { seedHosted } from "../../hostedFixture.js";

/** The capability map the suite default resolves to (license + config), slug → enabled. */
const DEFAULT_MAP = {
  license: true,
  config: true,
  release: false,
  distribution: false,
  update: false,
  identity: false,
  sync: false,
};

export const discoveryCapabilities: Scenario = {
  id: "discovery-capabilities",
  record: () =>
    pinned("discovery-capabilities", async (pin) => {
      const world = await productWorld(CONFIG_ONLY);
      const r = new TranscriptRecorder({
        id: "discovery-capabilities",
        description:
          "Discovery installs the product's real capability map. The product runs Config alone (D-08), so a client that starts from the suite default (license + config) must come out of discover() with License OFF: discovery is the authority once it has answered.",
        features: ["core.discover"],
        requires: [],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: { deviceId: DEVICE, version: VERSION },
      });
      await r.step(
        { action: "discover" },
        async (s) => {
          const res = await discovery(s, PRODUCT);
          expect(res.status).toBe(200);
          const doc = (await res.json()) as {
            services: Record<string, { enabled: boolean }>;
          };
          expect(doc.services.license).toEqual({ enabled: false });
          expect(doc.services.config!.enabled).toBe(true);
        },
        {
          result: "ok",
          services: { ...DEFAULT_MAP, license: false },
        },
      );
      return r.transcript();
    }),
};

export const discoveryFailure: Scenario = {
  id: "discovery-failure",
  record: () =>
    pinned("discovery-failure", async (pin) => {
      // No product row at all: the Worker answers 404 for a slug it does not know.
      const world = emptyWorld();
      const r = new TranscriptRecorder({
        id: "discovery-failure",
        description:
          "Discovery fails closed. A 404 (the product is unknown) and a 500 (the Worker threw: its D1 binding is unavailable, recorded as the runtime's bare 500) both leave the client on the capability map it already had, the suite default, rather than on anything more permissive.",
        features: ["core.discover"],
        requires: [],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: { deviceId: DEVICE, version: VERSION },
      });
      await r.step(
        { action: "discover", note: "The product is not registered: 404." },
        async (s) => {
          const res = await discovery(s, PRODUCT);
          expect(res.status).toBe(404);
        },
        { result: "not-found", services: DEFAULT_MAP },
      );
      // A D1 outage: every query rejects, so product loading throws out of the router.
      world.db = new Proxy(world.db, {
        get(target, prop, receiver) {
          if (prop === "first" || prop === "all" || prop === "run")
            return () => Promise.reject(new Error("D1_ERROR: unavailable"));
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
      await r.step(
        {
          action: "discover",
          note: "The Worker's database is unavailable and the request throws: a bare 500.",
          now: T0 + 60,
        },
        async (s) => {
          const res = await discovery(s, PRODUCT, { runtimeFailure: true });
          expect(res.status).toBe(500);
        },
        { result: "error", services: DEFAULT_MAP },
      );
      return r.transcript();
    }),
};

/** The icon copy's fixed hash, and `hostedFixture.ts`'s fixed hash of its width-`w` variant. */
const ICON_SHA256 = "1e7d".padEnd(64, "4");
const variantSha256 = (w: number) => w.toString(16).padStart(64, "f");
const IMG = "https://img.plrs.im";

export const discoveryPresentation: Scenario = {
  id: "discovery-presentation",
  record: () =>
    pinned("discovery-presentation", async (pin) => {
      // The suite-default product (no Distribution, so no listing) with a declared presentation
      // in upper case and a hosted `presentation.icon` copy with three WebP widths.
      const world = await productWorld(LICENSED);
      world.env.IMG_ORIGIN = IMG;
      await world.db.run(
        "UPDATE products SET presentation_json = ? WHERE slug = ?",
        JSON.stringify({ accent: "#2ED6E6", accentDark: "#5EE6F0" }),
        PRODUCT,
      );
      await seedHosted(world.db, PRODUCT, "presentation.icon", {
        sha256: ICON_SHA256,
        contentType: "image/png",
        width: 1024,
        height: 1024,
        widths: [64, 128, 256],
      });
      const r = new TranscriptRecorder({
        id: "discovery-presentation",
        description:
          "Discovery's unsigned core.presentation member (WIRE-CONTRACT-V4 section 5.5, HA-12). The product declares its accents in upper case and has a hosted icon copy with three WebP widths: the client exposes the normalised member, accents lower-cased, the icon as content-addressed image-host URLs with each width's own hash. Then the product drops its presentation and its copy: the member is gone, and the client must drop what it exposed (presentation null) rather than keep a stale one.",
        features: ["core.presentation"],
        requires: [],
        product: PRODUCT,
        now: T0,
        world,
        pinned: pin,
        initial: { deviceId: DEVICE, version: VERSION },
      });
      const original = `${IMG}/${PRODUCT}/a/${ICON_SHA256}`;
      const presentation = {
        name: PRODUCT,
        accent: "#2ed6e6",
        accentDark: "#5ee6f0",
        icon: {
          sha256: ICON_SHA256,
          contentType: "image/png",
          width: 1024,
          height: 1024,
          original,
          url: `${original}/{w}.webp`,
          sizes: [64, 128, 256].map((w) => ({ w, sha256: variantSha256(w) })),
        },
      };
      await r.step(
        { action: "discover" },
        async (s) => {
          const res = await discovery(s, PRODUCT);
          expect(res.status).toBe(200);
          const doc = (await res.json()) as {
            core: { presentation?: unknown };
          };
          expect(doc.core.presentation).toEqual(presentation);
        },
        { result: "ok", presentation },
      );
      // The manifest drops `presentation` (the next resync writes NULL) and the copy goes with
      // its ref (an operator's delete, HA-06): nothing beyond the name is left.
      await world.db.run(
        "UPDATE products SET presentation_json = NULL WHERE slug = ?",
        PRODUCT,
      );
      await world.db.run(
        "DELETE FROM blob_refs WHERE product = ? AND ref_kind = 'hosted-asset'",
        PRODUCT,
      );
      await world.db.run(
        "DELETE FROM hosted_assets WHERE product = ? AND slot = 'presentation.icon'",
        PRODUCT,
      );
      await r.step(
        {
          action: "discover",
          note: "The product no longer declares a presentation and its icon copy is gone: discovery omits the member, past the 300 s cache window.",
          now: T0 + 301,
        },
        async (s) => {
          const res = await discovery(s, PRODUCT);
          expect(res.status).toBe(200);
          const doc = (await res.json()) as { core: Record<string, unknown> };
          expect("presentation" in doc.core).toBe(false);
        },
        { result: "ok", presentation: null },
      );
      return r.transcript();
    }),
};
