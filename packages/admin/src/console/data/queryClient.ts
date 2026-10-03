/**
 * The console's one TanStack Query client (docs/design/ADMIN.md §0.4: staleness, focus refetch,
 * dedupe and declared invalidation; fixes SH-1 and SH-16).
 *
 * It is a module singleton rather than something created per `<App>` because the legacy views
 * reach the cache through `context.tsx`'s `useResource` adapter, which views and their tests use
 * with no provider in the tree. `App.tsx` still mounts a `QueryClientProvider` with this same
 * client, so the new console code uses the ordinary hooks.
 */

import { QueryClient } from "@tanstack/react-query";

/** How long a successful read is fresh: no refetch on remount inside this window. */
export const STALE_TIME_MS = 30_000;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME_MS,
        // The server's answer is the truth (§0.2): refetch when the operator comes back to the tab.
        refetchOnWindowFocus: true,
        // No silent retries: a failed read shows its error and a Retry the operator controls.
        retry: false,
      },
      mutations: { retry: false },
    },
  });
}

export const queryClient = createQueryClient();
