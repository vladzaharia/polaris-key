/**
 * Admin groups from manifests (ST-32.8; the conversion offers of `GET /access/offers`): a product
 * whose manifest still names an admin group, which no longer grants access. "Map to … admin" hands
 * the product to the one RuleEditor (the page owns that flow); Dismiss and Dismiss all are made
 * here, each behind a confirmation, and the Worker audits each under its own product. Only a
 * Superadmin decides; everyone else reads the callout.
 */

import * as React from "react";
import { Button } from "../../../../ui/Button.js";
import { Callout } from "../../../../ui/Callout.js";
import { ConfirmDialog } from "../../../../ui/ConfirmDialog.js";
import { toast } from "../../../../ui/toast.js";
import { type AccessOffer } from "../../../../api.js";
import { describeMembersError } from "../../../access/membersModel.js";
import { mutate } from "../../../data/mutations.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";

export function OffersCard({
  offers,
  canDecide,
  readOnlyNote,
  noConnection,
  editing,
  accepted,
  onAccept,
  onDismissed,
}: {
  offers: readonly AccessOffer[];
  canDecide: boolean;
  /** Said to a reader who cannot decide: whom to ask. */
  readOnlyNote: string;
  /** No operator connection exists, so a rule can't be made yet. */
  noConnection: boolean;
  /** The editor is open: the callout waits. */
  editing: boolean;
  /** Products accepted in this visit: shown as done, and not counted. */
  accepted: ReadonlySet<string>;
  onAccept: (offer: AccessOffer) => void;
  /** After a dismissal: the product whose row comes next, or null when none is left. */
  onDismissed: (next: string | null) => void;
}): React.ReactElement | null {
  const [all, setAll] = React.useState(false);
  const [one, setOne] = React.useState<AccessOffer | null>(null);
  if (offers.length === 0) return null;
  const open = offers.filter((o) => !accepted.has(o.product));

  const nextAfter = (o: AccessOffer): string | null => {
    const rest = open.filter((x) => x.product !== o.product);
    const i = open.findIndex((x) => x.product === o.product);
    return rest[Math.min(i, rest.length - 1)]?.product ?? null;
  };

  return (
    <Callout
      tone="info"
      title="Admin groups from manifests"
      action={
        canDecide && open.length > 1 ? (
          <Button
            size="sm"
            variant="outline"
            disabled={editing}
            onClick={() => setAll(true)}
          >
            Dismiss all…
          </Button>
        ) : null
      }
    >
      <div data-sso-offers="">
        <p>
          {canDecide
            ? "A manifest no longer grants access. Map each group to a rule, or dismiss it."
            : readOnlyNote}
        </p>
        {canDecide && noConnection ? (
          <p className="text-xs text-fg-muted">
            Add an operator connection first.{" "}
            <Link to={r.platformConnections()}>Connections</Link>
          </p>
        ) : null}
        <ul className="divide-y divide-border" data-testid="sso-offers">
          {offers.map((o) => (
            <li
              key={o.product}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2"
              data-offer={o.product}
            >
              <div className="min-w-0 flex-[1_1_14rem]">
                <div className="font-medium text-fg-strong [overflow-wrap:anywhere]">
                  {o.name}
                </div>
                <div className="text-xs text-fg-muted [overflow-wrap:anywhere]">
                  Group <code className="font-mono">{o.group}</code>
                </div>
              </div>
              {canDecide ? (
                accepted.has(o.product) ? (
                  <span className="ms-auto text-xs text-fg-muted">
                    Rule added
                  </span>
                ) : (
                  <div className="ms-auto flex flex-wrap items-center justify-end gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      data-offer-accept=""
                      disabled={editing || noConnection}
                      onClick={() => onAccept(o)}
                    >
                      Map to {o.name} admin…
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={editing}
                      onClick={() => setOne(o)}
                    >
                      Dismiss…
                    </Button>
                  </div>
                )
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      <ConfirmDialog
        open={one !== null}
        onOpenChange={(v) => {
          if (!v) setOne(null);
        }}
        intent="caution"
        title={`Dismiss ${one?.name ?? ""}'s admin group?`}
        consequences={[
          "It won't be offered again.",
          `Nobody gets access from ${one?.group ?? ""}. You can still add a rule by hand.`,
        ]}
        confirmLabel="Dismiss"
        describeError={describeMembersError}
        onConfirm={async () => {
          if (!one) return;
          const o = one;
          await mutate("decideAccessOffer", o.product, { action: "dismiss" });
          toast.success(`${o.name}'s admin group dismissed`);
          onDismissed(nextAfter(o));
        }}
      />
      <ConfirmDialog
        open={all}
        onOpenChange={setAll}
        intent="caution"
        title="Dismiss all admin groups?"
        consequences={[
          "They won't be offered again. Nobody gets access from these groups.",
          "This can't be undone.",
        ]}
        confirmLabel="Dismiss all"
        describeError={describeMembersError}
        onConfirm={async () => {
          const r = await mutate("dismissAccessOffers");
          toast.success(
            r.dismissed.length === 1
              ? "1 admin group dismissed"
              : `${r.dismissed.length} admin groups dismissed`,
          );
          onDismissed(null);
        }}
      />
    </Callout>
  );
}
