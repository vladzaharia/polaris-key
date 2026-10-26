/** Publish from CI's place in the URL: `?setup=ci` opens the drawer (a reload, the palette and the launch path all land on it). */

import * as React from "react";
import { navigate, useLocation } from "../../../../router.js";

export const CI_SETUP_ID = "ci";

export function usePublishFromCiRoute(): [boolean, (open: boolean) => void] {
  const { route, hash } = useLocation();
  const open = route.query.get("setup") === CI_SETUP_ID;
  const set = React.useCallback(
    (next: boolean) => {
      const q = new URLSearchParams(route.query);
      if (next) q.set("setup", CI_SETUP_ID);
      else if (q.get("setup") === CI_SETUP_ID) q.delete("setup");
      const path = hash.split("?")[0] || "#/";
      const s = q.toString();
      navigate(`${path}${s ? `?${s}` : ""}`, { replace: true });
    },
    [hash, route.query],
  );
  return [open, set];
}
