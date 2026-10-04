/**
 * The platform identities a pack id maps to on the store transports (P5-08; notes/S-01
 * §Recommendation; CONTENT §6.6). Shared by the CLI (`pkey transport …`, which uploads under these
 * names) and the Worker (readiness and the App Store Connect connector, which read them back).
 *
 *   apple-ba    `<pack>-c<contentApi>`: a live asset-pack version switches EVERY installed app
 *               version, so one asset pack per content level. App Store Connect accepts only
 *               alphanumerics and single hyphens (forum thread 818337) and never reuses an
 *               archived id, so only `.` is rewritten (to `-`), and the result must match
 *               `ASSET_PACK_ID_PATTERN` and be at most `ASSET_PACK_ID_MAX` characters.
 *   play-pad    the Gradle module and asset-pack name: `.` and `-` both become `_` (bundletool
 *               accepts letters, digits and underscores, starting with a letter).
 *
 * Both mappings are lossy (`diceroll.foes` and `diceroll-foes` share `diceroll-foes-c3`), and a
 * collision would upload into another pack's asset pack. So a product's mapping is resolved for
 * every pack bound to the transport at once (`resolveAssetPackIds`, `resolvePadPackNames`), and
 * any collision, grammar failure or overlong id is a typed error before anything is written or
 * uploaded.
 */

/** App Store Connect's asset-pack id grammar (notes/S-01 §5): alphanumerics and single hyphens. */
export const ASSET_PACK_ID_PATTERN = /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/;
/** At most this many characters, until Apple documents a limit (notes/S-01 §Recommendation). */
export const ASSET_PACK_ID_MAX = 64;
/** A Play asset-pack (Gradle module) name. */
export const PAD_PACK_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
/** The longest Play asset-pack name this tool writes (module names are path segments). */
export const PAD_PACK_NAME_MAX = 64;

/** Why a pack id cannot be bound to a store transport. */
export type TransportIdErrorCode =
  | "asset-pack-id-invalid"
  | "asset-pack-id-too-long"
  | "asset-pack-id-collision"
  | "pad-pack-name-invalid"
  | "pad-pack-name-collision";

export interface TransportIdProblem {
  code: TransportIdErrorCode;
  packId: string;
  /** The mapped id (`<base>-c<n>`, or the Play pack name). */
  mapped: string;
  /** The other pack id mapping to the same id (collisions). */
  other?: string;
  message: string;
}

/** A typed refusal: every problem found, so the operator fixes them in one pass. */
export class TransportIdError extends Error {
  readonly problems: readonly TransportIdProblem[];
  readonly code: TransportIdErrorCode;
  constructor(problems: readonly TransportIdProblem[]) {
    super(problems.map((p) => `${p.code}: ${p.message}`).join("\n"));
    this.name = "TransportIdError";
    this.problems = problems;
    this.code = problems[0]!.code;
  }
}

/**
 * The asset-pack base of a pack id: `.` → `-`; any character outside `[a-z0-9.-]` is refused
 * (null), never rewritten (defence in depth: P2-03's grammar admits none).
 */
export function assetPackBase(packId: string): string | null {
  if (!/^[a-z0-9.-]+$/.test(packId)) return null;
  return packId.replaceAll(".", "-");
}

/** The asset pack a pack needs at one content level: `<base>-c<contentApi>` (unchecked). */
export function assetPackId(packId: string, contentApi: number): string {
  return `${assetPackBase(packId) ?? packId}-c${contentApi}`;
}

/**
 * The content level an asset-pack id names and its base: `foes-c4` → {base: "foes", level: 4};
 * null when it does not end in `-c<digits>`.
 */
export function parseAssetPackId(
  id: string,
): { base: string; level: number } | null {
  const m = /^(.+)-c(0|[1-9][0-9]{0,8})$/.exec(id);
  return m ? { base: m[1]!, level: Number(m[2]) } : null;
}

/**
 * Map every apple-ba pack id of a product at one content level. Returns packId → asset-pack id,
 * or throws a {@link TransportIdError} listing every collision, grammar failure and overlong id.
 */
export function resolveAssetPackIds(
  packIds: Iterable<string>,
  contentApi: number,
): Map<string, string> {
  if (!Number.isSafeInteger(contentApi) || contentApi < 0)
    throw new Error(
      `contentApi must be a whole number (got ${String(contentApi)}).`,
    );
  const ids = [...new Set(packIds)].sort();
  const problems: TransportIdProblem[] = [];
  const out = new Map<string, string>();
  const byBase = new Map<string, string>();
  for (const packId of ids) {
    const base = assetPackBase(packId);
    const mapped = `${base ?? packId}-c${contentApi}`;
    if (base === null || !ASSET_PACK_ID_PATTERN.test(mapped)) {
      problems.push({
        code: "asset-pack-id-invalid",
        packId,
        mapped,
        message: `${packId} maps to asset pack ${mapped}, which App Store Connect refuses (alphanumerics and single hyphens only; a segment starting or ending with "-" doubles a hyphen).`,
      });
      continue;
    }
    if (mapped.length > ASSET_PACK_ID_MAX) {
      problems.push({
        code: "asset-pack-id-too-long",
        packId,
        mapped,
        message: `${packId} maps to asset pack ${mapped}, ${mapped.length} characters; at most ${ASSET_PACK_ID_MAX} (the pack id itself may have at most ${ASSET_PACK_ID_MAX - `-c${contentApi}`.length} at level ${contentApi}).`,
      });
      continue;
    }
    // The suffix is the same for every pack at one level, so colliding bases collide at every
    // level: compare the bases.
    const prior = byBase.get(base);
    if (prior !== undefined) {
      problems.push({
        code: "asset-pack-id-collision",
        packId,
        mapped,
        other: prior,
        message: `${packId} and ${prior} both map to asset pack ${mapped}; an upload would land in the other pack's asset pack, permanently. Rename one of them.`,
      });
      out.delete(prior);
      continue;
    }
    byBase.set(base, packId);
    out.set(packId, mapped);
  }
  if (problems.length) throw new TransportIdError(problems);
  return out;
}

/** The Play asset-pack name of a pack id: `.` and `-` → `_` (unchecked). */
export function padPackName(packId: string): string {
  return packId.replace(/[.-]/g, "_");
}

/**
 * Map every play-pad pack id of a product. Returns packId → Play asset-pack name, or throws a
 * {@link TransportIdError}.
 */
export function resolvePadPackNames(
  packIds: Iterable<string>,
): Map<string, string> {
  const ids = [...new Set(packIds)].sort();
  const problems: TransportIdProblem[] = [];
  const out = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const packId of ids) {
    const mapped = padPackName(packId);
    if (
      !/^[a-z0-9.-]+$/.test(packId) ||
      !PAD_PACK_NAME_PATTERN.test(mapped) ||
      mapped.length > PAD_PACK_NAME_MAX
    ) {
      problems.push({
        code: "pad-pack-name-invalid",
        packId,
        mapped,
        message: `${packId} maps to Play asset pack ${mapped}, which is not a valid asset-pack name (a letter, then letters, digits and underscores; at most ${PAD_PACK_NAME_MAX}).`,
      });
      continue;
    }
    const prior = byName.get(mapped);
    if (prior !== undefined) {
      problems.push({
        code: "pad-pack-name-collision",
        packId,
        mapped,
        other: prior,
        message: `${packId} and ${prior} both map to Play asset pack ${mapped}. Rename one of them.`,
      });
      out.delete(prior);
      continue;
    }
    byName.set(mapped, packId);
    out.set(packId, mapped);
  }
  if (problems.length) throw new TransportIdError(problems);
  return out;
}
