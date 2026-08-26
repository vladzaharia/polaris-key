import * as React from "react";
import {
  Download,
  KeyRound,
  LogOut,
  MonitorX,
  Plus,
  ShieldCheck,
  User,
} from "lucide-react";
import { ThemeProvider } from "../components/theme.js";
import { Logo, LogoMark } from "../components/brand/Logo.js";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  DataTable,
  EmptyState,
  Field,
  Input,
  Skeleton,
  Toaster,
  useToast,
  type ColumnDef,
} from "../components/ui/index.js";
import {
  portalApi,
  PortalApiError,
  setPortalCsrf,
  type PortalAccount,
  type PortalArtifact,
  type PortalCapabilities,
  type PortalDevice,
  type PortalLicenseDetail,
  type PortalLicenseSummary,
  type PortalRelease,
} from "./api.js";
import { formatBytes, formatDate, formatStamp } from "./format.js";

type Route =
  | { kind: "dashboard" }
  | { kind: "licenses" }
  | { kind: "license"; product: string; id: string }
  | { kind: "downloads" }
  | { kind: "profile" };

function parseRoute(): Route {
  const hash = window.location.hash || "#/";
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "licenses" && parts[1] && parts[2]) {
    return {
      kind: "license",
      product: decodeURIComponent(parts[1]),
      id: decodeURIComponent(parts[2]),
    };
  }
  if (parts[0] === "licenses") return { kind: "licenses" };
  if (parts[0] === "downloads") return { kind: "downloads" };
  if (parts[0] === "profile") return { kind: "profile" };
  return { kind: "dashboard" };
}

function licenseHref(license: PortalLicenseSummary): string {
  return `#/licenses/${encodeURIComponent(license.product)}/${encodeURIComponent(license.id)}`;
}

export function PortalApp(): React.ReactElement {
  return (
    <ThemeProvider>
      <Toaster>
        <Boot />
      </Toaster>
    </ThemeProvider>
  );
}

