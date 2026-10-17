/**
 * `core.setup` (ST-39): the operator's explicit setup choices for one product, as one value.
 *
 *   { integrationHidden: { at, by } | null,   // "Hide integration", once a handshake is seen
 *     notUsing: string[],                     // channels the operator said they do not use
 *     runnerConsent: { at, by } | null,       // the setup runner may open a pull request
 *     skipped: string[] }                     // "<flow>.<step>" the operator skipped
 *
 * Choices only. Whether a step is done is a fact computed from state, never stored here, so the
 * wizard cannot disagree with the product. Written through `writeSetting()` like any setting.
 */

export interface SetupStamp {
  /** Epoch seconds. */
  at: number;
  by: string;
}

export interface SetupChoices {
  integrationHidden: SetupStamp | null;
  notUsing: string[];
  runnerConsent: SetupStamp | null;
  skipped: string[];
}

export const SETUP_LIST_MAX = 100;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

export const EMPTY_SETUP: SetupChoices = {
  integrationHidden: null,
  notUsing: [],
  runnerConsent: null,
  skipped: [],
};

const isStamp = (v: unknown): boolean => {
  if (v === null) return true;
  if (typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    Object.keys(r).length === 2 &&
    typeof r.at === "number" &&
    Number.isSafeInteger(r.at) &&
    r.at >= 0 &&
    typeof r.by === "string" &&
    r.by.length > 0 &&
    r.by.length <= 200
  );
};

const isIdList = (v: unknown): boolean =>
  Array.isArray(v) &&
  v.length <= SETUP_LIST_MAX &&
  new Set(v).size === v.length &&
  v.every((x) => typeof x === "string" && ID.test(x));

/** Is `value` exactly a `SetupChoices` (no other key, every list bounded and unique)? */
export function isSetupChoices(value: unknown): value is SetupChoices {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  const keys = Object.keys(r);
  return (
    keys.length === 4 &&
    isStamp(r.integrationHidden) &&
    isIdList(r.notUsing) &&
    isStamp(r.runnerConsent) &&
    isIdList(r.skipped)
  );
}
