/** Types for `feed-closure.mjs` (the feed closure check and the pre-publish gate, P0-52). */

export declare const SCOPE: string;
export declare const DEFAULT_ORIGIN: string;
export declare const DEFAULT_OWNER: string;

export interface Pin {
  name: string;
  spec: string;
  field: "dependencies" | "optionalDependencies" | "peerDependencies";
}
export interface VersionManifest {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  deprecated?: string;
}
export interface Packument {
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, VersionManifest>;
}
export interface BrokenPin {
  name: string;
  version: string;
  dep: string;
  spec: string;
  problem: string;
  /** The dependent's deprecation message: installers already steer away from it. */
  deprecated: string | null;
}
export interface PypiFile {
  filename: string;
  yanked?: boolean | string;
}
export interface PypiProject {
  name: string;
  versions?: string[];
  files?: PypiFile[];
}

export declare function siblingPins(
  manifest: VersionManifest | null | undefined,
  scope?: string,
): Pin[];
export declare function splitSpec(spec: string): {
  name: string;
  version: string;
};
export declare function pinProblem(
  pin: Pin,
  listed: Map<string, Set<string> | null>,
): string | null;
export declare function listedVersions(
  packuments: Map<string, Packument | null>,
  assume?: string[],
): Map<string, Set<string> | null>;
export declare function npmClosure(
  packuments: Map<string, Packument | null>,
  opts?: { assume?: string[] },
): { packages: number; versions: number; broken: BrokenPin[] };
export declare function missingFromSet(
  packuments: Map<string, Packument | null>,
  names: string[],
  version: string,
): string[];
export declare function pypiFileVersion(filename: string): string | null;
export declare function pypiClosure(project: PypiProject): {
  versions: number;
  broken: { name: string; version: string; problem: string }[];
};
export declare function readPackument(
  origin: string,
  owner: string,
  name: string,
  fetchImpl?: typeof fetch,
): Promise<Packument | null>;
export declare function readPackuments(
  origin: string,
  owner: string,
  names: string[],
  fetchImpl?: typeof fetch,
): Promise<Map<string, Packument | null>>;
export declare function readPypiProject(
  origin: string,
  owner: string,
  name: string,
  fetchImpl?: typeof fetch,
): Promise<PypiProject>;
export declare function readTarEntry(
  tgz: Buffer,
  wanted: string,
): Buffer | null;
export declare function tarballManifest(tgz: Buffer): {
  name: string;
  version: string;
} & VersionManifest;
export declare function tarballsAt(path: string): string[];
export declare function waitForPins(opts: {
  origin: string;
  owner: string;
  pins: Pin[];
  timeoutSec: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (m: string) => void;
}): Promise<Pin[]>;
export declare function main(argv: string[]): Promise<number>;
