/**
 * The console's TanStack Query client (docs/design/ADMIN.md §0.4: staleness, focus refetch,
 * dedupe and declared invalidation; fixes SH-1 and SH-16).
 *
 * The client is provider-scoped: `ConsoleQueryProvider` creates one per mounted tree, so the app,
 * each test render and the kit gallery start from an empty cache, and every read reaches it through
 * the ordinary hooks (`useQuery`, `useQueryClient`). Writes stay plain calls (`mutate` in
 * `mutations.ts`), which know no tree: the provider binds its client to that write path while it
 * is mounted, so a confirmed write invalidates what it declared in every mounted tree's cache.
 */

import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { bindWriteInvalidation } from "./mutations.js";

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

/**
 * The console's query provider. Creates its own client unless one is passed (a test that needs to
 * seed or inspect the cache creates it with `createQueryClient()` and passes it in).
 */
export function ConsoleQueryProvider({
  client,
  children,
}: {
  client?: QueryClient;
  children: React.ReactNode;
}): React.ReactElement {
  const [own] = React.useState(() => client ?? createQueryClient());
  // A layout effect, so the client is bound before any passive effect of the commit that mounts
  // it runs: a write from a child's mount effect invalidates this cache too.
  React.useLayoutEffect(() => bindWriteInvalidation(own), [own]);
  return <QueryClientProvider client={own}>{children}</QueryClientProvider>;
}
