---
title: "Publish from CI sets itself up"
date: "2026-10-26"
version: "0.9.18"
type: "feature"
services: ["release", "distribution"]
sdks: []
---

With the GitHub App's optional write permissions, **Publish from CI** creates the `release` environment (limited to `v*` tags) and the `v*` tag ruleset, and opens one `pkey/setup` pull request with the release workflow. Polaris Key never merges it. `pkey ci init` is the fallback without the permissions. The new `distribution:pr` scope lets a publish job open Homebrew and Scoop pull requests with a one-hour GitHub token for the declared tap or bucket, so `PKEY_PR_TOKEN` is optional there. Accept the new permissions on each installation. See [Publishing from CI](/docs/features/ship-builds/ci/).
