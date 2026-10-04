import * as React from "react";
import {
  AlertTriangle,
  Boxes,
  Github,
  KeyRound,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Wrench,
} from "lucide-react";
import { api, type ProductDetail, type RotateKeyResult } from "../api.js";
import { useResource } from "../context.js";
import { r } from "../console/routes.js";
import { navigate } from "../console/router.js";
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  type ColumnDef,
  useToast,
} from "../components/ui/index.js";
import { CreateProductDialog } from "./products/CreateProductDialog.js";
import { EditProductDialog } from "./products/EditProductDialog.js";
import { RotateKeyResultDialog } from "./products/RotateKeyResultDialog.js";
import { SecretDialog } from "./products/SecretDialog.js";
import { errorMessage, formatDate, releaseSourceOf } from "./products/util.js";
import { qk } from "../console/data/queries.js";
import { mutate } from "../console/data/mutations.js";
import { fetchProducts } from "../console/data/hooks.js";

type DialogKind = "edit" | "secret" | null;
type ConfirmKind = "delete" | "rotate" | "resync" | null;

/**
 * Platform product-registry view. Lists every registered product, opens the two-tab create
 * flow (manual / link-repo), and exposes per-product actions: edit, set secret, resync
 * (GitHub-source only), rotate signing key, and delete. Every mutation toasts + invalidates;
 * destructive actions go through a `ConfirmDialog`.
 */
