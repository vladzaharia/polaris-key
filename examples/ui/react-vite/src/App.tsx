// The app the gate lets in: Tidewater's own shell (its header, its pages), with the kit's parts
// on the Settings page. Everything inside <main> on the Studio page is the host's, not the kit's.
import { useEffect, useState } from "react";
import { usePolarisAuth } from "@polaris-key/react";

import { SettingsPage } from "./SettingsPage";

type Page = "studio" | "settings";

function pageOf(hash: string): Page {
  return hash === "#/settings" ? "settings" : "studio";
}

export function App() {
  const [page, setPage] = useState<Page>(() => pageOf(location.hash));
  useEffect(() => {
    const on = () => setPage(pageOf(location.hash));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const { signOut, profile } = usePolarisAuth();

  return (
    <div className="app">
      <header className="app-bar">
        <strong className="app-name">Tidewater Studio</strong>
        <nav aria-label="Pages">
          <a href="#/" aria-current={page === "studio" ? "page" : undefined}>
            Studio
          </a>
          <a
            href="#/settings"
            aria-current={page === "settings" ? "page" : undefined}
          >
            Settings
          </a>
        </nav>
        <button type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      <main className="app-main">
        {page === "settings" ? (
          <SettingsPage />
        ) : (
          <section className="studio">
            <h1>Studio</h1>
            <p>
              {profile?.firstName
                ? `Welcome back, ${profile.firstName}.`
                : "Welcome back."}{" "}
              Your sessions open here.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
