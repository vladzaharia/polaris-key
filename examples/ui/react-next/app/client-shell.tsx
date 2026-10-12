"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  desktopAdapter,
  PolarisKeyProvider,
  usePolarisAuth,
} from "@polaris-key/react";
import { PolarisKeyGate } from "@polaris-key/react/kit";

import { tidewaterBridge } from "./fixtures";
import { polarisKey as samplePolarisKey } from "./polaris.config";

const LIVE = process.env.NEXT_PUBLIC_POLARIS_LIVE === "1";
const APP_VERSION = "2.4.1";

/** The explicit App Router client boundary for the Provider, fixture adapter, gate and hooks. */
export function ClientShell({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const polarisKey = useMemo(() => {
    if (!mounted) return null;
    if (LIVE) {
      return {
        ...samplePolarisKey,
        mode: "browser" as const,
        version: APP_VERSION,
      };
    }

    return {
      ...samplePolarisKey,
      version: APP_VERSION,
      adapter: desktopAdapter({ bridge: tidewaterBridge() }),
    };
  }, [mounted]);
  if (!polarisKey) return null;
  const returnUrl =
    typeof window === "undefined" ? undefined : window.location.href;

  return (
    <PolarisKeyProvider config={polarisKey}>
      <PolarisKeyGate returnUrl={returnUrl}>
        <AppFrame>{children}</AppFrame>
      </PolarisKeyGate>
    </PolarisKeyProvider>
  );
}

function AppFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { profile, signOut } = usePolarisAuth();

  return (
    <div className="app">
      <header className="app-bar">
        <strong className="app-name">Tidewater Studio</strong>
        <nav aria-label="Pages">
          <Link href="/" aria-current={pathname === "/" ? "page" : undefined}>
            Studio
          </Link>
          <Link
            href="/settings"
            aria-current={pathname === "/settings" ? "page" : undefined}
          >
            Settings
          </Link>
        </nav>
        {profile?.name ? (
          <span className="app-profile">{profile.name}</span>
        ) : null}
        <button type="button" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
