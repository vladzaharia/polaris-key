import * as React from "react";
import { useLocation } from "./router.js";
import { SETTINGS_INDEX } from "./settings.generated.js";
import { focusWhenReady } from "./shell/palette/focus.js";

/**
 * A palette deep link (`?setting=<key>`, ST-10) lands on the setting's row: once `ready` (the
 * page's rows are drawn) the element `idOf(name)` is scrolled into view and focused, for the key
 * and each older spelling the page may know it by. A page without the row stays put.
 */
export function useSettingTarget(
  ready: boolean,
  idOf: (name: string) => string,
): void {
  const key = useLocation().route.query.get("setting");
  React.useEffect(() => {
    if (!ready || !key) return;
    const names = [
      key,
      ...(SETTINGS_INDEX.find((e) => e.key === key)?.aliases ?? []),
    ];
    const cancels = names.map((n) => focusWhenReady(idOf(n), 1500));
    return () => cancels.forEach((c) => c());
    // `idOf` is a module-level function at each caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, key]);
}
