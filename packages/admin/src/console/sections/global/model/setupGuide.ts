import * as React from "react";
import { PREF_KEYS, readPref, writePref } from "../../../storage.js";
import { mutate } from "../../../data/mutations.js";
import { useMe } from "../../../data/hooks.js";

const parse = (raw: unknown): boolean | undefined =>
  typeof raw === "boolean" ? raw : undefined;

/**
 * Whether this operator hid Home's Platform ready guide. The server keeps it per operator
 * (`/me`'s `prefs`, LK-FU-2), so it follows them across browsers; this browser keeps a copy per
 * operator (`/me`'s `sub`) for the first paint and for a worker without the preference. A guide
 * hidden in this browser before the server kept it is sent up once. Another tab's change arrives
 * through the `storage` event. With no operator yet it is never hidden.
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
  const save = React.useCallback((next: boolean) => {
    void mutate("setMyPrefs", { setupGuideHidden: next }).catch(() => {
      // Best effort: this browser's copy still holds it.
    });
  }, []);
  const [hidden, setHidden] = React.useState(read);
  // The operator is known after the first paint: read their choice then.
  const [seen, setSeen] = React.useState(key);
  if (seen !== key) {
    setSeen(key);
    setHidden(read());
  }
  const server = useMe().data?.prefs?.setupGuideHidden;
  React.useEffect(() => {
    if (server === undefined || !key) return;
    if (!server && read()) {
      // Hidden here before the server kept it: send it up.
      save(true);
      return;
    }
    setHidden(server);
    writePref(key, server);
  }, [server, key, read, save]);
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
      if (key) save(next);
    },
    [key, save],
  );
  return [hidden, set];
}
