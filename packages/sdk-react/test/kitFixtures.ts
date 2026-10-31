// Representative inputs for component states that have no ui-matrix.json row yet. Browser
// baselines and the React conformance runner share these, so a should-tier state cannot disappear
// from one coverage surface while remaining in the other.

import type { ComponentName, UiInput } from "@polaris-key/ui-core";

export interface MatrixComponentRow {
  name: string;
  input: UiInput;
  expect: { component: ComponentName; state: string };
}

export interface ComponentStateFixture {
  id: string;
  component: ComponentName;
  state: string;
  input: UiInput;
  /** The corpus row this representative input comes from, when it has one. */
  row?: string;
}

export const componentStateId = (
  component: ComponentName,
  state: string,
): string => `${component}.${state}`;

function fixture(
  component: ComponentName,
  state: string,
  input: UiInput,
): ComponentStateFixture {
  return { id: componentStateId(component, state), component, state, input };
}

/**
 * The component registry's rows without a ui-matrix family. Keep every input direct: these are
 * state fixtures, not host-service fakes. `About` relies on the matrix defaults for the product's
 * identity. Each fixture carries the display facts its strings name (the sync time, the app's
 * version, the store that fixes the channel): ui-core never invents one, so a fixture without it
 * would draw the string's `{name}`.
 */
export const DIRECT_COMPONENT_STATE_FIXTURES: readonly ComponentStateFixture[] =
  [
    fixture("CloudSyncStatus", "synced", {
      services: ["sync"],
      cloudSync: { state: "synced", lastSynced: "2 min ago" },
    }),
    fixture("CloudSyncStatus", "syncing", {
      services: ["sync"],
      cloudSync: { state: "syncing" },
    }),
    fixture("CloudSyncStatus", "offline", {
      services: ["sync"],
      cloudSync: { state: "offline" },
    }),
    fixture("CloudSyncStatus", "conflict", {
      services: ["sync"],
      cloudSync: { state: "conflict" },
    }),
    fixture("CloudSyncStatus", "error", {
      services: ["sync"],
      cloudSync: { state: "error", signedIn: false },
    }),
    fixture("About", "default", {
      bundle: { slug: "tidewater", name: "Tidewater Studio", version: "2.4.1" },
    }),
    fixture("ChannelPicker", "default", { services: ["release"] }),
    fixture("ChannelPicker", "locked", {
      services: ["release"],
      channel: { locked: true, store: "Steam" },
    }),
  ];

/**
 * The row that represents a state when its first row is a transient moment. SignIn "code"'s first
 * row is "Use a code instead", pending: the screen says "Getting a sign-in code…". The loaded
 * state, the code and its countdown, is the device-code row.
 */
const REPRESENTATIVE_ROW: Readonly<Record<string, string>> = {
  "SignIn.code": "SignIn/code: a device-code sign-in",
};

/**
 * One representative non-hidden input per component state carried by ui-matrix.json. A repeated
 * row for the same state is a behavior case, not another visual baseline.
 */
export function matrixComponentStateFixtures(
  rows: readonly MatrixComponentRow[],
): ComponentStateFixture[] {
  const seen = new Set<string>();
  const fixtures: ComponentStateFixture[] = [];
  for (const row of rows) {
    const { component, state } = row.expect;
    const id = componentStateId(component, state);
    if (state === "hidden") continue;
    const chosen = REPRESENTATIVE_ROW[id];
    if (seen.has(id)) {
      // The named representative replaces the first row's fixture.
      if (chosen === row.name)
        fixtures[fixtures.findIndex((f) => f.id === id)] = {
          id,
          component,
          state,
          input: row.input,
          row: row.name,
        };
      continue;
    }
    seen.add(id);
    // The corpus paywall rows name the entitlement but not the tier that unlocks it; a render
    // that says "Upgrade to {tier}" needs one, or the line is rightly left out.
    // The corpus account row's holder is the word "account" and carries no tier or seats; a
    // render with a person's name, a tier and the seats in use is the signed-in pane as people
    // see it (the corpus keeps the minimal input for the copy it asserts).
    const input =
      component === "Paywall" &&
      row.input.entitlement !== undefined &&
      row.input.entitlement.tier === undefined
        ? {
            ...row.input,
            entitlement: { ...row.input.entitlement!, tier: "Pro" },
          }
        : component === "AccountAndLicense" && row.input.account?.signedIn
          ? {
              ...row.input,
              account: {
                holder: "Mara Fennick",
                tier: "Pro",
                devices: { used: 2, limit: 3 },
                autoUpdate: true,
                ...row.input.account,
                ...(row.input.account.holder === "account"
                  ? { holder: "Mara Fennick" }
                  : {}),
              },
            }
          : row.input;
    fixtures.push({ id, component, state, input, row: row.name });
  }
  return fixtures;
}
