import * as React from "react";
import { ExternalLink, LifeBuoy, Mail } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import type { LibraryProduct } from "../../model/library.js";
import { SectionCard } from "./Card.js";

/** Help (§4.20): who handles licenses and downloads, and how to reach them (G16). */
export function HelpCard({
  product,
}: {
  product: LibraryProduct;
}): React.ReactElement {
  const { developer, supportUrl, supportEmail, website } = product.presentation;
  const who = developer ?? "The developer";
  return (
    <SectionCard id="help" title="Need help?">
      <div className="space-y-4">
        <p className="flex gap-3 text-sm text-fg-muted">
          <LifeBuoy aria-hidden className="mt-0.5 size-4 shrink-0" />
          {who} handles licenses and downloads for {product.name}.
        </p>
        <div className="flex flex-wrap gap-2">
          {supportUrl ? (
            <Button asChild variant="quiet">
              <a href={supportUrl} target="_blank" rel="noreferrer">
                <ExternalLink aria-hidden />
                Contact {developer ?? "the developer"}
              </a>
            </Button>
          ) : supportEmail ? (
            <Button asChild variant="quiet">
              <a href={`mailto:${supportEmail}`}>
                <Mail aria-hidden />
                Email {supportEmail}
              </a>
            </Button>
          ) : null}
          {website ? (
            <a
              href={website}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 text-sm text-fg-strong hover:underline"
            >
              <ExternalLink aria-hidden className="size-4" />
              {new URL(website).host}
            </a>
          ) : null}
        </div>
      </div>
    </SectionCard>
  );
}
