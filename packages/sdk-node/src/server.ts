// The crash-tag convention the Worker's Sentry hook reads (SDK parity pass §3.14).
//
// `verifyLicenseDocument`, which lived here, moved to `@polaris-key/server` in 0.9 with no alias
// (framework drop-ins plan §12.1): a backend gates a route with that package.

/** The tags a crash reporter attaches (SDK parity pass §3.14, the Worker's Sentry convention). */
export interface CrashTags {
  /** `<deliverable>@<version>[+<build>]`. */
  release: string;
  /** The release channel. */
  environment: string;
  /** The outlet id the install came from. */
  "pkey.outlet": string;
}

/** Build the crash tags from explicit values (the facade's `client.crashTags()` fills them). */
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