function Boot(): React.ReactElement {
  const [account, setAccount] = React.useState<PortalAccount | null>(null);
  const [authChecked, setAuthChecked] = React.useState(false);
  const [capabilities, setCapabilities] =
    React.useState<PortalCapabilities | null>(null);
  const [route, setRoute] = React.useState<Route>(parseRoute);

  React.useEffect(() => {
    const onHash = (): void => setRoute(parseRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const refreshMe = React.useCallback(async () => {
    try {
      const me = await portalApi.me();
      setPortalCsrf(me.csrf);
      setAccount(me.account);
    } catch (err) {
      if (err instanceof PortalApiError && err.status === 401) {
        setAccount(null);
      }
    } finally {
      setAuthChecked(true);
    }
  }, []);

  React.useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  React.useEffect(() => {
    portalApi
      .capabilities()
      .then(setCapabilities)
      .catch(() =>
        setCapabilities({
          auth: { oidc: false, magic: false },
          modules: { licensing: false, claim: false, releases: false },
        }),
      );
  }, []);

  if (!authChecked) {
    return (
      <RootFrame>
        <div className="flex min-h-screen items-center justify-center">
          <div className="flex items-center gap-3 text-muted-foreground">
            <Skeleton className="size-5 rounded-full" />
            Loading portal…
          </div>
        </div>
      </RootFrame>
    );
  }

  if (!account) {
    return (
      <RootFrame>
        <SignIn capabilities={capabilities} onSignedIn={refreshMe} />
      </RootFrame>
    );
  }

  return (
    <RootFrame>
      <Shell account={account} capabilities={capabilities} route={route}>
        {route.kind === "dashboard" ? (
          <Dashboard capabilities={capabilities} />
        ) : null}
        {route.kind === "licenses" ? <Licenses /> : null}
        {route.kind === "license" ? (
          <LicenseDetail product={route.product} id={route.id} />
        ) : null}
        {route.kind === "downloads" ? (
          capabilities == null ? (
            <Skeleton className="h-40 w-full" />
          ) : capabilities.modules.releases ? (
            <Downloads />
          ) : (
            <EmptyState
              icon={<Download aria-hidden />}
              title="Downloads are unavailable"
              description="Release downloads are not enabled for the currently linked products."
            />
          )
        ) : null}
        {route.kind === "profile" ? <Profile account={account} /> : null}
      </Shell>
    </RootFrame>
  );
}

function RootFrame({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="min-h-screen bg-background text-foreground">{children}</div>
  );
}

function SignIn({
  capabilities,
  onSignedIn,
}: {
  capabilities: PortalCapabilities | null;
  onSignedIn: () => void;
}): React.ReactElement {
  const toast = useToast();
  const [email, setEmail] = React.useState("");
  const [sent, setSent] = React.useState(false);
  const [sending, setSending] = React.useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setSending(true);
    try {
      await portalApi.startMagic(email);
      setSent(true);
      toast.success(
        "Magic link sent",
        "Check your email to finish signing in.",
      );
    } catch (err) {
      toast.error(
        "Could not send link",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setSending(false);
    }
  };

  const loadingCapabilities = capabilities == null;
  const oidcEnabled = capabilities?.auth.oidc === true;
  const magicEnabled = capabilities?.auth.magic === true;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col justify-center px-4">
      <div className="mb-8 flex justify-center">
        <Logo subtitle="portal" />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>
            Access licenses, devices, and downloads across your Polaris
            products.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {loadingCapabilities ? (
            <div className="space-y-3" aria-hidden>
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : null}
          {oidcEnabled ? (
            <Button asChild className="w-full">
              <a
                href={`/login?return_to=${encodeURIComponent(window.location.href)}`}
              >
                <ShieldCheck aria-hidden />
                Continue with OIDC
              </a>
            </Button>
          ) : null}
          {magicEnabled ? (
            <form onSubmit={submit} className="space-y-3">
              <Field label="Email">
                <Input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="email"
                  placeholder="you@example.com"
                />
              </Field>
              <Button
                type="submit"
                variant="outline"
                className="w-full"
                loading={sending}
              >
                Send magic link
              </Button>
            </form>
          ) : null}
          {!loadingCapabilities && !oidcEnabled && !magicEnabled ? (
            <EmptyState
              icon={<ShieldCheck aria-hidden />}
              title="Portal sign-in is unavailable"
              description="No customer portal sign-in method is currently enabled."
            />
          ) : null}
          {sent ? (
            <p className="text-sm text-muted-foreground">
              The link expires in 10 minutes. This tab will update after you use
              it.
            </p>
          ) : null}
          <Button variant="ghost" className="w-full" onClick={onSignedIn}>
            Refresh session
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

function Shell({
  account,
  capabilities,
  route,
  children,
}: {
  account: PortalAccount;
  capabilities: PortalCapabilities | null;
  route: Route;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-4 px-4 sm:px-6">
          <a href="#/" className="flex items-center gap-2 rounded-sm">
            <LogoMark className="size-5" />
            <span className="font-semibold">Polaris Key</span>
          </a>
          <nav className="flex items-center gap-1 text-sm">
            <TopLink
              href="#/"
              active={route.kind === "dashboard"}
              label="Home"
            />
            <TopLink
              href="#/licenses"
              active={route.kind === "licenses" || route.kind === "license"}
              label="Licenses"
            />
            {capabilities?.modules.releases === true ? (
              <TopLink
                href="#/downloads"
                active={route.kind === "downloads"}
                label="Downloads"
              />
            ) : null}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <a href="#/profile">
                <User aria-hidden />
                <span className="hidden sm:inline">{account.name}</span>
              </a>
            </Button>
            {/* R1-03: sign-out is a state change, so it is a form POST rather than a link.
                `GET /logout` is still accepted for a same-origin navigation, but that is a
                compatibility bridge — POST is the shape that cannot be driven cross-site by
                an `<img>` or a cross-site link. */}
            <form method="post" action="/logout">
              <Button
                type="submit"
                variant="ghost"
                size="icon"
                aria-label="Sign out"
              >
                <LogOut aria-hidden />
              </Button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
        {children}
      </main>
    </div>
  );
}

function TopLink({
  href,
  active,
  label,
}: {
  href: string;
  active: boolean;
  label: string;
}): React.ReactElement {
  return (
    <a
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "rounded-md bg-muted px-3 py-1.5 text-foreground"
          : "rounded-md px-3 py-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
      }
    >
      {label}
    </a>
  );
}

function Dashboard({
  capabilities,
}: {
  capabilities: PortalCapabilities | null;
}): React.ReactElement {
  const { licenses, loading, reload } = useLicenses();
  const active = licenses.filter((l) => l.usable).length;
  const devices = licenses.reduce((sum, l) => sum + l.deviceCount, 0);
  const products = new Set(licenses.map((l) => l.product)).size;

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          Licensing portal
        </h1>
        <p className="text-sm text-muted-foreground">
          Your licenses, devices, and downloads across Polaris products.
        </p>
      </header>
      <div className="grid gap-4 md:grid-cols-3">
        <Stat title="Active licenses" value={loading ? "…" : String(active)} />
        <Stat title="Products" value={loading ? "…" : String(products)} />
        <Stat
          title="Authorized devices"
          value={loading ? "…" : String(devices)}
        />
      </div>
      {capabilities?.modules.claim === true ? (
        <ClaimCard onClaimed={reload} />
      ) : null}
      <RecentLicenses licenses={licenses.slice(0, 5)} loading={loading} />
    </section>
  );
}

function Stat({
  title,
  value,
}: {
  title: string;
  value: string;
}): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle className="text-3xl">{value}</CardTitle>
      </CardHeader>
    </Card>
  );
}

function ClaimCard({
  onClaimed,
}: {
  onClaimed: () => void;
}): React.ReactElement {
  const toast = useToast();
  const [key, setKey] = React.useState("");
  const [claiming, setClaiming] = React.useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setClaiming(true);
    try {
      await portalApi.claimKey(key);
      setKey("");
      toast.success("License added");
      onClaimed();
    } catch (err) {
      toast.error(
        "Could not add license",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setClaiming(false);
    }
  };

  return (
    <Card>
      <form onSubmit={submit}>
        <CardHeader>
          <CardTitle>Add a license</CardTitle>
          <CardDescription>
            Enter an existing license key to add it to this account. The key
            itself is not stored in the browser.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 sm:flex-row">
          <Field label="License key" className="flex-1">
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="pkey_product_..."
              autoComplete="off"
            />
          </Field>
          <Button
            type="submit"
            className="sm:self-end"
            loading={claiming}
            disabled={!key.trim()}
          >
            <Plus aria-hidden />
            Add
          </Button>
        </CardContent>
      </form>
    </Card>
  );
}

function useLicenses(): {
  licenses: PortalLicenseSummary[];
  loading: boolean;
  error: string | null;
  reload: () => void;
} {
  const [licenses, setLicenses] = React.useState<PortalLicenseSummary[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const load = React.useCallback(() => {
    setLoading(true);
    setError(null);
    portalApi
      .licenses()
      .then((res) => setLicenses(res.licenses))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Request failed."),
      )
      .finally(() => setLoading(false));
  }, []);
  React.useEffect(load, [load]);
  return { licenses, loading, error, reload: load };
}

function RecentLicenses({
  licenses,
  loading,
}: {
  licenses: PortalLicenseSummary[];
  loading: boolean;
}): React.ReactElement {
  if (loading) return <Skeleton className="h-32 w-full" />;
  if (licenses.length === 0) {
    return (
      <EmptyState
        icon={<KeyRound aria-hidden />}
        title="No licenses linked"
        description="Sign in with OIDC, use a verified email, or add a license key."
      />
    );
  }
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">Recent licenses</h2>
      <LicenseGrid licenses={licenses} />
    </section>
  );
}

