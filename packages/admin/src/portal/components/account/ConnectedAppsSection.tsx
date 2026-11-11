import * as React from "react";
import { PowerOff } from "lucide-react";
import { cn } from "../../../lib/cn.js";
import { Button } from "../../../ui/Button.js";
import { ErrorState } from "../../../ui/ErrorState.js";
import { toast } from "../../../ui/toast.js";
import { formatRelative } from "../../../lib/format.js";
import { t } from "../../../lib/copy.js";
import { PORTAL_FMT, formatDay } from "../../date.js";
import {
  HttpError,
  type PortalConnectedApp,
  type PortalConnectedGet,
  type PortalConnectedProduct,
} from "../../api.js";
import {
  useChangeConnectedApp,
  useConnectedApps,
  useDisconnectConnectedApp,
} from "../../data.js";
import { portalErrorCopy } from "../../errors.js";
import { focusSectionHeading } from "../../focus.js";
import { scrollBehavior } from "../../router.js";
import {
  InlinePanel,
  RemovePanel,
  useRemoveConfirm,
} from "../product/DeviceRowParts.js";
import { ProductIcon } from "../ProductIcon.js";
import { ClientRow } from "../signin/ClientConsentStep.js";
import {
  GetChip,
  clientChipText,
  clientGetText,
} from "../signin/clientGets.js";
import { AccountCard as SectionCard } from "./AccountCard.js";
import { devicesVisible } from "./DevicesSection.js";

type Claim = "name" | "picture" | "email";
const isClaim = (item: PortalConnectedGet["item"]): item is Claim =>
  item === "name" || item === "picture" || item === "email";

/**
 * Connected apps (I-21.15): the apps the person signed in to with a product's account, one group per
 * product. A row names the app (and its developer when another company makes it), where it returns
 * people and when it last signed them in, and what it gets as chips. **Change** opens a panel in the
 * row with a switch per optional item the person already decided; **Disconnect** opens the confirm
 * in place, as Devices does. An app that cannot sign anyone in now stays listed as "<Product> turned
 * this app off", with Disconnect only. The section is absent while it loads, with nothing connected
 * and on a Worker without the route ({@link connectedAppsVisible}).
 */
