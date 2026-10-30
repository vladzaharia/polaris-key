import { numberRangeError } from "../../../../ui/NumberInput.js";
import {
  confirmBlocked,
  NEEDS_APP_NAME,
  type ConfirmBlock,
} from "../../../../ui/confirmReasons.js";

/** The rollout percentage the Play Console accepts (A-17a). */
export function fractionGate(
  fraction: number | null,
  appName: string,
  control: string | undefined,
): ConfirmBlock {
  return confirmBlocked(
    [
      control === "rollout/fraction" &&
        numberRangeError(fraction, {
          min: 0.01,
          max: 99.99,
          percent: true,
          required: true,
        }) !== null,
      "Enter a percentage between 0.01 and 99.99",
    ],
    [
      control === "phased-release/complete" && appName.trim() === "",
      NEEDS_APP_NAME,
    ],
  );
}

/** What each connector control needs before Confirm: a release, a group, a track. */
export function controlGate(
  control: string | undefined,
  v: {
    releaseId: string | null;
    groupId: string;
    track: string | null;
    priority: number | null;
  },
): ConfirmBlock {
  const priority = control === "priority";
  return confirmBlocked(
    [priority && !v.releaseId, "Choose a release first"],
    [
      control === "testflight/public-link" && v.groupId.trim() === "",
      "Enter a beta group to continue",
    ],
    [priority && !v.track, "Choose a track first"],
    [
      priority && (v.priority === null || v.priority < 0 || v.priority > 5),
      "Enter a priority from 0 to 5",
    ],
  );
}