function Licenses(): React.ReactElement {
  const { licenses, loading, error, reload } = useLicenses();
  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Licenses</h1>
          <p className="text-sm text-muted-foreground">
            All licenses currently linked to this account.
          </p>
        </div>
        <Button variant="outline" onClick={reload}>
          Refresh
        </Button>
      </header>
      {error ? (
        <EmptyState title="Could not load licenses" description={error} />
      ) : loading ? (
        <Skeleton className="h-40 w-full" />
      ) : licenses.length ? (
        <LicenseGroups licenses={licenses} />
      ) : (
        <EmptyState title="No licenses linked" />
      )}
    </section>
  );
}

function LicenseGroups({
  licenses,
}: {
  licenses: PortalLicenseSummary[];
}): React.ReactElement {
  const groups = new Map<string, PortalLicenseSummary[]>();
  for (const license of licenses) {
    const key = `${license.productName}__${license.product}`;
    groups.set(key, [...(groups.get(key) ?? []), license]);
  }

  return (
    <div className="space-y-6">
      {[...groups.entries()].map(([key, rows]) => {
        const first = rows[0]!;
        return (
          <section key={key} className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-lg font-semibold">{first.productName}</h2>
                <p className="font-mono text-xs text-muted-foreground">
                  {first.product}
                </p>
              </div>
              <Badge variant="outline">
                {rows.length} {rows.length === 1 ? "license" : "licenses"}
              </Badge>
            </div>
            <LicenseGrid licenses={rows} />
          </section>
        );
      })}
    </div>
  );
}

