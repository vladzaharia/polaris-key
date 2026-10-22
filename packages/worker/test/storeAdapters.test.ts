/**
 * The store adapter declarations (P0-27.1): `core/stores/adapters.ts` against the storefront
 * registry, the generated channel catalogue, the credential custody tables and the services'
 * connector and flow lists. Test code may import the services; the declarations may not.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CHANNELS } from "@polaris-key/manifest";
import { STORES } from "../src/core/licensing/storeGrants.js";
import { CONNECTORS as OPS_CONNECTORS } from "../src/core/ops/operations.js";
import { OUTLET_CREDENTIAL_KINDS } from "../src/core/outletCredentials.js";
import {
  PLATFORM_CREDENTIALS,
  PLATFORM_CREDENTIAL_IDS,
} from "../src/core/platformCredentials.js";
import {
  STOREFRONT_ADAPTERS,
  storefrontAdapter,
} from "../src/core/storefront/adapter.js";
import type { StoreAdapter } from "../src/core/stores/adapter.js";
import { STORE_ADAPTERS, storeAdapter } from "../src/core/stores/adapters.js";
import { CONNECTORS } from "../src/services/distribution/connectors/index.js";
import { DELIVERY_FACETS } from "../src/services/distribution/stores/index.js";
import { FLOW_RUNTIMES } from "../src/services/distribution/storefronts/index.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const slotOf = (id: string) =>
  PLATFORM_CREDENTIALS[id as keyof typeof PLATFORM_CREDENTIALS];

/** The adapters a catalogue binds, by id; the catalogue's facets feed the checks. */
function bound(channels: typeof CHANNELS) {
  const m = new Map<string, (typeof CHANNELS)[number]["storefront"][]>();
  for (const c of channels) {
    if (!c.storefront) continue;
    const list = m.get(c.storefront.adapter) ?? [];
    list.push(c.storefront);
    m.set(c.storefront.adapter, list);
  }
  return m;
}

describe("the registry", () => {
  it("has one adapter per storefront id, no duplicates, in both directions", () => {
    const ids = STORE_ADAPTERS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(
      STOREFRONT_ADAPTERS.map((a) => a.id).sort(),
    );
    for (const a of STOREFRONT_ADAPTERS)
      expect(storeAdapter(a.id)?.storefront).toBe(storefrontAdapter(a.id));
    expect(STORE_ADAPTERS).toHaveLength(11);
  });

  it("answers null for an unknown id", () => {
    expect(storeAdapter("no-such-store")).toBeNull();
  });
});

describe("the channel catalogue binding", () => {
  const byAdapter = bound(CHANNELS);

  it("every channel's storefront.adapter has a store adapter", () => {
    for (const id of byAdapter.keys())
      expect(storeAdapter(id), id).not.toBeNull();
  });

  it("storefront.credential equals the delivery credential slot", () => {
    for (const [id, facets] of byAdapter) {
      const delivery =
        storeAdapter(id)!.requirements.find((r) => r.facet === "delivery")
          ?.slot ?? null;
      for (const f of facets) expect(f!.credential, id).toBe(delivery);
    }
  });

  it("verification, notification and sku are present exactly when commerce is declared, and equal", () => {
    for (const [id, facets] of byAdapter) {
      const commerce = storeAdapter(id)!.commerce;
      const carrying = facets.filter((f) => f!.verification !== undefined);
      if (!commerce) {
        for (const f of facets) {
          expect(f!.verification, id).toBeUndefined();
          expect(f!.notification, id).toBeUndefined();
          expect(f!.sku, id).toBeUndefined();
        }
        continue;
      }
      expect(carrying.length, id).toBeGreaterThan(0);
      for (const f of carrying) {
        expect(f!.verification, id).toBe(commerce.verification);
        expect(f!.notification, id).toBe(commerce.notification);
        expect(f!.sku, id).toBe(commerce.sku);
      }
    }
  });

  it("every adapter with commerce is bound by a channel that declares it", () => {
    for (const a of STORE_ADAPTERS) {
      if (!a.commerce) continue;
      const facets = byAdapter.get(a.id) ?? [];
      expect(
        facets.some((f) => f!.verification === a.commerce!.verification),
        a.id,
      ).toBe(true);
    }
  });

  it("every adapter is bound by some channel", () => {
    for (const a of STORE_ADAPTERS)
      expect(byAdapter.has(a.id), a.id).toBe(true);
  });

  it("negative controls: a dropped channel leaves its adapter unbound; an unknown id is refused", () => {
    const without = bound(
      CHANNELS.filter((c) => c.storefront?.adapter !== "steam"),
    );
    expect(without.has("steam")).toBe(false);
    expect(
      STORE_ADAPTERS.filter((a) => !without.has(a.id)).map((a) => a.id),
    ).toEqual(["steam"]);
    expect(storeAdapter("unknown-adapter")).toBeNull();
  });
});

