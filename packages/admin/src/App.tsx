import * as React from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "./components/theme.js";
import { Toaster } from "./components/ui/index.js";
import { queryClient } from "./console/data/queryClient.js";
import { useMe } from "./console/data/hooks.js";
import { AppShell } from "./console/shell/AppShell.js";
import { BootScreen } from "./console/shell/StatePages.js";

/**
 * The operator console (docs/design/ADMIN.md §2). Loads the session (`/me`, a query like any
 * other, so it refreshes on focus and after a product create or delete), then hands the frame to
 * `AppShell`, which reads the route from the hash.
 */
export function App(): React.ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <Toaster>
          <Boot />
        </Toaster>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

function Boot(): React.ReactElement {
  const me = useMe();
  if (me.data) return <AppShell me={me.data} />;
  if (me.isError) {
    return <BootScreen error onRetry={() => void me.refetch()} />;
  }
  return <BootScreen />;
}
