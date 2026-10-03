import * as React from "react";
import { AlertTriangle, FlaskConical, Grid2x2Check } from "lucide-react";
import {
  api,
  type CompatAppReleaseDto,
  type CompatCellDto,
  type CompatCellState,
  type CompatPackReleaseDto,
  type CompatResponse,
  type DistributionMatrix,
  type MatrixCellDto,
  type SimulateParams,
  type SimulateResponse,
  type SimulatedPackDto,
  type SimulatedReleaseDto,
} from "../../api.js";
import { useResource } from "../../context.js";
import { docsUrl } from "../../lib/docsLinks.js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  Skeleton,
} from "../../components/ui/index.js";
import { cn } from "../../lib/cn.js";

/**
 * The Release section's Compatibility tab (P4-15, CONTENT §6.9 "console", README §6.2 item 4).
 *
 * Two read-only views, each rendering what the worker computed and never recomputing it:
 *
 * - The MATRIX (`GET …/release/compat`): app releases × pack releases, each cell pinned, held,
 *   compatible, incompatible or revoked, with the release that IS the current set member ringed,
 *   yanked shown as a modifier, the live contentApi levels highlighted (P4-12's floor-based live
 *   computation), each app release's `unsatisfied` markers, and a per-outlet liveness overlay.
 *   The overlay comes from Distribution's own matrix (`GET …/distribution/matrix`), fetched
 *   separately and joined here, so Release's endpoint stays distribution-free (CONTENT §6.3); it
 *   carries P4-14's readiness, so an outlet holding the release says so.
 * - The SIMULATOR (`GET …/update/simulate`): pick an app release, a platform, an outlet and a
 *   variant and see the decision a fresh device reaches, the set it runs and its packSetId, and per
 *   pack the declared and effective binding with the reason, its feed target and gate, the floor,
 *   the unsatisfied markers and the revocations. The worker runs client-core's own update check, so
 *   there is no second implementation here.
 *
 * Floors, holds, pins and yanks are edited where they live (Releases → channel policy and yanks;
 * `.pkey/release` for pins and holds), never from here.
 */

const STATE_LABEL: Record<CompatCellState, string> = {
  pinned: "pinned",
  held: "held",
  compatible: "compatible",
  incompatible: "incompatible",
  revoked: "revoked",
};

const STATE_CLASS: Record<CompatCellState, string> = {
  pinned: "bg-primary/15 text-accent-fg",
  held: "bg-warning/15 text-warning",
  compatible: "bg-success/15 text-success",
  incompatible: "bg-muted text-muted-foreground",
  revoked: "bg-destructive/15 text-destructive",
};

const PLATFORMS = [
  "macos",
  "ios",
  "android",
  "windows",
  "linux",
  "web",
  "tvos",
  "visionos",
] as const;

/** Releases per channel and per pack in one page; `offset` moves the window. */
const PAGE = 10;
/** Distribution's matrix maximum: the overlay only knows its newest this many releases. */
const LIVENESS_WINDOW = 50;

export function Compatibility({ slug }: { slug: string }): React.ReactElement {
  const [offset, setOffset] = React.useState(0);
  const compat = useResource<CompatResponse>(
    `release-compat:${slug}:${offset}`,
    () => api.releaseCompat(slug, { limit: PAGE, offset }),
  );
  // The liveness overlay: Distribution's matrix of the app, newest releases (its own maximum).
  const liveness = useResource<DistributionMatrix>(
    `distribution-matrix:${slug}:compat`,
    () =>
      api.distributionMatrix(slug, {
        deliverable: "app",
        limit: LIVENESS_WINDOW,
      }),
  );

  return (
    <div className="space-y-4">
      <MatrixCard
        slug={slug}
        compat={compat.data}
        loading={compat.loading}
        error={compat.error}
        liveness={liveness.data}
        livenessError={liveness.error}
        onOlder={() => setOffset((n) => n + PAGE)}
        onNewer={() => setOffset((n) => Math.max(0, n - PAGE))}
      />
      <SimulatorCard
        slug={slug}
        compat={compat.data}
        outlets={liveness.data?.outlets ?? []}
      />
    </div>
  );
}

