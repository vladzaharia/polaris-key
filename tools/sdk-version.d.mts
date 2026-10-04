/** Types for `sdk-version.mjs` (the lockstep SDK version, F-10 automation). */

export declare const RELEASE_TAG: RegExp;
export declare const RELEASE_TAG_GLOB: string;
export interface ReleaseTagParts {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}
export declare function parseReleaseTag(tag: string): ReleaseTagParts | null;
export declare function toPep440(version: string): string;
export declare function nextVersion(latestTag: string | null): string;
export interface DerivedVersion {
  kind: "release" | "main";
  version: string;
  pep440: string;
  channel: "stable" | "beta" | "main";
  npmTag: "latest" | "beta" | "main";
}
export declare function deriveVersion(input: {
  ref: string;
  latestTag: string | null;
  distance: number;
}): DerivedVersion;
export declare function gitDescribe(cwd?: string): {
  latestTag: string | null;
  distance: number;
};
export interface StampTarget {
  file: string;
  pattern: RegExp;
  pep440?: boolean;
}
export declare const STAMP_TARGETS: StampTarget[];
export declare function publicPackageJsons(root: string): string[];
export declare function stampText(
  text: string,
  pattern: RegExp,
  version: string,
  file: string,
): string;
export declare function stampVersions(
  root: string,
  v: { version: string; pep440: string },
): string[];