export function Products(): React.ReactElement {
  const toast = useToast();
  const { data, loading, error, reload } = useResource(
    qk.products(),
    fetchProducts,
  );
  const products = data ?? [];

  const [createOpen, setCreateOpen] = React.useState(false);
  const [active, setActive] = React.useState<ProductDetail | null>(null);
  const [dialog, setDialog] = React.useState<DialogKind>(null);
  const [confirm, setConfirm] = React.useState<ConfirmKind>(null);
  const [busy, setBusy] = React.useState(false);
  const [rotated, setRotated] = React.useState<RotateKeyResult | null>(null);

  const open = (
    kind: Exclude<DialogKind, null>,
    product: ProductDetail,
  ): void => {
    setActive(product);
    setDialog(kind);
  };
  const openConfirm = (
    kind: Exclude<ConfirmKind, null>,
    product: ProductDetail,
  ): void => {
    setActive(product);
    setConfirm(kind);
  };

  const runConfirm = async (): Promise<void> => {
    if (!active || !confirm) return;
    setBusy(true);
    try {
      if (confirm === "delete") {
        await mutate("deleteProduct", active.slug, active.slug);
        toast.success("Product disabled", `“${active.slug}” was tombstoned.`);
        reload();
      } else if (confirm === "resync") {
        await mutate("resyncProduct", active.slug);
        toast.success(
          "Resync triggered",
          `“${active.slug}” is syncing from GitHub.`,
        );
        reload();
      } else if (confirm === "rotate") {
        const res = await mutate("rotateProductKey", active.slug);
        toast.success(
          "Key prepared",
          `“${active.slug}” has a staged signing key.`,
        );
        reload();
        setRotated(res);
      }
      setConfirm(null);
    } catch (err) {
      toast.error("Action failed", errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const columns: ColumnDef<ProductDetail>[] = [
    {
      id: "slug",
      header: "Slug",
      accessor: (p) => p.slug,
      sortable: true,
      cell: (p) => <span className="font-mono text-sm">{p.slug}</span>,
    },
    {
      id: "name",
      header: "Name",
      accessor: (p) => p.name,
      sortable: true,
      cell: (p) => (
        <span className="font-medium text-foreground">{p.name}</span>
      ),
    },
    {
      id: "source",
      header: "Release source",
      accessor: (p) => releaseSourceOf(p),
      sortable: true,
      cell: (p) => {
        const source = releaseSourceOf(p);
        return source === "github" ? (
          <Badge variant="primary">
            <Github aria-hidden className="size-3" /> GitHub
          </Badge>
        ) : (
          <Badge variant="outline">
            <Wrench aria-hidden className="size-3" /> Manual
          </Badge>
        );
      },
    },
    {
      id: "createdAt",
      header: "Created",
      accessor: (p) => p.createdAt,
      sortable: true,
      cell: (p) => (
        <span className="text-muted-foreground">{formatDate(p.createdAt)}</span>
      ),
    },
    {
      id: "modifiedAt",
      header: "Modified",
      accessor: (p) => p.modifiedAt,
      sortable: true,
      cell: (p) => (
        <span className="text-muted-foreground">
          {formatDate(p.modifiedAt)}
        </span>
      ),
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      headerClassName: "w-px",
      className: "w-px text-right",
      cell: (p) => (
        <RowActions product={p} open={open} openConfirm={openConfirm} />
      ),
    },
  ];

  return (
    <section className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight">Products</h2>
          <p className="text-sm text-muted-foreground">
            The platform product registry — register products, link release
            repos, and manage signing keys.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus aria-hidden /> New product
        </Button>
      </header>

      {error ? (
        <EmptyState
          icon={<AlertTriangle aria-hidden />}
          title="Couldn’t load products"
          description={error}
          action={
            <Button variant="outline" onClick={reload}>
              <RefreshCw aria-hidden /> Retry
            </Button>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={products}
          rowKey={(p) => p.slug}
          loading={loading && products.length === 0}
          filterable
          filterPlaceholder="Filter products…"
          onRowClick={(p) => navigate(r.overview(p.slug))}
          empty={
            <EmptyState
              icon={<Boxes aria-hidden />}
              title="No products yet"
              description="Register your first product manually or link a GitHub release repository."
              action={
                <Button onClick={() => setCreateOpen(true)}>
                  <Plus aria-hidden /> New product
                </Button>
              }
            />
          }
        />
      )}

      <CreateProductDialog open={createOpen} onOpenChange={setCreateOpen} />

      {active ? (
        <>
          <EditProductDialog
            product={active}
            open={dialog === "edit"}
            onOpenChange={(o) => setDialog(o ? "edit" : null)}
          />
          <SecretDialog
            product={active}
            open={dialog === "secret"}
            onOpenChange={(o) => setDialog(o ? "secret" : null)}
          />
        </>
      ) : null}

      <ConfirmDialog
        open={confirm === "delete"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Disable “${active?.slug ?? ""}”?`}
        description="This tombstones the product, disables its licenses, deauthorizes devices, revokes hot credentials, and preserves audit/runtime history."
        confirmLabel="Disable product"
        loading={busy}
        onConfirm={runConfirm}
      />
      <ConfirmDialog
        open={confirm === "rotate"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Prepare a signing key for “${active?.slug ?? ""}”?`}
        description="A new signing key is minted as staged and published for trust refresh before activation. Existing signatures stay under the current active key."
        confirmLabel="Prepare key"
        confirmVariant="primary"
        loading={busy}
        onConfirm={runConfirm}
      />
      <ConfirmDialog
        open={confirm === "resync"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Resync “${active?.slug ?? ""}” from GitHub?`}
        description="Re-reads the product manifest and releases from the linked repository."
        confirmLabel="Resync"
        confirmVariant="primary"
        loading={busy}
        onConfirm={runConfirm}
      />

      <RotateKeyResultDialog
        slug={active?.slug ?? ""}
        result={rotated}
        onOpenChange={(o) => !o && setRotated(null)}
      />
    </section>
  );
}

/** The per-row action menu. Resync is offered only for GitHub-sourced products. */
function RowActions({
  product,
  open,
  openConfirm,
}: {
  product: ProductDetail;
  open: (kind: "edit" | "secret", product: ProductDetail) => void;
  openConfirm: (
    kind: "delete" | "rotate" | "resync",
    product: ProductDetail,
  ) => void;
}): React.ReactElement {
  const isGithub = releaseSourceOf(product) === "github";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Actions for ${product.slug}`}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuLabel>{product.slug}</DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => open("edit", product)}>
          <Pencil aria-hidden /> Edit
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => open("secret", product)}>
          <Lock aria-hidden /> Set secret
        </DropdownMenuItem>
        {isGithub ? (
          <DropdownMenuItem onSelect={() => openConfirm("resync", product)}>
            <RefreshCw aria-hidden /> Resync from GitHub
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={() => openConfirm("rotate", product)}>
          <KeyRound aria-hidden /> Prepare signing key
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          destructive
          onSelect={() => openConfirm("delete", product)}
        >
          <Trash2 aria-hidden /> Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
