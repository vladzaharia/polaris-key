---
"@polaris-key/cli": minor
---

CI publishing (P2-02, P2-06). `pkey release publish` uploads a release's artifacts through a
trusted-publishing ticket (GitHub Actions OIDC, single-part PUTs with `x-amz-checksum-sha256`) and
submits its descriptor; `pkey release promote|pin|unpin|yank` manage channels; `pkey auth
github-oidc` exchanges a GitHub OIDC token for a short-lived `pkeyci_` token; `pkey manifest
schemas` prints the manifest JSON Schemas. Retries happen only on responses marked
`retryable: true`, and a 429 on the token exchange backs off. The same code ships as the
`polaris-key/publish` GitHub Action (`actions/publish`).
