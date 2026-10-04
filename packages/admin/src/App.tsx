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
        <Toaster>{KIT_ENABLED ? <DevKitOr /> : <Boot />}</Toaster>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

/**
 * Development only: `#/__kit` is the component gallery (ADMIN.md §4), which needs no session.
 * `import.meta.env.DEV` is false in a production build, so this branch, and the gallery chunk
 * behind it, are dropped from the bundle. The one exception is the CSP browser check
 * (`e2e/kit.e2e.test.ts`), which builds a separate bundle with `VITE_PK_KIT=1` into `dist-kit/`
 * to open every overlay under the Worker's policy; the shipped `dist/` never sets it.
 */
const KIT_ENABLED = import.meta.env.DEV || import.meta.env.VITE_PK_KIT === "1";
const Kit = KIT_ENABLED ? React.lazy(() => import("./kit/Kit.js")) : null;

function DevKitOr(): React.ReactElement {
  const hash = React.useSyncExternalStore(
    (cb) => {
      window.addEventListener("hashchange", cb);
      return () => window.removeEventListener("hashchange", cb);
    },
    () => window.location.hash,
  );
  if (Kit && hash.startsWith("#/__kit")) {
    return (
      <React.Suspense fallback={null}>
        <Kit />
      </React.Suspense>
    );
  }
  return <Boot />;
}

function Boot(): React.ReactElement {
  const me = useMe();
  if (me.data) return <AppShell me={me.data} />;
  if (me.isError) {
    return <BootScreen error onRetry={() => void me.refetch()} />;
  }
  return <BootScreen />;
}
