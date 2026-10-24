// The shared Tidewater fixture is plain JS; this types it as the elements' input.
import type { viewOf } from "@polaris-key/elements/headless";

import { STATES, gateInput as fixture } from "../../../shared/tidewater.js";

type UiInput = Parameters<typeof viewOf>[1];

export const states: readonly string[] = STATES;
export const gateInput = (state: string) => fixture(state) as UiInput;
