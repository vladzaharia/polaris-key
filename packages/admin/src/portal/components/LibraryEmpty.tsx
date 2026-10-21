import * as React from "react";
import { PolarisMark } from "@polaris-key/brand/react";
import { KeyRound, Sparkles } from "lucide-react";
import { t } from "../../lib/copy.js";
import { Button } from "../../ui/Button.js";
import { useTheme } from "../../components/theme.js";
import { useActivate } from "../activate.js";
import { href } from "../router.js";

/**
 * The empty library (§4.12, mockup `portal.library-empty`, portal-17): one centred state, the
 * Locker mark in a tile, "Nothing here yet" (the page's subtitle already names the signed-in email),
 * **Activate license** (the header's own label, the one primary) and "See N in Discover" once the
 * Worker counts offers (G24). It takes the space between the title and "Missing a license?".
 */
export function LibraryEmpty({
  discoverCount = null,
}: {
  discoverCount?: number | null;
}): React.ReactElement {
  const activate = useActivate();
  const { theme } = useTheme();
  return (
    <section
      aria-labelledby="empty-h"
      className="flex flex-col items-center justify-center gap-5 py-12 text-center mid:py-20 short:py-6"
    >
      <span
        aria-hidden
        className="inline-flex size-12 items-center justify-center rounded-xl bg-surface-sunken"
      >
        <PolarisMark kind="locker" size={24} theme={theme} />
      </span>
      <h2 id="empty-h" className="text-xl font-semibold text-fg-strong">
        {t("locker.library.empty.title")}
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
              <Sparkles aria-hidden />
              {t("locker.library.empty.discover", { count: discoverCount })}
            </a>
          </Button>
        ) : null}
      </div>
    </section>
  );
}