describe("credentials", () => {
  const slotsOf = (a: StoreAdapter) => a.requirements.map((r) => r.slot);

  it("every slot is a platform credential and its ownKind is that slot's kind", () => {
    for (const a of STORE_ADAPTERS)
      for (const r of a.requirements) {
        expect(
          PLATFORM_CREDENTIAL_IDS as string[],
          `${a.id} ${r.slot}`,
        ).toContain(r.slot);
        expect(r.ownKind, `${a.id} ${r.slot}`).toBe(slotOf(r.slot).kind);
        expect(OUTLET_CREDENTIAL_KINDS as readonly string[]).toContain(
          r.ownKind,
        );
        expect(slotOf(r.slot).store, a.id).toBe(a.id);
      }
  });

  it("the commerce verification slot is a commerce requirement", () => {
    for (const a of STORE_ADAPTERS) {
      if (!a.commerce) continue;
      expect(
        a.requirements.some(
          (r) => r.facet === "commerce" && r.slot === a.commerce!.verification,
        ),
        a.id,
      ).toBe(true);
    }
  });

  it("identity is a subset of the slots' pinField values", () => {
    for (const a of STORE_ADAPTERS) {
      const pins = new Set(slotsOf(a).map((s) => slotOf(s).pinField));
      for (const f of a.identity)
        expect(pins.has(f), `${a.id} ${f}`).toBe(true);
    }
  });
});

describe("connector, flow and store lists", () => {
  it("declared connectors equal the ops list and the service's connectors", () => {
    const declared = STORE_ADAPTERS.flatMap((a) =>
      a.delivery.connector ? [a.delivery.connector] : [],
    ).sort();
    expect(declared).toEqual([...OPS_CONNECTORS].sort());
    expect(declared).toEqual(CONNECTORS.map((c) => c.kind).sort());
  });

  it("flow ids equal the flow runtimes' ids", () => {
    expect(
      STORE_ADAPTERS.filter((a) => a.delivery.flow)
        .map((a) => a.id)
        .sort(),
    ).toEqual(FLOW_RUNTIMES.map((r) => r.id).sort());
  });

  it("declared commerce stores equal STORES", () => {
    expect(
      STORE_ADAPTERS.flatMap((a) =>
        a.commerce ? [a.commerce.store] : [],
      ).sort(),
    ).toEqual([...STORES].sort());
  });
});

describe("the declaration files", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (e.endsWith(".ts")) files.push(full);
    }
  };
  walk(join(SRC, "core", "stores"));
  const declarations = files.filter((f) => {
    const r = relative(join(SRC, "core", "stores"), f)
      .split("\\")
      .join("/");
    return (
      /(^|\/)adapter\.ts$/.test(r) || r === "adapters.ts" || r === "keyless.ts"
    );
  });

  it("finds the declaration files", () => {
    expect(declarations.length).toBe(8);
  });

  it("import only core/storefront declarations, their siblings and manifest types", () => {
    const bad: string[] = [];
    for (const file of declarations) {
      const source = readFileSync(file, "utf8");
      for (const m of source.matchAll(
        /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g,
      )) {
        const spec = m[1]!;
        if (spec === "@polaris-key/manifest") {
          if (!/import\s+type\s/.test(m[0])) bad.push(`${file}: ${spec}`);
          continue;
        }
        if (!spec.startsWith(".")) {
          bad.push(`${file}: ${spec}`);
          continue;
        }
        const target = relative(SRC, join(dirname(file), spec))
          .split("\\")
          .join("/");
        const ok =
          target.startsWith("core/storefront/") ||
          (target.startsWith("core/stores/") &&
            /(^|\/)(adapter|adapters|keyless)\.js$/.test(target));
        if (!ok) bad.push(`${relative(SRC, file)}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("the delivery facets (P0-27.2)", () => {
  it("has exactly one facet per store adapter, in the registry's order", () => {
    const ids = DELIVERY_FACETS.map((f) => f.store);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of DELIVERY_FACETS)
      expect(storeAdapter(f.store), f.store).not.toBeNull();
    // Every store whose declaration has a delivery runtime has a facet, and the reverse.
    const declared = STORE_ADAPTERS.filter(
      (a) => a.delivery.connector || a.delivery.flow || a.id === "steam",
    ).map((a) => a.id);
    const registered = DELIVERY_FACETS.filter(
      (f) => f.connector || f.flow || f.storefrontAdmin,
    ).map((f) => f.store);
    expect(registered).toEqual(declared);
  });

  it("implements exactly the connector and flow each declaration names", () => {
    for (const f of DELIVERY_FACETS) {
      const a = storeAdapter(f.store)!;
      expect(f.connector?.kind ?? null, `${f.store} connector`).toBe(
        a.delivery.connector,
      );
      expect(f.flow !== null, `${f.store} flow`).toBe(a.delivery.flow);
      if (f.flow) expect(f.flow.id).toBe(f.store);
    }
  });

  it("keeps CONNECTORS and FLOW_RUNTIMES as they were, in order", () => {
    expect(CONNECTORS.map((c) => c.kind)).toEqual(["asc", "play", "ms-store"]);
    expect(FLOW_RUNTIMES.map((r) => r.id)).toEqual([
      "app-store",
      "google-play",
      "microsoft-store",
    ]);
    expect(CONNECTORS).toEqual(
      DELIVERY_FACETS.flatMap((f) => (f.connector ? [f.connector] : [])),
    );
  });

  it("names Steam's storefront admin module as its runtime", () => {
    const steam = DELIVERY_FACETS.find((f) => f.store === "steam")!;
    expect(steam.connector).toBeNull();
    expect(steam.flow).toBeNull();
    expect(typeof steam.storefrontAdmin).toBe("function");
  });
});
