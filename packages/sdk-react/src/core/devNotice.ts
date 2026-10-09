// Developer-only diagnostics. A mistake in the integration (pins left out, a page origin the
// product does not list) is the developer's to fix and their customers' to never read about: the
// kit shows end users its neutral screens, and says the specifics once, in the console, outside
// production builds.

declare const process: { env?: { NODE_ENV?: string } };

/** True in a production build. Written as the literal `process.env.NODE_ENV` bundlers replace;
 *  where `process` does not exist (an unbundled page) it is not production. */
export function isProduction(): boolean {
  try {
    return process.env?.NODE_ENV === "production";
  } catch {
    return false;
  }
}

const told = new Set<string>();

/** `console.error` a developer-facing diagnostic, once per `id`, never in production. */
export function developerError(id: string, message: string): void {
  if (isProduction() || told.has(id)) return;
  told.add(id);
  if (typeof console !== "undefined") console.error(`[polaris-key] ${message}`);
}

/** Forget what was told (tests). */
export function resetDeveloperErrors(): void {
  told.clear();
}
