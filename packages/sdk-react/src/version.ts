// SDK identity reported in `X-Polaris-SDK` / `X-Polaris-SDK-Version`.
//
// Unlike sdk-node's version.ts this cannot read package.json at runtime — the browser bundle
// has no `createRequire` — so the version is a literal kept in step with package.json by the
// versionMatchesPackage test.

export const SDK_NAME = "@plrs/react";
export const SDK_VERSION = "0.0.0";
