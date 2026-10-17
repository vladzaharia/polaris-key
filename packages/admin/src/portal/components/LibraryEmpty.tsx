import * as React from "react";
import { Compass, KeyRound } from "lucide-react";
import { t } from "../../lib/copy.js";
import { Button } from "../../ui/Button.js";
import { markPartPath } from "../../ui/markPath.js";
import { useActivate } from "../activate.js";
import { href } from "../router.js";

const STAR = markPartPath("star", { kind: "key", size: 48, theme: "mono" });

/**
 * The empty library (§4.12, mockup `portal.library-empty`): one centred state, the star in an
 * accent tile, "Nothing here yet" (the page's subtitle already names the signed-in email),
 * **Activate license** (the header's own label, the one primary) and "See N in Discover" once the
 * Worker counts offers (G24). It takes the space between the title and the strips. The "Ready to
 * add" rows under it are `DiscoverTeaser` (PX-16).
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
      className="flex flex-col items-center justify-center gap-5 py-12 text-center mid:py-20 short:py-6"
    >
      <span
        aria-hidden
        className="inline-flex size-12 items-center justify-center rounded-xl bg-accent-subtle"
      >
        <svg viewBox={STAR.viewBox} className="size-6 fill-accent">
          <path d={STAR.d} />
        </svg>
      </span>
      <h2 id="empty-h" className="text-xl font-semibold text-fg-strong">
        Nothing here yet
      </h2>
      <div className="flex flex-wrap justify-center gap-3">
        <Button
          size="lg"
          className="h-12 font-medium"
          iconStart={<KeyRound aria-hidden />}
          onClick={() => activate.open()}
        >
          {t("activate.submit")}
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
    </section>
  );
}
