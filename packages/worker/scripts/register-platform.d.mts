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
  /** ST-20: the system product's live break-glass claims (key and expiry only). */
  breakGlass?: { key: string; expiresAt: number }[];
  /** ST-20: the break-glass claims this deploy ended. */
  breakGlassEnded?: { key: string; why: "expired" | "changed" }[];
}
export declare function breakGlassLines(
  body: Pick<RegisterResult, "slug" | "breakGlass" | "breakGlassEnded">,
  env?: Record<string, string | undefined>,
): string[];
export declare function registerPlatform(opts: {
  origin: string;
  root: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  out?: { write(s: string): unknown };
}): Promise<RegisterResult>;
