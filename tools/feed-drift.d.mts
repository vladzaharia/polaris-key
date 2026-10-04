/** Types for `feed-drift.mjs` (the post-publish feed drift check, F-10 automation). */

export interface PackageDeliverable {
  id: string;
  ecosystem: string;
  name: string;
}
export interface Listing {
  versions: string[];
  tags: Record<string, string | boolean> | null;
}
export interface Expected {
  version: string;
  pep440: string;
  channel: string;
}
export declare function compareSemver(a: string, b: string): number | null;
export declare function comparePep440(a: string, b: string): number | null;
export declare function kindOf(
  version: string,
  ecosystem: string,
): "stable" | "beta" | "main";
export declare function readFeed(
  origin: string,
  owner: string,
  deliverable: PackageDeliverable,
): Promise<Listing>;
export declare function checkListing(
  deliverable: PackageDeliverable,
  listing: Listing,
  expected: Expected,
): string[];
export declare function packageDeliverables(root: string): PackageDeliverable[];
export declare function checkDrift(opts: {
  origin: string;
  owner: string;
  root: string;
  expected: Expected;
  timeoutSec: number;
  only?: string[];
  log?: (m: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<Map<string, string[]>>;
