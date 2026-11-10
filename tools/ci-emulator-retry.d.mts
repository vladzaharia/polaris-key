/** Types for `ci-emulator-retry.mjs` (the kotlin-emulator job's retry decision). */

export const INFRA_SIGNATURE: RegExp;
export function shouldRetry(log: string | null): boolean;
