import type { MintBlock } from "@polaris-key/catalog";

/** The lifetimes offered; the Worker's ceiling is one hour (`MINT_TTL_MAX`). */
export const TTL_PRESETS = [300, 900, 1800, 3600] as const;

/** A lifetime in words: "5 minutes", "1 hour", "90 seconds". */
export function ttlLabel(seconds: number): string {
  const unit = (n: number, one: string): string =>
    `${n} ${one}${n === 1 ? "" : "s"}`;
  if (seconds >= 3600 && seconds % 3600 === 0)
    return unit(seconds / 3600, "hour");
  if (seconds >= 60 && seconds % 60 === 0) return unit(seconds / 60, "minute");
  return unit(seconds, "second");
}

/** A moment in en-US words and UTC, for the preview ("Oct 22, 2026, 11:00 AM UTC"). */
const when = (sec: number): string =>
  new Date(sec * 1000).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }) + " UTC";

/**
 * What the app receives, decoded: the header and the claims a mint at `nowSec` would carry, one
 * claim per line with `exp` said in words. Built from the recipe as shown, never from a token; the
 * signature is not part of it.
 */
export function previewText(
  block: MintBlock,
  nowSec: number,
  asApproved: number | null,
): string {
  const ttl = block.ttlSeconds ?? 3600;
  const header = {
    alg: block.alg,
    ...(block.kid ? { kid: block.kid } : {}),
    typ: "JWT",
  };
  const claims: Record<string, unknown> = {
    ...(block.claimsTemplate ?? {}),
    ...(block.audience ? { aud: block.audience } : {}),
    iat: nowSec,
    exp: nowSec + ttl,
  };
  const note =
    asApproved !== null && asApproved !== ttl
      ? `${ttlLabel(ttl)} after iat`
      : `expires ${when(nowSec + ttl)}`;
  const lines = JSON.stringify(claims, null, 2).split("\n");
  return [
    "// Header",
    JSON.stringify(header, null, 2),
    `// Claims, if minted ${when(nowSec)}`,
    ...lines.map((l) =>
      l.trimStart().startsWith('"exp"') ? `${l}  // ${note}` : l,
    ),
  ].join("\n");
}
