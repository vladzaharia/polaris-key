---
"@polaris-key/client-core": minor
"@polaris-key/node": minor
"@polaris-key/react": minor
---

Raise the supported Node floor from 22.0.0 to 22.12.0 (`engines.node: ">=22.12.0"`). The test
toolchain (vitest 4, rolldown) no longer runs on Node 22.0–22.11, so the floor CI job could not
prove those versions; 22.12 is the same LTS line.
