/** Types for `register-platform.mjs` (imported by `test/registerPlatform.test.ts`). */
export declare const HOOK_PATH: string;
export declare function readManifestFiles(root: string): Record<string, string>;
export interface RegisterResult {
  ok: true;
  slug: string;
  created: boolean;
  repository: string;
  packages: string[];
  publisher: { workflow: string; environment: string } | null;
  publisherClaimed: boolean;
  publisherChanged: boolean;
}
export declare function registerPlatform(opts: {
  origin: string;
  root: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  out?: { write(s: string): unknown };
}): Promise<RegisterResult>;
