# Game Center certificate chain (public certificates)

Fetched 2026-10-29 02:52 UTC (2026-10-28 local) for I-14.5. Public certificates only; no key material.

| File                              | Source                                                                                            | SHA-256                                                            |
| --------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `gc-prod-12.der`                  | https://static.gc.apple.com/public-key/gc-prod-12.cer (valid 2026-03-17 to 2027-05-27)            | `aa1ba116e8e552e9085ec9df1c80eb02636a89cf7a4a1c3a4a528053b940b0b7` |
| `digicert-g4-codesigning-ca1.der` | https://cacerts.digicert.com/DigiCertTrustedG4CodeSigningRSA4096SHA3842021CA1.crt (to 2036-04-28) | `46011ede1c147eb2bc731a539b7c047b7ee93e48b9d3c3ba710ce132bbdfac6b` |
| `digicert-trusted-root-g4.der`    | https://cacerts.digicert.com/DigiCertTrustedRootG4.crt (to 2038-01-15)                            | `552f7bdcf1a7af9e6ce672017f4f12abf77240c78e761ac203d1d9d20ac89988` |

The CA1 and Root G4 hashes equal the fingerprints in plans/I-14.md F3. `test/core/x509Rsa.test.ts`
verifies the chain at the fixed instant 2026-10-28T00:00:00Z.
