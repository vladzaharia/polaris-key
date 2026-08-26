# Pre-audit baseline

Recorded before any audit change, on the tracked tree at HEAD `bd26e0b`
(branch `full-security-audit-licensing`, identical to `main`).

Toolchain: **Node 22** (`~/.local/share/mise/installs/node/22/bin`) — mandatory.
`better-sqlite3@11.10.0` cannot build against this machine's default Node 26; under Node 26
roughly 160 worker tests fail with a misleading `NODE_MODULE_VERSION 127 vs 147` error.

| Gate              | Command                      | Result                                        |
| ----------------- | ---------------------------- | --------------------------------------------- |
| Tests             | `pnpm test`                  | **952 passed, 0 failed**, 10 packages, exit 0 |
| Typecheck         | `pnpm typecheck`             | clean, exit 0                                 |
| Lint              | `pnpm lint`                  | clean, exit 0                                 |
| Conformance drift | `pnpm gen:corpus -- --check` | no drift, exit 0                              |

Per-package test counts:

| Package                         | Tests   |
| ------------------------------- | ------- |
| `@polaris-key/worker`           | 396     |
| `@polaris-key/react`            | 183     |
| `@polaris-key/admin`            | 134     |
| `@polaris-key/node`             | 133     |
| `@polaris-key/conformance-node` | 34      |
| `@polaris-key/jws`              | 29      |
| `@polaris-key/catalog`          | 20      |
| `@polaris-key/manifest`         | 13      |
| `@polaris-key/cli`              | 6       |
| `@polaris-key/tools`            | 4       |
| **Total**                       | **952** |

Note: `README.md:75-77` claims "~660 tests" with a per-package breakdown that no longer
matches (it lists worker 198, sdk-react 129, sdk-node 90, admin 71). Stale documentation —
tracked as a doc-drift finding.

## Native SDK baselines

| Suite  | Command                                             | Result                              |
| ------ | --------------------------------------------------- | ----------------------------------- |
| Python | `(cd sdks/python && .venv/bin/python -m pytest -q)` | **126 passed**, exit 0              |
| Swift  | `(cd sdks/swift && swift test)`                     | **80 executed, 0 failures**, exit 0 |

**Grand total: 1158 tests green** (952 JS/TS + 126 Python + 80 Swift).

The Python venv did not exist in this worktree and was created with
`python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"`. Note it resolved to
**Python 3.14**, while `.github/workflows/ci.yml:50` tests only 3.12 and
`pyproject.toml:10` declares `requires-python = ">=3.9"` — a three-version spread with only
one version actually exercised in CI. Tracked as a finding.

## Incidental finding recorded during baseline

`pnpm` emitted:

> `[WARN] The "pnpm" field in package.json is no longer read by pnpm. The following keys were
ignored: "pnpm.onlyBuiltDependencies". See https://pnpm.io/settings for the new home of each
setting.`

`package.json:26-32` declares an `onlyBuiltDependencies` allowlist restricting postinstall-script
execution to `better-sqlite3`, `esbuild`, and `workerd`. **The installed pnpm ignores it** — the
setting moved to `pnpm-workspace.yaml`. A supply-chain control the repo believes is configured is
not in effect. See `R7-supply-chain.md`.

---

# Post-remediation verification

Run after all remediation lanes completed, same toolchain (Node 22).

| Gate              | Command                         | Baseline                | Final                        |
| ----------------- | ------------------------------- | ----------------------- | ---------------------------- |
| JS/TS tests       | `pnpm test`                     | 952 passed              | **1394 passed, 0 failed**    |
| Python            | `.venv/bin/python -m pytest -q` | 126 passed              | **231 passed**               |
| Swift             | `swift test`                    | 80 executed, 0 failures | **120 executed, 0 failures** |
| **Total**         |                                 | **1158**                | **1745**                     |
| Typecheck         | `pnpm typecheck`                | clean                   | **clean (17/17 tasks)**      |
| Lint              | `pnpm lint`                     | clean                   | **clean**                    |
| Conformance drift | `pnpm gen:corpus -- --check`    | no drift                | **no drift (5 artifacts)**   |

Per-package JS/TS movement:

| Package                         | Baseline | Final | Δ    |
| ------------------------------- | -------- | ----- | ---- |
| `@polaris-key/worker`           | 396      | 667   | +271 |
| `@polaris-key/node`             | 133      | 162   | +29  |
| `@polaris-key/catalog`          | 20       | 110   | +90  |
| `@polaris-key/conformance-node` | 34       | 68    | +34  |
| `@polaris-key/jws`              | 29       | 42    | +13  |
| `@polaris-key/manifest`         | 13       | 18    | +5   |
| `@polaris-key/admin`            | 134      | 134   | —    |
| `@polaris-key/react`            | 183      | 183   | —    |
| `@polaris-key/cli`              | 6        | 6     | —    |
| `@polaris-key/tools`            | 4        | 4     | —    |

**+587 tests overall.** The great majority are inverted proof-of-concept exploits: each one
demonstrated a working attack before the fix and asserts its failure after, so the suite is now a
regression corpus for this audit rather than a set of assertions written from the fix's point of
view.

Conformance corpus grew from 22 raw cases to 34, plus two new sections — `docCases` (12, claim
validation) and `trustCases` (10, trust merge/prune) — all executed identically by the Node,
Python and Swift runners.

---

# Second remediation round (open High findings + residual risks)

| Suite              | Pre-audit | Round 1  | Round 2  |
| ------------------ | --------- | -------- | -------- |
| JS/TS              | 952       | 1394     | **1500** |
| workerd (new lane) | —         | —        | **9**    |
| Python             | 126       | 231      | **239**  |
| Swift              | 80        | 120      | **122**  |
| **Total**          | **1158**  | **1745** | **1870** |

`pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm gen:corpus -- --check` all exit 0.

Closed this round: R9-01 (OIDC issuer SSRF — address literals at the validator, fail-closed
`OIDC_ISSUER_ALLOWLIST` at both ingest paths), R9-02, R7-02 (quadratic YAML, both copies),
R5-03 (GitHub App tokens down-scoped to one repo; cache key derived internally so a caller
cannot widen it), R12-03 (installation token sealed in KV), R10-05 (release surface cached and
rate-limited), R10-15, R12-07 (Python **and Swift** READMEs pinned a committed corpus test key),
R4-04 (clock floor now raised from the trust manifest), R5-04 (dual-KEK keyring + re-seal sweep +
runbook), residual 2 (`scheduled()` handler, retention, `DELETE /api/me`), residual 4 (last
uncapped `new RegExp`), residual 5 (real-workerd CI lane), residual 6 (portal FK cascade),
R11-04 (deploy-time index assertion).

The workerd lane is the structural fix. Every other suite runs under Node, which permits the
runtime codegen workerd forbids — the blind spot that let the worst release blocker through
while 396 green tests said nothing. It boots genuine workerd against the worker's own
`wrangler.toml` and includes a **canary** asserting that `Function(src)` still throws, so if the
runtime ever relaxes that restriction the canary fails first rather than the suite quietly
ceasing to prove anything.