export function ConnectedAppsSection({
  shown,
}: {
  /** The page's verdict ({@link connectedAppsVisible}); the nav entry follows the same one. */
  shown: boolean;
}): React.ReactElement | null {
  const apps = useConnectedApps();
  if (!shown) return null;
  const groups = (apps.data ?? []).filter((g) => g.clients.length > 0);
  return (
    <SectionCard
      id="apps"
      title={t("locker.apps.title")}
      subtitle={t("locker.apps.subtitle")}
    >
      {apps.error ? (
        <ErrorState
          account
          error={apps.error}
          onRetry={() => void apps.refetch()}
          message={t("locker.error.loadFailedApps")}
          className="border-0 p-0 shadow-none"
        />
      ) : groups.length === 0 ? (
        <p className="text-sm text-fg-muted" data-apps-empty="">
          {t("locker.apps.none")}
        </p>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => (
            <Group key={g.product} group={g} />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

/**
 * Whether the Connected apps card (and its nav entry) shows: while it has rows, after they were all
 * disconnected this visit, on a failed load, and when the page was opened at it. Hidden while it
 * loads and on a Worker without the route (404). `hadRows` is the page's ref, set here.
 */
export function connectedAppsVisible(
  query: {
    isPending: boolean;
    error: unknown;
    data: PortalConnectedProduct[] | null | undefined;
  },
  hadRows: { current: boolean },
  wanted: boolean,
): boolean {
  return devicesVisible(
    { ...query, data: query.data?.flatMap((g) => g.clients) },
    hadRows,
    wanted,
  );
}

function Group({
  group,
}: {
  group: PortalConnectedProduct;
}): React.ReactElement {
  const headingId = `apps-${group.product}-h`;
  return (
    <section aria-labelledby={headingId} data-apps-product={group.product}>
      <h3 id={headingId} className="mb-1 text-sm font-medium text-fg-muted">
        {t("locker.apps.group", { product: group.name })}
      </h3>
      <ul className="-mx-4 divide-y divide-border border-y border-border desk:-mx-5 bigtext:max-sm:mx-0 [&>li]:px-4 desk:[&>li]:px-5 bigtext:max-sm:[&>li]:px-0">
        {group.clients.map((c) => (
          <AppRow key={c.clientId} group={group} app={c} />
        ))}
      </ul>
    </section>
  );
}

function AppRow({
  group,
  app,
}: {
  group: PortalConnectedProduct;
  app: PortalConnectedApp;
}): React.ReactElement {
  const { confirming, setConfirming, headingRef, removeRef, keep } =
    useRemoveConfirm();
  const [changing, setChanging] = React.useState(false);
  const changeRef = React.useRef<HTMLButtonElement>(null);
  const disconnect = useDisconnectConnectedApp();
  const changeable =
    app.available && app.gets.some((g) => !g.fixed && isClaim(g.item));
  // A reload can take the switches away (the app was turned off, or its items became fixed).
  React.useEffect(() => {
    if (!changeable) setChanging(false);
  }, [changeable]);
  // What the person decided shows as chips; what the app always gets is one muted line.
  const decided = app.gets.filter((g) => !g.fixed && isClaim(g.item));
  const always = app.gets.filter((g) => g.fixed && g.granted);
  const meta = [
    app.returnHost ? { text: app.returnHost, wrap: true } : null,
    {
      text: t("locker.apps.connected", { date: formatDay(app.grantedAt) }),
      wrap: false,
    },
    {
      wrap: false,
      text: app.lastUsedAt
        ? t("locker.apps.lastUsed", {
            when: formatRelative(app.lastUsedAt * 1000, Date.now(), PORTAL_FMT),
          })
        : t("locker.apps.neverUsed"),
    },
  ].filter((m): m is { text: string; wrap: boolean } => m !== null);
  const panelId = `disconnect-${group.product}-${app.clientId}`;
  const changeId = `change-${group.product}-${app.clientId}`;
  const busy = confirming || changing;
  const off = !app.available;
  return (
    <li className="py-4 @container" data-client={app.clientId}>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-3 @[34rem]:grid-cols-[auto_minmax(0,1fr)_auto]">
        <ProductIcon
          slug={group.product}
          name={app.name}
          tint={null}
          size={40}
          src={app.iconUrl ?? group.iconUrl}
          neutral
          className={off ? "grayscale" : undefined}
          tileClassName={off ? "text-fg-muted" : undefined}
        />
        <div className="min-w-0">
          <p
            className={cn(
              "flex flex-wrap items-baseline gap-x-2 gap-y-1 break-words font-semibold",
              off ? "text-fg-muted" : "text-fg-strong",
            )}
          >
            <bdi className="min-w-0 max-w-full [overflow-wrap:break-word]">
              {app.name}
            </bdi>
            {app.partner && app.developer ? (
              <span className="text-sm font-normal text-fg-muted">
                {t("locker.apps.by", { developer: app.developer })}
              </span>
            ) : null}
            {off ? (
              <span
                data-app-off-pill=""
                className="self-center whitespace-nowrap rounded-full border border-border-strong px-2 py-0.5 text-xs font-medium text-fg-muted"
              >
                {t("locker.apps.offPill")}
              </span>
            ) : null}
          </p>
          <p className="text-sm text-fg-muted">
            {meta.map((m, i) => (
              <React.Fragment key={i}>
                {i > 0 ? "\u00a0· " : null}
                <span
                  className={
                    m.wrap ? "[overflow-wrap:break-word]" : "whitespace-nowrap"
                  }
                >
                  {m.text}
                </span>
              </React.Fragment>
            ))}
          </p>
        </div>
        {off ? (
          <p
            data-app-off=""
            className="col-span-full row-start-2 flex items-start gap-1.5 text-xs text-fg-muted @[34rem]:col-span-2 @[34rem]:col-start-2 @[34rem]:row-start-2"
          >
            <PowerOff aria-hidden className="mt-px size-3.5 shrink-0" />
            {t("locker.apps.off", { product: group.name })}
          </p>
        ) : changing ? null : (
          <div className="col-span-full row-start-2 space-y-1.5 @[34rem]:col-span-2 @[34rem]:col-start-2 @[34rem]:row-start-2">
            {decided.length > 0 ? (
              <ul
                aria-label={t("locker.apps.gets", { app: app.name })}
                className="flex flex-wrap gap-1.5"
              >
                {decided.map((g) => (
                  <GetChip
                    key={g.item}
                    item={g.item}
                    granted={g.granted}
                    product={group.name}
                  />
                ))}
              </ul>
            ) : null}
            {always.length > 0 ? (
              <p className="text-xs text-fg-muted">
                {t("locker.apps.also", {
                  detail: always
                    .map((g) => clientChipText(g.item, group.name))
                    .join(", "),
                })}
              </p>
            ) : null}
          </div>
        )}
        {/* While a panel is open the column stays (hidden) beside the name, so the name does not
            reflow; under the name, where it holds no column, it leaves with the panel. */}
        <div
          style={busy ? { visibility: "hidden" } : undefined}
          className={cn(
            "col-span-full row-start-3 flex flex-wrap gap-2 @[22rem]:col-span-1 @[22rem]:col-start-2 @[34rem]:col-start-3 @[34rem]:row-start-1 @[34rem]:justify-end",
            busy && "@max-[34rem]:hidden",
          )}
        >
          {changeable ? (
            <Button
              ref={changeRef}
              variant="quiet"
              size="md"
              aria-label={t("locker.apps.changeName", { app: app.name })}
              aria-expanded={false}
              aria-controls={changeId}
              onClick={() => setChanging(true)}
            >
              {t("locker.apps.change")}
            </Button>
          ) : null}
          <Button
            ref={removeRef}
            variant="quiet"
            size="md"
            aria-label={t("locker.apps.disconnectName", { app: app.name })}
            aria-expanded={false}
            aria-controls={panelId}
            onClick={() => setConfirming(true)}
          >
            {t("locker.apps.disconnect")}
          </Button>
        </div>
      </div>
      {changeable ? (
        <ChangePanel
          id={changeId}
          open={changing}
          group={group}
          app={app}
          onClose={() => {
            setChanging(false);
            requestAnimationFrame(() => changeRef.current?.focus());
          }}
        />
      ) : null}
      <RemovePanel
        id={panelId}
        open={confirming}
        name={app.name}
        level={4}
        headingRef={headingRef}
        copy={{
          // The last two words stay together, so the question never wraps to a lone word.
          title: t("locker.apps.disconnectAsk", { app: app.name }).replace(
            / (\S+)$/,
            "\u00a0$1",
          ),
          failed:
            disconnect.error instanceof HttpError &&
            disconnect.error.status === 429
              ? portalErrorCopy(disconnect.error).line
              : t("locker.apps.disconnectFailed", { app: app.name }),
          keep: t("locker.apps.keep", { app: app.name }),
          confirm: t("locker.apps.disconnect"),
          confirmName: t("locker.apps.disconnectName", { app: app.name }),
          body: app.developer
            ? t("locker.apps.disconnectBody", {
                app: app.name,
                developer: app.developer,
              })
            : t("locker.apps.disconnectBodyNoDev", { app: app.name }),
        }}
        note={t("locker.apps.disconnectAgain")}
        error={Boolean(disconnect.error)}
        removing={disconnect.isPending}
        onKeep={() => {
          disconnect.reset();
          keep();
        }}
        onRemove={() =>
          disconnect.mutate(
            { product: group.product, clientId: app.clientId },
            {
              onSuccess: () => {
                // The toast's region is the announcement.
                toast.success(t("locker.apps.disconnected", { app: app.name }));
                // The row leaves with the refetch; the card stays, so its heading is always there.
                focusSectionHeading("apps");
              },
            },
          )
        }
      />
    </li>
  );
}

/**
 * Change what the app gets: a switch per optional item the person already decided, each fixed item
 * marked "Needed by <App>" (only Disconnect removes those). Save sends the switches that moved; a
 * `409` (the app's access changed underneath) offers Reload and keeps the panel as it is. Escape and
 * Cancel return focus to Change.
 */
function ChangePanel({
  id,
  open,
  group,
  app,
  onClose,
}: {
  id: string;
  open: boolean;
  group: PortalConnectedProduct;
  app: PortalConnectedApp;
  onClose: () => void;
}): React.ReactElement {
  const change = useChangeConnectedApp();
  const apps = useConnectedApps();
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const [draft, setDraft] = React.useState<Partial<Record<Claim, boolean>>>({});
  const items = app.gets.filter((g) => g.granted || isClaim(g.item));
  const on = (g: PortalConnectedGet): boolean =>
    isClaim(g.item) ? (draft[g.item] ?? g.granted) : g.granted;
  const moved = items.flatMap((g) =>
    isClaim(g.item) && !g.fixed && on(g) !== g.granted
      ? [[g.item, on(g)] as const]
      : [],
  );
  const reloadRef = React.useRef<HTMLButtonElement>(null);
  const close = (): void => {
    setDraft({});
    change.reset();
    onClose();
  };
  const conflict =
    change.error instanceof HttpError && change.error.status === 409;
  // The refused Save is read again and the panel stays open with the fresh values.
  const reload = (): void => {
    setDraft({});
    change.reset();
    void apps.refetch().then((r) => {
      const now = r.data
        ?.find((g) => g.product === group.product)
        ?.clients.find((c) => c.clientId === app.clientId);
      if (!now) return focusSectionHeading("apps");
      // Turned off underneath: the panel closes, so focus goes to the row's Disconnect.
      if (!now.available) {
        const btn = document.querySelector<HTMLElement>(
          `button[aria-controls="disconnect-${group.product}-${app.clientId}"]`,
        );
        if (btn) return btn.focus({ preventScroll: true });
        return focusSectionHeading("apps");
      }
      if (headingRef.current) headingRef.current.focus({ preventScroll: true });
      else focusSectionHeading("apps");
    });
  };
  // A refused Save on a phone leaves Save under the docked bar: Reload takes focus and shows.
  React.useEffect(() => {
    if (!conflict) return;
    reloadRef.current?.focus({ preventScroll: true });
    reloadRef.current?.scrollIntoView?.({
      block: "center",
      behavior: scrollBehavior(),
    });
  }, [conflict]);
  const failure = change.error
    ? conflict
      ? t("locker.apps.conflict")
      : change.error instanceof HttpError && change.error.status === 429
        ? portalErrorCopy(change.error).line
        : t("locker.apps.saveFailed")
    : null;
  const save = (): void =>
    change.mutate(
      {
        product: group.product,
        clientId: app.clientId,
        claims: Object.fromEntries(moved),
      },
      {
        onSuccess: () => {
          // The toast's region is the announcement.
          toast.success(t("locker.apps.saved", { app: app.name }));
          close();
        },
        // The grant is gone (disconnected in another tab): the list is read again and the row leaves.
        onError: (err) => {
          if (err instanceof HttpError && err.status === 404) {
            void apps.refetch();
            close();
          }
        },
      },
    );
  return (
    <InlinePanel id={id} open={open} headingRef={headingRef} onEscape={close}>
      <div className="space-y-3 rounded-lg border border-border-strong bg-surface-sunken p-4 @container">
        <h4
          ref={headingRef}
          tabIndex={-1}
          className="font-medium text-fg-strong outline-none"
        >
          {t("locker.apps.gets", { app: app.name })}
        </h4>
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface-raised">
          {items.map((g) => (
            <ClientRow
              key={g.item}
              line={{
                id: g.item,
                text: clientGetText(g.item, group.name),
                label: isClaim(g.item)
                  ? t(`locker.issuer.share.${g.item}`, { app: app.name })
                  : "",
                required: g.fixed,
                claim: isClaim(g.item),
                startsOff: false,
              }}
              lock={t("locker.apps.needed")}
              on={on(g)}
              onToggle={() =>
                isClaim(g.item) && setDraft((d) => ({ ...d, [g.item]: !on(g) }))
              }
            />
          ))}
        </ul>
        {failure ? (
          <p role="alert" className="text-sm text-danger">
            {failure}{" "}
            {conflict ? (
              <Button ref={reloadRef} variant="link" onClick={reload}>
                {t("locker.apps.reload")}
              </Button>
            ) : null}
          </p>
        ) : null}
        <div className="flex flex-col gap-2 @[22rem]:flex-row @[22rem]:justify-end">
          <Button variant="outline" onClick={close}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="neutral"
            disabled={moved.length === 0}
            loading={change.isPending}
            onClick={save}
          >
            {t("common.save")}
          </Button>
        </div>
      </div>
    </InlinePanel>
  );
}
