/**
 * The Offers card on Platform → Members → SSO rules (ST-32.8): a product that still names an admin
 * group in the old way is offered as a rule. Accept hands the product to the one RuleEditor (the page
 * owns that flow); Dismiss and Dismiss all are made here and the Worker audits each under its own
 * product. Only a Superadmin decides; everyone else reads the card.
 */

import * as React from "react";
import { Button } from "../../../../ui/Button.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { toast } from "../../../../ui/toast.js";
import { type AccessOffer } from "../../../../api.js";
import { describeMembersError } from "../../../access/membersModel.js";
import { mutate } from "../../../data/mutations.js";

export function OffersCard({
  offers,
  canDecide,
  editing,
  accepted,
  onAccept,
}: {
  offers: readonly AccessOffer[];
  canDecide: boolean;
  /** The editor is open: the card waits. */
  editing: boolean;
  /** Products accepted in this visit: their Accept stays off (the Worker's two commits). */
  accepted: ReadonlySet<string>;
  onAccept: (offer: AccessOffer) => void;
}): React.ReactElement | null {
  const [all, setAll] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  if (offers.length === 0) return null;

  const dismiss = async (o: AccessOffer): Promise<void> => {
    setBusy(o.product);
    try {
      await mutate("decideAccessOffer", o.product, { action: "dismiss" });
      toast.success(`Dismissed ${o.name}`);
    } catch (e) {
      const d = describeMembersError(e);
      toast.error(d.title, { description: d.description });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section
      aria-labelledby="sso-offers-title"
      className="rounded-lg border border-border bg-surface-raised"
      data-sso-offers=""
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3 sm:px-6">
        <div>
          <h2
            id="sso-offers-title"
            className="text-base font-semibold text-fg-strong"
          >
            Offers
          </h2>
          <p className="text-sm text-fg-muted">
            {offers.length === 1
              ? "1 product still uses an admin group."
              : `${offers.length} products still use an admin group.`}{" "}
            {canDecide
              ? "Turn each into a rule, or dismiss it."
              : "A Superadmin can turn them into rules."}
          </p>
        </div>
        {canDecide ? (
          <Button
            variant="outline"
            disabled={editing || busy !== null}
            onClick={() => setAll(true)}
          >
            Dismiss all…
          </Button>
        ) : null}
      </div>
      <ul className="divide-y divide-border" data-testid="sso-offers">
        {offers.map((o) => (
          <li
            key={o.product}
            className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 sm:px-6"
            data-offer={o.product}
          >
            <div className="min-w-0 flex-[1_1_16rem]">
              <div className="text-sm font-medium text-fg-strong [overflow-wrap:anywhere]">
                {o.name}
              </div>
              <div className="text-xs text-fg-muted [overflow-wrap:anywhere]">
                Group <code className="font-mono">{o.group}</code>
              </div>
            </div>
            {canDecide ? (
              <div className="ms-auto flex gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={editing || busy !== null || accepted.has(o.product)}
                  onClick={() => onAccept(o)}
                >
                  {accepted.has(o.product) ? "Accepted" : "Accept…"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={editing || busy !== null || accepted.has(o.product)}
                  onClick={() => void dismiss(o)}
                >
                  Dismiss
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={all}
        onOpenChange={setAll}
        intent="danger"
        title="Dismiss all offers?"
        description="Each product keeps its group and gets no rule. This is logged per product."
        confirmLabel="Dismiss all"
        describeError={describeMembersError}
        onConfirm={async () => {
          const r = await mutate("dismissAccessOffers");
          toast.success(
            r.dismissed.length === 1
              ? "Dismissed 1 offer"
              : `Dismissed ${r.dismissed.length} offers`,
          );
        }}
      />
    </section>
  );
}