// ── the matrix ────────────────────────────────────────────────────────────────────────────

function MatrixCard({
  compat,
  loading,
  error,
  liveness,
  livenessError,
  onOlder,
  onNewer,
}: {
  slug: string;
  compat: CompatResponse | null;
  loading: boolean;
  error: unknown;
  liveness: DistributionMatrix | null;
  livenessError: unknown;
  onOlder: () => void;
  onNewer: () => void;
}): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Grid2x2Check className="size-4" aria-hidden /> Compatibility
        </CardTitle>
        <CardDescription>
          Which pack release each app release runs with. A ringed cell is the
          current set member; levels marked live are the contentApi lines the
          feed carries.{" "}
          <a
            className="underline underline-offset-2"
            href={docsUrl("compatSimulator")}
          >
            How to read it
          </a>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && !compat ? (
          <Skeleton className="h-32 w-full" />
        ) : error ? (
          <p role="alert" className="text-sm text-destructive">
            The compatibility matrix could not be loaded.
          </p>
        ) : !compat || compat.appReleases.length === 0 ? (
          <EmptyState
            title="No app releases yet"
            description="The matrix fills in once an app release with content is published."
          />
        ) : (
          <>
            <LiveLevels compat={compat} />
            <Legend />
            {livenessError ? (
              <p className="text-xs text-muted-foreground">
                Per-outlet liveness is unavailable (Distribution is off or did
                not answer).
              </p>
            ) : null}
            <CompatTable compat={compat} liveness={liveness} />
            <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
              <span>
                Live releases, then releases {compat.offset + 1}–
                {compat.offset + compat.limit} of each channel and pack, newest
                first.
                {compat.older.appReleases > 0 || compat.older.packReleases > 0
                  ? ` ${compat.older.appReleases} older app releases and ${compat.older.packReleases} older pack releases are on later pages.`
                  : ""}
              </span>
              {compat.capped ? (
                <Badge variant="warning">capped at 200 app releases</Badge>
              ) : null}
              {compat.offset > 0 ? (
                <Button size="sm" variant="outline" onClick={onNewer}>
                  Newer releases
                </Button>
              ) : null}
              {compat.older.appReleases > 0 || compat.older.packReleases > 0 ? (
                <Button size="sm" variant="outline" onClick={onOlder}>
                  Older releases
                </Button>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function LiveLevels({ compat }: { compat: CompatResponse }) {
  const channels = Object.keys(compat.liveLevels);
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-xs"
      aria-label="Live contentApi levels"
    >
      <span className="text-muted-foreground">Live levels:</span>
      {channels.length === 0 ? (
        <span className="text-muted-foreground">none</span>
      ) : (
        channels.map((c) => (
          <span key={c} className="inline-flex items-center gap-1">
            <span className="font-mono">{c}</span>
            {compat.liveLevels[c]!.map((l) => (
              <Badge key={l} variant="success">
                contentApi {l}
              </Badge>
            ))}
          </span>
        ))
      )}
    </div>
  );
}

function Legend() {
  return (
    <ul className="flex flex-wrap gap-2 text-xs" aria-label="Cell states">
      {(Object.keys(STATE_LABEL) as CompatCellState[]).map((s) => (
        <li key={s} className={cn("rounded-sm px-1.5 py-0.5", STATE_CLASS[s])}>
          {STATE_LABEL[s]}
        </li>
      ))}
      <li className="rounded-sm px-1.5 py-0.5 ring-2 ring-primary">current</li>
      <li className="rounded-sm px-1.5 py-0.5 line-through">yanked</li>
    </ul>
  );
}

/** Which outlets serve an app release, from Distribution's matrix (live, or held by P4-14). */
function overlayFor(
  liveness: DistributionMatrix | null,
  releaseId: string,
): { outletId: string; cell: MatrixCellDto }[] | "unknown" {
  if (!liveness) return [];
  // Distribution's matrix lists its newest releases only: anything older is unknown, not "none".
  if (!liveness.releases.some((r) => r.releaseId === releaseId))
    return "unknown";
  return liveness.cells
    .filter((c) => c.releaseId === releaseId)
    .filter(
      (c) =>
        c.availability === "live" ||
        (c.readiness !== undefined &&
          c.readiness !== null &&
          (c.readiness.holds || c.readiness.warning !== null)),
    )
    .map((c) => ({ outletId: c.outletId, cell: c }));
}

function CompatTable({
  compat,
  liveness,
}: {
  compat: CompatResponse;
  liveness: DistributionMatrix | null;
}) {
  const byPack = new Map<string, CompatPackReleaseDto[]>();
  for (const p of compat.packReleases)
    byPack.set(p.pack, [...(byPack.get(p.pack) ?? []), p]);
  const cellOf = new Map<string, CompatCellDto>();
  for (const c of compat.cells)
    cellOf.set(`${c.appReleaseId}\u0000${c.packReleaseId}`, c);
  const liveLevels = new Set(compat.levels);
  const packs = compat.packs.filter((p) => byPack.has(p.id));

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            <th rowSpan={2} className="border-b p-2 text-left align-bottom">
              App release
            </th>
            <th rowSpan={2} className="border-b p-2 text-left align-bottom">
              Outlets
            </th>
            {packs.map((p) => (
              <th
                key={p.id}
                colSpan={byPack.get(p.id)!.length}
                className="border-b border-l p-2 text-left font-mono"
              >
                {p.id}{" "}
                <span className="font-sans font-normal text-muted-foreground">
                  {p.binding}
                  {p.required ? ", required" : ""}
                </span>
              </th>
            ))}
          </tr>
          <tr>
            {packs.flatMap((p) =>
              byPack.get(p.id)!.map((r, i) => (
                <th
                  key={r.releaseId}
                  className={cn(
                    "border-b p-2 text-left font-mono font-normal",
                    i === 0 && "border-l",
                    r.yanked && "line-through",
                  )}
                  title={packReleaseTitle(r)}
                >
                  {r.version}
                  {r.revoked ? (
                    <Badge variant="destructive" className="ml-1">
                      revoked
                    </Badge>
                  ) : null}
                </th>
              )),
            )}
          </tr>
        </thead>
        <tbody>
          {compat.appReleases.map((a) => (
            <tr key={a.releaseId} data-testid={`compat-row-${a.releaseId}`}>
              <th scope="row" className="border-b p-2 text-left align-top">
                <AppReleaseHeader a={a} liveLevels={liveLevels} />
              </th>
              <td className="border-b p-2 align-top">
                <Overlay entries={overlayFor(liveness, a.releaseId)} />
              </td>
              {packs.flatMap((p) =>
                byPack.get(p.id)!.map((r, i) => {
                  const c = cellOf.get(`${a.releaseId}\u0000${r.releaseId}`);
                  return (
                    <td
                      key={r.releaseId}
                      className={cn(
                        "border-b p-1 align-top",
                        i === 0 && "border-l",
                      )}
                    >
                      {c ? <Cell c={c} /> : null}
                    </td>
                  );
                }),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function packReleaseTitle(r: CompatPackReleaseDto): string {
  const parts = [
    r.requires.contentApi.length > 0
      ? `contentApi ${r.requires.contentApi.join(", ")}`
      : "no contentApi requirement",
  ];
  if (r.requires.engines.length > 0)
    parts.push(`engine ${r.requires.engines.join(", ")}`);
  if (r.yanked) parts.push(`yanked: ${r.yanked.reason}`);
  if (r.revoked) parts.push(`revoked: ${r.revoked.reason}`);
  return parts.join("; ");
}

function AppReleaseHeader({
  a,
  liveLevels,
}: {
  a: CompatAppReleaseDto;
  liveLevels: ReadonlySet<number>;
}) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1">
        <span className={cn("font-mono", a.yanked && "line-through")}>
          {a.version}
        </span>
        {a.channel ? (
          <span className="text-muted-foreground">{a.channel}</span>
        ) : null}
        {a.yanked ? <Badge variant="destructive">yanked</Badge> : null}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        {a.contentApi !== null ? (
          <Badge
            variant={
              a.live && liveLevels.has(a.contentApi) ? "success" : "outline"
            }
          >
            contentApi {a.contentApi}
          </Badge>
        ) : (
          <span className="text-muted-foreground">no contentApi</span>
        )}
        {a.live ? (
          <Badge variant="primary">live on {a.liveOn.join(", ")}</Badge>
        ) : (
          <span className="text-muted-foreground">not live</span>
        )}
        {a.unsatisfied.length > 0 ? (
          <Badge
            variant="warning"
            title={a.unsatisfied
              .map((u) => `${u.pack} (${u.platform}): ${u.reason}, ${u.detail}`)
              .join("\n")}
          >
            <AlertTriangle className="size-3" aria-hidden />
            {a.unsatisfied.length} unsatisfied
          </Badge>
        ) : null}
      </div>
    </div>
  );
}

function Overlay({
  entries,
}: {
  entries: { outletId: string; cell: MatrixCellDto }[] | "unknown";
}) {
  if (entries === "unknown")
    return (
      <span className="text-muted-foreground">
        unknown (outside Distribution's newest {LIVENESS_WINDOW})
      </span>
    );
  if (entries.length === 0)
    return <span className="text-muted-foreground">none</span>;
  return (
    <ul className="flex flex-wrap gap-1" aria-label="Outlets serving it">
      {entries.map(({ outletId, cell }) => {
        const r = cell.readiness ?? null;
        if (r && r.holds)
          return (
            <li key={outletId}>
              <Badge
                variant="warning"
                title={r.blockers
                  .map((b) => `${b.pack}: ${b.detail}`)
                  .join("\n")}
              >
                {outletId}: held
              </Badge>
            </li>
          );
        return (
          <li key={outletId}>
            <Badge
              variant={r?.warning ? "warning" : "success"}
              title={r?.warning ?? undefined}
            >
              {outletId}
              {r?.warning ? ": not ready" : ""}
            </Badge>
          </li>
        );
      })}
    </ul>
  );
}

function Cell({ c }: { c: CompatCellDto }) {
  return (
    <span
      title={c.reason}
      data-state={c.state}
      data-current={c.current ? "true" : "false"}
      className={cn(
        "inline-block rounded-sm px-1.5 py-0.5",
        STATE_CLASS[c.state],
        c.current && "ring-2 ring-primary",
        c.yanked && "line-through",
      )}
    >
      {STATE_LABEL[c.state]}
      {c.current ? (
        <span className="sr-only"> (current set member)</span>
      ) : null}
      {c.yanked ? <span className="sr-only"> (yanked)</span> : null}
    </span>
  );
}

// ── the simulator ─────────────────────────────────────────────────────────────────────────

const selectClass =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-pk-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring";

function SimulatorCard({
  slug,
  compat,
  outlets,
}: {
  slug: string;
  compat: CompatResponse | null;
  outlets: DistributionMatrix["outlets"];
}): React.ReactElement {
  const apps = compat?.appReleases ?? [];
  const [appRelease, setAppRelease] = React.useState("");
  const [platform, setPlatform] = React.useState("");
  const [outlet, setOutlet] = React.useState("");
  const [variant, setVariant] = React.useState("");
  const [device, setDevice] = React.useState("");
  const [reported, setReported] = React.useState("");
  const [result, setResult] = React.useState<SimulateResponse | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const chosen = apps.find((a) => a.releaseId === appRelease) ?? apps[0];
  const appId = appRelease || chosen?.releaseId || "";
  const platforms =
    chosen && chosen.platforms.length > 0 ? chosen.platforms : [...PLATFORMS];
  const plat =
    platform && platforms.includes(platform) ? platform : (platforms[0] ?? "");

  const run = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!appId || !plat) return;
    setBusy(true);
    setFailure(null);
    const params: SimulateParams = {
      appRelease: appId,
      platform: plat,
      ...(outlet ? { outlet } : {}),
      ...(variant.trim() ? { variant: variant.trim() } : {}),
      ...(device.trim() ? { device: device.trim() } : {}),
      ...(reported.trim() ? { packSetId: reported.trim() } : {}),
    };
    try {
      setResult(await api.simulateUpdate(slug, params));
    } catch (err) {
      setResult(null);
      setFailure(err instanceof Error ? err.message : "The simulation failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FlaskConical className="size-4" aria-hidden /> What does this device
          get?
        </CardTitle>
        <CardDescription>
          Runs the update check a fresh device runs (the same code the SDKs use)
          against the feed this channel serves now. Nothing is stored.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          onSubmit={(e) => void run(e)}
          className="grid gap-3 sm:grid-cols-3"
          aria-label="Simulator"
        >
          <div className="space-y-1">
            <Label htmlFor="sim-app">App release</Label>
            <select
              id="sim-app"
              className={selectClass}
              value={appId}
              onChange={(e) => setAppRelease(e.target.value)}
            >
              {apps.map((a) => (
                <option key={a.releaseId} value={a.releaseId}>
                  {a.version}
                  {a.contentApi !== null ? ` (contentApi ${a.contentApi})` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="sim-platform">Platform</Label>
            <select
              id="sim-platform"
              className={selectClass}
              value={plat}
              onChange={(e) => setPlatform(e.target.value)}
            >
              {platforms.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="sim-outlet">Outlet</Label>
            <select
              id="sim-outlet"
              className={selectClass}
              value={outlet}
              onChange={(e) => setOutlet(e.target.value)}
            >
              <option value="">none detected</option>
              {outlets.map((o) => (
                <option key={o.outletId} value={o.outletId}>
                  {o.outletId} ({o.kind})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="sim-variant">Variant</Label>
            <Input
              id="sim-variant"
              placeholder="texture=etc2;tier=hd"
              value={variant}
              onChange={(e) => setVariant(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sim-device">Device id (rollout buckets)</Label>
            <Input
              id="sim-device"
              placeholder="optional"
              value={device}
              onChange={(e) => setDevice(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="sim-reported">Reported packSetId</Label>
            <Input
              id="sim-reported"
              placeholder="optional, to compare"
              value={reported}
              onChange={(e) => setReported(e.target.value)}
            />
          </div>
          <div className="sm:col-span-3">
            <Button type="submit" disabled={busy || !appId || !plat}>
              {busy ? "Simulating…" : "Simulate"}
            </Button>
          </div>
        </form>
        {failure ? (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        ) : null}
        {result ? <SimulateResult r={result} /> : null}
      </CardContent>
    </Card>
  );
}

function releaseText(r: SimulatedReleaseDto | null): string {
  return r ? r.version : "none";
}

function decisionText(d: SimulateResponse["decision"]): string {
  if (!d) return "no decision";
  const reason = typeof d.reason === "string" ? ` (${d.reason})` : "";
  const block =
    typeof d.contentBlock === "string"
      ? `, content block ${d.contentBlock}`
      : "";
  return `${d.action}${reason}${block}`;
}

function SimulateResult({ r }: { r: SimulateResponse }) {
  return (
    <section aria-label="Simulation result" className="space-y-3 text-sm">
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted-foreground">Device</dt>
        <dd>
          {r.selector.version} on {r.selector.platform}
          {r.selector.outlet ? ` via ${r.selector.outlet.id}` : ""}
          {r.selector.contentApi !== null
            ? `, contentApi ${r.selector.contentApi}`
            : ""}
          {r.selector.engine ? `, ${r.selector.engine}` : ""}
        </dd>
        <dt className="text-muted-foreground">Decision</dt>
        <dd data-testid="sim-decision">
          <Badge variant={r.block ? "destructive" : "outline"}>
            {decisionText(r.decision)}
          </Badge>
          {r.boot ? (
            <span className="ml-2 text-muted-foreground">boot: {r.boot}</span>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">packSetId</dt>
        <dd className="font-mono text-xs break-all" data-testid="sim-packsetid">
          {r.packSetId ?? "none"}
        </dd>
        {r.reported ? (
          <>
            <dt className="text-muted-foreground">Reported</dt>
            <dd>
              {r.reported.matches ? (
                <Badge variant="success">matches</Badge>
              ) : (
                <Badge variant="destructive">differs</Badge>
              )}
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Feed</dt>
        <dd>
          {r.feed.composable ? "composable" : "not composable"}
          {Object.keys(r.feed.selector).length > 0
            ? ", per platform"
            : ", channel-wide"}
          {r.feed.omitted.length > 0
            ? `; left out: ${r.feed.omitted.join(", ")}`
            : ""}
          {r.feed.appRollout?.rollout
            ? `; app rollout ${r.feed.appRollout.rollout.bp / 100}%${r.feed.appRollout.bucket !== null ? ` (bucket ${r.feed.appRollout.bucket})` : ""}`
            : ""}
          {r.feed.appRollout?.halted ? "; app halted" : ""}
        </dd>
      </dl>
      {r.notes.length > 0 || r.errors.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {r.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
          {r.errors.map((e) => (
            <li key={`${e.code}:${e.detail ?? ""}`}>
              check error: {e.code}
              {e.detail ? ` (${e.detail})` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs" aria-label="Packs">
          <thead>
            <tr className="text-left">
              <th className="border-b p-2">Pack</th>
              <th className="border-b p-2">Binding</th>
              <th className="border-b p-2">Feed target</th>
              <th className="border-b p-2">Floor</th>
              <th className="border-b p-2">Runs</th>
            </tr>
          </thead>
          <tbody>
            {r.packs.map((p) => (
              <SimPackRow key={p.pack} p={p} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SimPackRow({ p }: { p: SimulatedPackDto }) {
  return (
    <tr data-testid={`sim-pack-${p.pack}`}>
      <td className="border-b p-2 align-top font-mono">
        {p.pack}
        {p.declared?.required ? (
          <Badge variant="warning" className="ml-1">
            required
          </Badge>
        ) : null}
      </td>
      <td className="border-b p-2 align-top">
        <div>
          {p.declared ? p.declared.binding : "undeclared"}
          {p.effectiveBinding && p.effectiveBinding !== p.declared?.binding
            ? ` → ${p.effectiveBinding}`
            : ""}
        </div>
        <div className="text-muted-foreground">{p.reason.detail}</div>
      </td>
      <td className="border-b p-2 align-top">
        {releaseText(p.feedTarget)}
        {p.gate ? (
          <div className="text-muted-foreground">
            {p.gate.halted
              ? "halted"
              : p.gate.rollout
                ? `rollout ${p.gate.rollout.bp / 100}%`
                : ""}
            {p.gate.takesTarget
              ? ", takes it"
              : `, falls back to ${releaseText(p.gate.fallback)}`}
          </div>
        ) : null}
        {p.unsatisfied.map((u) => (
          <div key={`${u.reason}:${u.variant}`} className="text-warning">
            unsatisfied: {u.reason} ({u.detail})
          </div>
        ))}
      </td>
      <td className="border-b p-2 align-top">
        {p.floor ? `≥ ${p.floor.minVersion}` : "none"}
      </td>
      <td className="border-b p-2 align-top">
        {releaseText(p.runs)}
        {p.install ? (
          <span className="ml-1 text-muted-foreground">(installs)</span>
        ) : null}
        {p.revoke ? (
          <span className="ml-1 text-destructive">(unmounted)</span>
        ) : null}
        {p.revocations.map((v) => (
          <div key={v.record} className="text-destructive">
            {v.kind === "delegation"
              ? `content-key delegation revoked: ${v.reason}`
              : `${v.version} revoked: ${v.reason}${v.replacement ? "" : " (no replacement)"}`}
          </div>
        ))}
      </td>
    </tr>
  );
}
