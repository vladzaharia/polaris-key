import * as React from "react";
import { ServicesCard } from "./services/ServicesCard.js";

/**
 * The Services section — platform, not per-service, because a service cannot own its own off
 * switch: it would have to be running to be turned off. It stays reachable for a product that
 * runs nothing at all, which is the whole point of it living under Platform.
 */
export function Services({ slug }: { slug: string }): React.ReactElement {
  return (
    <section aria-labelledby="services-title" className="space-y-6">
      <header className="space-y-1">
        <h2
          id="services-title"
          className="text-xl font-semibold tracking-tight"
        >
          Services
        </h2>
        <p className="text-sm text-muted-foreground">
          What <span className="font-medium text-foreground">{slug}</span> runs,
          and how its devices are allowed to register.
        </p>
      </header>

      <ServicesCard slug={slug} />
    </section>
  );
}
