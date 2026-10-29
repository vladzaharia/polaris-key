// The three nearby handlers carry no key material beyond D's two public keys (WIRE-CONTRACT-V5
// §12.11.5 rule 11): structurally, none of them imports a keyring or wrap module.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../src/services/identity/passthrough",
);

describe("nearby handlers import no keyring or wrap module", () => {
  for (const f of [
    "nearbyStart.ts",
    "nearbyApprove.ts",
    "nearbyPoll.ts",
    "nearbyStore.ts",
  ])
    it(f, () => {
      const imports = [
        ...readFileSync(join(DIR, f), "utf8").matchAll(/from\s+"([^"]+)"/g),
      ].map((m) => m[1]!);
      expect(imports.filter((p) => /keyring|wrap/i.test(p))).toEqual([]);
    });
});
