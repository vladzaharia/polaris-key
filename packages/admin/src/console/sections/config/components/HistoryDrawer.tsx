import * as React from "react";
import type { ConfigEntry, ProductCatalog } from "../../../../api.js";
import { fromSeconds } from "../../../../lib/format.js";
import { Button } from "../../../../ui/Button.js";
import { DiffViewer } from "../../../../ui/DiffViewer.js";
import { Drawer, DrawerBody } from "../../../../ui/Drawer.js";
import { ErrorState } from "../../../../ui/ErrorState.js";
import { SourceBadge } from "../../../../ui/SourceBadge.js";
import { StatusPill } from "../../../../ui/StatusPill.js";
import { Timestamp } from "../../../../ui/Timestamp.js";
import { codecs, useSearchParam } from "../../../router.js";
import { entryFieldView } from "../model/diffView.js";
import {
  CATALOG_PATH,
  useCatalogVersion,
  useCatalogVersions,
} from "../data.js";

const VERSION = codecs.int(0);

// ── version history (A-6) ──────────────────────────────────────────────────────────────────────

export function HistoryDrawer({
  slug,
  open,
  active,
  onClose,
}: {
  slug: string;
  open: boolean;
  active: ProductCatalog;
  onClose: () => void;
}): React.ReactElement {
  const versions = useCatalogVersions(slug, open);
  const [compare, setCompare] = useSearchParam("version", VERSION);
  const selected =
    compare > 0 && compare !== active.schemaVersion ? compare : null;
  const other = useCatalogVersion(slug, selected);
  return (
    <Drawer
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setCompare(0);
          onClose();
        }
      }}
      size="lg"
      title="Version history"
    >
      <DrawerBody>
        <div className="space-y-6">
          {versions.isPending ? (
            <p className="text-sm text-fg-muted">Loading versions…</p>
          ) : versions.error ? (
            <ErrorState
              compact
              error={versions.error}
              onRetry={() => void versions.refetch()}
            />
          ) : (
            <ol className="divide-y divide-border rounded-md border border-border">
              {versions.data!.versions.map((v) => (
                <li
                  key={v.version}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-2 text-sm"
                >
                  <span className="min-w-0 space-y-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-medium text-fg-strong">
                        v{v.version}
                      </span>
                      {v.active ? (
                        <StatusPill tone="success" size="sm">
                          Active
                        </StatusPill>
                      ) : null}
                      <SourceBadge source={v.source} path={CATALOG_PATH} />
                    </span>
                    <span
                      className="block truncate text-xs text-fg-muted"
                      title={v.publishedBy ?? undefined}
                    >
                      {v.entryCount} {v.entryCount === 1 ? "key" : "keys"} ·{" "}
                      <Timestamp at={fromSeconds(v.createdAt)} />
                      {v.publishedBy ? ` · ${v.publishedBy}` : ""}
                    </span>
                  </span>
                  {v.active ? null : (
                    <Button
                      size="sm"
                      variant="outline"
                      aria-pressed={selected === v.version}
                      className="aria-pressed:border-accent aria-pressed:bg-accent-subtle"
                      onClick={() => setCompare(v.version)}
                    >
                      {selected === v.version
                        ? "Comparing"
                        : "Compare with active"}
                    </Button>
                  )}
                </li>
              ))}
            </ol>
          )}
          {selected !== null ? (
            <section
              className="space-y-2"
              aria-label={`Changes from v${selected} to v${active.schemaVersion}`}
            >
              <h3 className="text-sm font-semibold text-fg-strong">
                v{selected} → v{active.schemaVersion}
              </h3>
              {other.isPending ? (
                <p className="text-sm text-fg-muted">Loading v{selected}…</p>
              ) : other.error ? (
                <ErrorState
                  compact
                  error={other.error}
                  onRetry={() => void other.refetch()}
                  context={{ thing: `Version ${selected}` }}
                />
              ) : (
                <DiffViewer<ConfigEntry>
                  mode="structured"
                  before={other.data!.entries}
                  after={active.entries}
                  entryKey="key"
                  fieldView={entryFieldView}
                />
              )}
            </section>
          ) : null}
        </div>
      </DrawerBody>
    </Drawer>
  );
}
