// `usePolarisFetch()`: a `fetch` for the app's own backend that carries the signed licence
// document (`X-PKey-License`) and the device id (`X-PKey-Device`). Same origin is allowed by
// default; add others with `config.backend.origins` on `<PolarisKeyProvider>`. In Electron it
// goes through the desktop bridge's `backendHeaders`. See `createPolarisFetch` for the retry and
// the typed refusals.

import { useMemo } from "react";
import {
  createPolarisFetch,
  type BackendOptions,
  type PolarisFetch,
} from "../core/backend.js";
import { useCtx } from "./hooks.js";

/** The page's backend `fetch`. Stable while the adapter and the origins are. */
export function usePolarisFetch(options: BackendOptions = {}): PolarisFetch {
  const { adapter, backend } = useCtx();
  const key = JSON.stringify([backend?.origins ?? [], options.origins ?? []]);
  return useMemo(() => {
    const [fromProvider, fromHook] = JSON.parse(key) as [string[], string[]];
    return createPolarisFetch(adapter, {
      origins: [...fromProvider, ...fromHook],
    });
  }, [adapter, key]);
}
