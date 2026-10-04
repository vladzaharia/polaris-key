// SDK identity reported in `X-PKey-SDK` / `X-PKey-SDK-Version`.
//
// Unlike sdk-node's version.ts this cannot read package.json at runtime — the browser bundle
// has no `createRequire` — so the version is a literal. CI stamps it with package.json
// (tools/sdk-version.mjs STAMP_TARGETS) before building; test/version.test.ts keeps the two in
// step in the tree.

export const SDK_NAME = "@polaris-key/react";
export const SDK_VERSION = "0.0.0";
