/**
 * Compatibility re-export. The build gate lives in `core/gate.ts`.
 *
 * D-20 keeps channel/version enforcement a LICENSE concern — `GET /<p>/license/document` is
 * where a blocked build is refused (WIRE-CONTRACT-V3 §5) — but spec §3.2 names a second
 * enforcement point, `GET /<p>/identity/session`, and two services may not import each other
 * (`test/boundaries.test.ts`). So the predicate is Core's, and `services/license/gate.ts`
 * re-exports it for License's own call sites.
 *
 * Nothing inside `src/` imports THIS module any more: the last two callers (identity's browser
 * session and the portal's entitlement view) moved into `services/identity/` and bind to Core
 * directly. What is left is the address the behaviour-pin suites spell, kept so the carve did
 * not force a re-baseline of tests it changed nothing about. It goes with the rest of the
 * pre-suite shims in P8.
 */

export * from "./services/license/gate.js";
