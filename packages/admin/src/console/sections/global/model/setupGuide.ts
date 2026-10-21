import * as React from "react";
import { PREF_KEYS, readPref, writePref } from "../../../storage.js";

const parse = (raw: unknown): boolean | undefined =>
  typeof raw === "boolean" ? raw : undefined;

/**
 * Whether this operator hid Home's Platform ready guide, kept per operator (`/me`'s `sub`) in
 * this browser (the console has no server-side preference store; ADMIN.md §5.3). Another tab's
 * change arrives through the `storage` event. With no operator yet it is never hidden.
 */
export function useSetupGuideHidden(
  operator: string | undefined,
): [hidden: boolean, set: (hidden: boolean) => void] {
  const key = operator
    ? `${PREF_KEYS.setupGuideHiddenPrefix}${operator}`
    : null;
  const read = React.useCallback(
    () => (key ? readPref(key, parse, false) : false),
    [key],
  );
  const [hidden, setHidden] = React.useState(read);
  // The operator is known after the first paint: read their choice then.
  const [seen, setSeen] = React.useState(key);
  if (seen !== key) {
    setSeen(key);
    setHidden(read());
  }
  React.useEffect(() => {
    const onStorage = (e: StorageEvent): void => {
      if (e.key === key) setHidden(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [key, read]);
  const set = React.useCallback(
    (next: boolean) => {
      setHidden(next);
      if (key) writePref(key, next);
    },
    [key],
  );
  return [hidden, set];
}