function LicenseGrid({
  licenses,
}: {
  licenses: PortalLicenseSummary[];
}): React.ReactElement {
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {licenses.map((license) => (
        <a key={`${license.product}:${license.id}`} href={licenseHref(license)}>
          <Card className="h-full transition-colors hover:bg-muted/30">
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <CardTitle>{license.productName}</CardTitle>
                  <CardDescription>
                    {license.name || license.email || license.id}
                  </CardDescription>
                </div>
                <LicenseBadge license={license} />
              </div>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Meta label="Tier" value={license.tier ?? "—"} />
              <Meta label="Expires" value={formatDate(license.expiresAt)} />
              <Meta label="Devices" value={String(license.deviceCount)} />
              {license.entitlements.length ? (
                <div className="flex flex-wrap gap-1.5">
                  {license.entitlements.slice(0, 4).map((entry) => (
                    <Badge key={entry.key} variant="outline">
                      {entry.label}
                    </Badge>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>
        </a>
      ))}
    </div>
  );
}

function LicenseBadge({
  license,
}: {
  license: PortalLicenseSummary;
}): React.ReactElement {
  if (!license.usable) return <Badge variant="warning">Needs attention</Badge>;
  if (license.status !== "active")
    return <Badge variant="default">{license.status}</Badge>;
  return <Badge variant="success">Active</Badge>;
}

function Meta({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.ReactElement {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}

function LicenseDetail({
  product,
  id,
}: {
  product: string;
  id: string;
}): React.ReactElement {
  const [license, setLicense] = React.useState<PortalLicenseDetail | null>(
    null,
  );
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    setLoading(true);
    setError(null);
    portalApi
      .license(product, id)
      .then(setLicense)
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Request failed."),
      )
      .finally(() => setLoading(false));
  }, [product, id]);

  React.useEffect(load, [load]);

  if (loading) return <Skeleton className="h-64 w-full" />;
  if (error || !license) {
    return (
      <EmptyState
        title="Could not load license"
        description={error ?? undefined}
      />
    );
  }

  return (
    <section className="space-y-6">
      <a
        href="#/licenses"
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        Back to licenses
      </a>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {license.productName}
          </h1>
          <p className="text-sm text-muted-foreground">
            {license.email || license.id}
          </p>
        </div>
        <LicenseBadge license={license} />
      </header>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Tier</CardDescription>
            <CardTitle>{license.tier ?? "—"}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Expires</CardDescription>
            <CardTitle>{formatDate(license.expiresAt)}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Devices</CardDescription>
            <CardTitle>{license.deviceCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Keys</CardDescription>
            <CardTitle>
              {license.activeKeyCount} / {license.keyCount}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>
      <Entitlements license={license} />
      <Keys keys={license.keys} />
      <Devices license={license} onChanged={load} />
    </section>
  );
}

function Entitlements({
  license,
}: {
  license: PortalLicenseDetail;
}): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Included</CardTitle>
        <CardDescription>
          Capabilities and release policy included with this license.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        {license.entitlements.length ? (
          license.entitlements.map((entry) => (
            <Badge key={entry.key} variant="outline">
              {entry.label}
            </Badge>
          ))
        ) : (
          <span className="text-sm text-muted-foreground">
            No user-facing entitlements declared.
          </span>
        )}
      </CardContent>
    </Card>
  );
}

function Keys({
  keys,
}: {
  keys: PortalLicenseDetail["keys"];
}): React.ReactElement {
  const columns: ColumnDef<PortalLicenseDetail["keys"][number]>[] = [
    {
      id: "label",
      header: "Label",
      cell: (k) => k.label ?? "—",
      accessor: (k) => k.label ?? "",
    },
    {
      id: "status",
      header: "Status",
      cell: (k) => (
        <Badge variant={k.status === "active" ? "success" : "default"}>
          {k.status}
        </Badge>
      ),
      accessor: (k) => k.status,
    },
    {
      id: "created",
      header: "Created",
      cell: (k) => formatStamp(k.createdAt),
      accessor: (k) => k.createdAt,
      sortable: true,
    },
    {
      id: "used",
      header: "Last used",
      cell: (k) => formatStamp(k.lastUsedAt),
      accessor: (k) => k.lastUsedAt ?? 0,
      sortable: true,
    },
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Keys</CardTitle>
        <CardDescription>
          Active key records are visible, but raw keys cannot be recovered.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable columns={columns} rows={keys} rowKey={(k) => k.hash} />
      </CardContent>
    </Card>
  );
}

function Devices({
  license,
  onChanged,
}: {
  license: PortalLicenseDetail;
  onChanged: () => void;
}): React.ReactElement {
  const toast = useToast();
  const [target, setTarget] = React.useState<PortalDevice | null>(null);
  const [working, setWorking] = React.useState(false);
  const columns: ColumnDef<PortalDevice>[] = [
    {
      id: "device",
      header: "Device",
      cell: (d) => (
        <span className="font-mono text-xs">{d.label ?? d.deviceId}</span>
      ),
      accessor: (d) => d.label ?? d.deviceId,
    },
    {
      id: "status",
      header: "Status",
      cell: (d) => (
        <Badge variant={d.status === "authorized" ? "success" : "default"}>
          {d.status}
        </Badge>
      ),
      accessor: (d) => d.status,
    },
    {
      id: "version",
      header: "Version",
      cell: (d) => d.appVersion ?? "—",
      accessor: (d) => d.appVersion ?? "",
    },
    {
      id: "lastSeen",
      header: "Last seen",
      cell: (d) => formatStamp(d.lastSeen),
      accessor: (d) => d.lastSeen,
      sortable: true,
    },
    {
      id: "actions",
      header: "",
      cell: (d) =>
        d.status === "authorized" ? (
          <Button variant="outline" size="sm" onClick={() => setTarget(d)}>
            <MonitorX aria-hidden />
            Disconnect
          </Button>
        ) : null,
    },
  ];

  const confirm = async (): Promise<void> => {
    if (!target) return;
    setWorking(true);
    try {
      await portalApi.disconnectDevice(
        license.product,
        license.id,
        target.deviceId,
      );
      toast.success("Device disconnected");
      setTarget(null);
      onChanged();
    } catch (err) {
      toast.error(
        "Could not disconnect device",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setWorking(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Devices</CardTitle>
        <CardDescription>
          Disconnect devices that should no longer use this license.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable
          columns={columns}
          rows={license.devices}
          rowKey={(d) => d.deviceId}
        />
      </CardContent>
      <ConfirmDialog
        open={target != null}
        onOpenChange={(open) => !open && setTarget(null)}
        title="Disconnect this device?"
        description={target?.label ?? target?.deviceId}
        confirmLabel="Disconnect"
        confirmVariant="destructive"
        loading={working}
        onConfirm={confirm}
      />
    </Card>
  );
}

function Downloads(): React.ReactElement {
  const toast = useToast();
  const [releases, setReleases] = React.useState<PortalRelease[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    portalApi
      .releases()
      .then((res) => setReleases(res.releases))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Request failed."),
      )
      .finally(() => setLoading(false));
  }, []);

  const download = async (
    release: PortalRelease,
    artifact: PortalArtifact,
  ): Promise<void> => {
    try {
      const res = await portalApi.downloadToken(
        release.product,
        release.releaseId,
        artifact.artifactId,
      );
      window.location.href = res.url;
    } catch (err) {
      toast.error(
        "Could not start download",
        err instanceof Error ? err.message : undefined,
      );
    }
  };

  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Downloads</h1>
        <p className="text-sm text-muted-foreground">
          Entitled releases and artifacts.
        </p>
      </header>
      {loading ? (
        <Skeleton className="h-40 w-full" />
      ) : error ? (
        <EmptyState title="Could not load downloads" description={error} />
      ) : releases.length === 0 ? (
        <EmptyState
          icon={<Download aria-hidden />}
          title="No downloads available"
        />
      ) : (
        <div className="space-y-4">
          {releases.map((release) => (
            <Card key={`${release.product}:${release.releaseId}`}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle>
                      {release.productName} {release.version}
                    </CardTitle>
                    <CardDescription>
                      {release.title ?? formatDate(release.publishedAt)}
                    </CardDescription>
                  </div>
                  <Badge variant="outline">{release.product}</Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {release.artifacts.map((artifact) => (
                  <div
                    key={artifact.artifactId}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border p-3"
                  >
                    <div>
                      <p className="font-medium">{artifact.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {[
                          artifact.kind,
                          artifact.platform,
                          artifact.arch,
                          formatBytes(artifact.sizeBytes),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={!artifact.canDownload}
                      title={
                        artifact.canDownload
                          ? undefined
                          : artifact.access === "licensed"
                            ? "A usable license is required for this artifact."
                            : "This artifact is not available for download."
                      }
                      onClick={() => void download(release, artifact)}
                    >
                      <Download aria-hidden />
                      {artifact.canDownload
                        ? "Download"
                        : artifact.access === "licensed"
                          ? "License required"
                          : "Unavailable"}
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}

function Profile({ account }: { account: PortalAccount }): React.ReactElement {
  return (
    <section className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
        <p className="text-sm text-muted-foreground">
          Account details for this portal session.
        </p>
      </header>
      <Card>
        <CardHeader>
          <CardTitle>{account.name}</CardTitle>
          <CardDescription>{account.email || account.id}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Meta label="Account id" value={account.id} />
          <Meta label="Email" value={account.email || "—"} />
        </CardContent>
      </Card>
    </section>
  );
}
