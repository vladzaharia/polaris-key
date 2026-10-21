import { t } from "../../../lib/copy.js";
import * as React from "react";
import { KeyRound } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { href } from "../../router.js";
import { SectionCard } from "./Card.js";

/**
 * The product's sign-in card (PORTAL.md §4.20 "<Product> knows you as …", §3.1): shown only for
 * a product with Identity on (`services.identity` on `GET /api/products/<p>`), so an app that
 * doesn't use Polaris Key sign-in shows nothing about it. It says how the person signs in to the
 * app and that the app gets its own id for them (the pairwise subject, never the account id),
 * with **Manage sign-in methods**.
 *
 * Which of the person's methods the app knows them by needs the account's product users on the
 * portal API, which no route returns yet (PX-13's brief); until it does the card names no method
 * rather than guess one.
 */
export function ProductIdentityCard({
  productName,
}: {
  productName: string;
}): React.ReactElement {
  return (
    <SectionCard
      id="signin"
      title={t("locker.identity.title", { product: productName })}
    >
      <div className="flex gap-3">
        <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-fg-strong">
          <KeyRound aria-hidden className="size-5" />
        </span>
        <div className="min-w-0 space-y-1 text-sm">
          <p className="text-fg">
            {t("locker.identity.body", { product: productName })}
          </p>
          <p className="text-fg-muted">{t("locker.identity.note")}</p>
        </div>
      </div>
      <Button asChild variant="quiet" className="mt-4 h-10">
        <a href={href.account("methods")}>{t("locker.identity.manage")}</a>
      </Button>
    </SectionCard>
  );
}
