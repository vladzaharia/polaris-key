/// <reference types="@cloudflare/workers-types" />
// discovery-capabilities and discovery-failure: `GET /<p>/.well-known/polaris.json` and what a
// client believes about the product's services afterwards (D-21).

import { expect } from "vitest";
import { TranscriptRecorder } from "../recorder.js";
import { discovery, DEVICE, T0, VERSION } from "../client.js";
import {
  CONFIG_ONLY,
  emptyWorld,
  pinned,
  PRODUCT,
  productWorld,
  type Scenario,
} from "../world.js";

/** The capability map the suite default resolves to (license + config), slug → enabled. */
const DEFAULT_MAP = {
  license: true,
  config: true,
  release: false,
  update: false,
  identity: false,
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
