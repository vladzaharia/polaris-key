/**
 * `core.setup` on the client (ST-39): the operator's explicit setup choices for one product, as the
 * Worker's `core/settings/setupShape.ts` defines them. Choices only. Whether a step is done is a
 * fact the page computes from the product's state, never something stored here.
 */

export interface SetupStamp {
  /** Epoch seconds. */
  at: number;
  by: string;
}

export interface SetupChoices {
  /** "Hide integration", once a handshake was seen. */
  integrationHidden: SetupStamp | null;
  /** Channels the operator said they do not use. */
  notUsing: string[];
  /** The setup runner may open a pull request. */
  runnerConsent: SetupStamp | null;
  /** `<flow>.<step>` the operator skipped. */
  skipped: string[];
}

export const SETUP_KEY = "core.setup";
/** The registry area `core.setup` lives in, so its read is one small request. */
export const SETUP_AREA = "setup";
export const EMPTY_SETUP: SetupChoices = {
  integrationHidden: null,
  notUsing: [],
  runnerConsent: null,
  skipped: [],
};

/** A stored value as choices; anything that is not the shape reads as nothing chosen. */
export function parseSetup(value: unknown): SetupChoices {
  if (!value || typeof value !== "object") return EMPTY_SETUP;
  const v = value as Partial<SetupChoices>;
  const stamp = (s: unknown): SetupStamp | null =>
    s &&
    typeof s === "object" &&
    typeof (s as SetupStamp).at === "number" &&
    typeof (s as SetupStamp).by === "string"
      ? { at: (s as SetupStamp).at, by: (s as SetupStamp).by }
      : null;
  const ids = (l: unknown): string[] =>
    Array.isArray(l) ? l.filter((x): x is string => typeof x === "string") : [];
  return {
    integrationHidden: stamp(v.integrationHidden),
    notUsing: ids(v.notUsing),
    runnerConsent: stamp(v.runnerConsent),
    skipped: ids(v.skipped),
  };
}

/** The key a skipped step is stored under. */
export const skipKey = (flow: string, step: string): string =>
  `${flow}.${step}`;

const withId = (list: string[], id: string, on: boolean): string[] =>
  on
    ? list.includes(id)
      ? list
      : [...list, id]
    : list.filter((x) => x !== id);

/** The pure edits. Each takes the choices in force and returns the next; the page saves them. */
export const edit = {
  skip:
    (flow: string, step: string, on = true) =>
    (c: SetupChoices) => ({
      ...c,
      skipped: withId(c.skipped, skipKey(flow, step), on),
    }),
  notUsing:
    (channel: string, on = true) =>
    (c: SetupChoices) => ({
      ...c,
      notUsing: withId(c.notUsing, channel, on),
    }),
  hideIntegration: (stamp: SetupStamp | null) => (c: SetupChoices) => ({
    ...c,
    integrationHidden: stamp,
  }),
  runnerConsent: (stamp: SetupStamp | null) => (c: SetupChoices) => ({
    ...c,
    runnerConsent: stamp,
  }),
};

export type SetupEdit = (c: SetupChoices) => SetupChoices;

/** The skipped step ids of one flow. */
export function skippedIn(c: SetupChoices, flow: string): string[] {
  const prefix = `${flow}.`;
  return c.skipped
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
}
