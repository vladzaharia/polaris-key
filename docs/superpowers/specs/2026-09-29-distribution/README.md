# Distribution service: supporting material (2026-09-29)

Supports [`../2026-09-29-distribution-service-design.md`](../2026-09-29-distribution-service-design.md).
First consumer: Diceroll (`vladzaharia/diceroll`), whose public design is
`docs/design/2026-09-29-distribution-v2.md` there (§7 trust, §8 hosting, §10 Polaris, §12 incident
operations) and whose plan (`docs/plans/2026-09-29-distribution-v2-plan.md`, milestone M6 and step 3.3)
covers this work.

| Path | What it is |
|---|---|
| `research/03-polaris-key.md` | Polaris Key's fit for distribution: services, gaps, costs, catalog design, Godot verification measurements |
| `research/10-security-signing.md` | Threat model, TUF-lite design, custody, rotation and revocation runbook, CI secret layout |
| `godot-prototype/` | Throwaway Godot 4.7.2 project: a pure-GDScript Ed25519 + SHA-512 verifier (`crypto/ed25519.gd`), a port of the JWS verification rules (`core/jws.gd`), RFC 8032 and tamper vectors (`vectors.json`), an ES256 raw-to-DER check, a threading check, and `run_corpus.gd`, which runs `conformance/corpus/v2/cases.json` (copy it next to `project.godot` as `cases.json`). Results: 48/48 Ed25519 vectors, 81/81 applicable corpus cases, ~15 ms per Ed25519 verify on desktop; ES256 verifies natively in ~1 ms. `test_es256.gd` also needs `es.pub.pem` and `rsa.pub.pem` (ignored by this repository's `.gitignore`; regenerate a P-256 and an RSA key pair with `openssl` and re-sign `msg.bin`) |

The research notes were written before two design decisions the spec now reflects: Diceroll's keys are
ES256 under 2-of-3 offline roots, and pack documents are signed by the hardware release key (not the
Worker's content key).
