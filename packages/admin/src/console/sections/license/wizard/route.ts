/** New license (LX-29): the wizard's place in the URL. */

import * as React from "react";
import { navigate, useLocation } from "../../../router.js";
import { STEP_IDS, type StepId } from "./draft.js";

export const SETUP_ID = "new-license";
export type Step = StepId | "done";

const stepOf = (raw: string | null): Step =>
  raw === "done" || (STEP_IDS as readonly string[]).includes(raw ?? "")
    ? (raw as Step)
    : "tier";

/** The wizard's place in the URL: open, which step, and how to move. */
export function useNewLicenseRoute(): {
  open: boolean;
  step: Step;
  go: (step: Step | null, opts?: { replace?: boolean }) => void;
} {
  const { route, hash } = useLocation();
  const open = route.query.get("setup") === SETUP_ID;
  const step = stepOf(route.query.get("step"));
  const go = React.useCallback(
    (to: Step | null, opts: { replace?: boolean } = {}) => {
      const q = new URLSearchParams(route.query);
      if (to === null) {
        q.delete("setup");
        q.delete("step");
      } else {
        q.set("setup", SETUP_ID);
        q.set("step", to);
      }
      const path = hash.split("?")[0] || "#/";
      const s = q.toString();
      navigate(`${path}${s ? `?${s}` : ""}`, opts);
    },
    [hash, route.query],
  );
  return { open, step, go };
}
