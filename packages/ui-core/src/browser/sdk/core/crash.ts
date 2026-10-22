// Crash-report tags (SDK parity pass §3.14, feature `crash.tags`): the release, environment and
// outlet a Sentry init carries, in exactly the convention the Worker's Sentry hook parses back
// (packages/worker/src/services/distribution/sentry.ts, `parseSentryRelease`): `release` is
// `<deliverable>@<version>[+<build>]`, `environment` the channel and the `pkey.outlet` tag the
// outlet. `@polaris-key/node`'s `crashTagsFor`, value for value. No crash SDK dependency.

/** What a Sentry init takes: `release`, `environment` and one tag. */
export interface CrashTags {
  release: string;
  environment: string;
  "pkey.outlet": string;
}

/** Build the tags from explicit values (pure). `deliverable` defaults to `app`, a missing
 *  outlet to `unknown`. */
export function crashTagsFor(o: {
  version: string;
  channel: string;
  outlet?: string | null;
  deliverable?: string;
  build?: string | null;
}): CrashTags {
  const build = o.build ? `+${o.build}` : "";
  return {
    release: `${o.deliverable ?? "app"}@${o.version}${build}`,
    environment: o.channel,
    "pkey.outlet": o.outlet || "unknown",
  };
}

/** `adapter.crashTags()`'s options. */
export interface CrashTagsOptions {
  /** The deliverable the release names. Default `app`. */
  deliverable?: string;
  /** The build number, appended as `+<build>`. */
  build?: string | null;
}
