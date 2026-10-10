import * as React from "react";
import { Compass, KeyRound } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { markPartPath } from "../../ui/markPath.js";
import { useActivate } from "../activate.js";
import { href } from "../router.js";

const STAR = markPartPath("star", { kind: "key", size: 48, theme: "mono" });

/**
 * The empty library (§4.12): "Nothing here yet" (the page's subtitle already names the signed-in
 * email), Activate a license (the one primary), the stationary star on the right half from 900 px
 * (a top strip below that, hidden on short screens, where the task takes the whole card), and
 * "See N in Discover" once the Worker counts offers (G24). The "Ready to add" rows under it are
 * `DiscoverTeaser` (PX-16).
 */
export function LibraryEmpty({
  discoverCount = null,
}: {
  discoverCount?: number | null;
}): React.ReactElement {
  const activate = useActivate();
  return (
    <section
      aria-labelledby="empty-h"
      className="grid overflow-hidden rounded-xl border border-border bg-surface-raised shadow-elevation-1 mid:grid-cols-2 short:grid-cols-1"
    >
      <div className="order-2 flex flex-col gap-5 p-6 mid:order-1 mid:p-12">
        <h2
          id="empty-h"
          className="text-2xl font-semibold text-fg-strong desk:text-3xl"
        >
          Nothing here yet
        </h2>
        <p className="text-fg-muted">
          Products bought with this email show up here by themselves. Got a
          license key from a store or a developer? Activate it and the product
          joins your library.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button
            size="lg"
            className="h-12 font-medium"
            iconStart={<KeyRound aria-hidden />}
            onClick={() => activate.open()}
          >
            Activate a license
          </Button>
          {discoverCount ? (
            <Button asChild size="lg" variant="outline" className="h-12">
              <a href={href.discover()}>
                <Compass aria-hidden />
                See {discoverCount} in Discover
              </a>
            </Button>
          ) : null}
        </div>
      </div>
      <div
        aria-hidden
        className="order-1 flex h-28 items-center justify-center bg-accent-subtle mid:order-2 mid:h-auto short:hidden"
      >
        <svg viewBox={STAR.viewBox} className="size-16 fill-accent mid:size-36">
          <path d={STAR.d} />
        </svg>
      </div>
    </section>
  );
}
