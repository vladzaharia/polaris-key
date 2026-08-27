/**
 * Compatibility re-export. The build gate moved to `core/gate.ts` when Identity was carved.
 *
 * D-20 keeps channel/version enforcement a LICENSE concern and `GET /<p>/license/document` is
 * still where a blocked build is refused — but spec §3.2 names a second enforcement point,
 * identity's `GET /<p>/identity/session`, and two services may not import each other
 * (`test/boundaries.test.ts`). So the predicate is Core's, beside the entitlement algebra it is
 * built from, and this module keeps License's own call sites (and `src/gate.ts`) unchanged.
 *
 * Nothing may be defined here: a second definition of the gate is the exact divergence the move
 * exists to prevent.
 */

export * from "../../core/gate.js";
