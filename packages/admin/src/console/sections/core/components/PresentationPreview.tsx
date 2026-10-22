import * as React from "react";
import { Eye, Moon, Sun } from "lucide-react";
import type { ProductPresentation } from "../../../../api.js";
import { cn } from "../../../../lib/cn.js";
import { Unlocked } from "../../../../ui/WriteLock.js";
import { Button } from "../../../../ui/Button.js";
import { Drawer, DrawerBody } from "../../../../ui/Drawer.js";
import { ProductLogo } from "../../../../ui/ProductLogo.js";
import { SegmentedControl } from "../../../../ui/SegmentedControl.js";
import { StatusPill } from "../../../../ui/StatusPill.js";

type PreviewTheme = "dark" | "light";

const THEMES = [
  {
    value: "dark",
    label: (
      <span className="inline-flex items-center gap-1.5">
        <Moon aria-hidden className="size-3.5" />
        Dark
      </span>
    ),
  },
  {
    value: "light",
    label: (
      <span className="inline-flex items-center gap-1.5">
        <Sun aria-hidden className="size-3.5" />
        Light
      </span>
    ),
  },
] as const;

/** The art as customers get it: the hosted image, else the flat tint field (never a gradient). */
function Art({ src }: { src: string | null }): React.ReactElement {
  return src ? (
    <img
      src={src}
      alt=""
      crossOrigin="anonymous"
      className="aspect-[16/9] w-full object-cover"
    />
  ) : (
    <div aria-hidden className="aspect-[16/9] w-full bg-surface-sunken" />
  );
}

function Frame({
  caption,
  children,
}: {
  caption: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <figure className="space-y-2">
      <figcaption className="text-xs text-fg-muted">{caption}</figcaption>
      <div className="overflow-hidden rounded-lg border border-border bg-surface-raised">
        {children}
      </div>
    </figure>
  );
}

/**
 * The three customer surfaces as miniatures at their real proportions: the sign-in card, the
 * Library tile and the Discover card, drawn in the theme the switch names whatever the
 * console's own (a `data-theme` on the body re-points every token). Sample data: the name and
 * the line under it are stand-ins; the icon and the art are the product's own, never recoloured.
 * Built from the console's own parts, because the console never imports the portal's.
 */
function PreviewBody({
  name,
  presentation,
  heroUrl,
  theme,
}: {
  name: string;
  presentation: ProductPresentation | undefined;
  heroUrl: string | null;
  theme: PreviewTheme;
}): React.ReactElement {
  return (
    <div
      data-theme={theme}
      className="grid gap-4 rounded-md bg-surface-page p-4 text-fg lg:grid-cols-3 xl:grid-cols-1 [&>*]:min-w-0"
    >
      <Frame caption="Sign-in card">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <ProductLogo name={name} presentation={presentation} size={24} />
          <span className="min-w-0 text-sm [overflow-wrap:anywhere]">
            <strong className="font-semibold text-fg-strong">{name}</strong>{" "}
            wants you to sign in
          </span>
        </div>
        <div className="space-y-2 p-3">
          <strong className="block text-sm font-semibold text-fg-strong">
            Sign in
          </strong>
          <span
            aria-hidden
            className="block h-6 rounded-md border border-border-strong bg-surface-sunken"
          />
          <span
            aria-hidden
            className="grid h-6 place-items-center rounded-md bg-fg-strong text-xs font-medium text-surface-page"
          >
            Continue
          </span>
        </div>
      </Frame>
      <Frame caption="Library tile">
        <Art src={heroUrl} />
        <div className="flex items-center gap-2 px-3 py-2">
          <ProductLogo name={name} presentation={presentation} size={24} />
          <strong className="min-w-0 flex-1 truncate text-sm font-semibold text-fg-strong">
            {name}
          </strong>
          <StatusPill tone="neutral" icon={false} size="sm">
            Studio
          </StatusPill>
        </div>
      </Frame>
      <Frame caption="Discover card">
        <Art src={heroUrl} />
        <div className="flex items-start gap-2 px-3 py-2">
          <ProductLogo name={name} presentation={presentation} size={24} />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-fg-strong">
              {name}
            </p>
            <p className="text-xs text-fg-muted">A short description</p>
          </div>
        </div>
      </Frame>
    </div>
  );
}

/**
 * The live preview: a card beside the rows from 1280 px (sticky), under them below, and on a
 * phone one Preview button that opens it as a sheet.
 */
export function PresentationPreview({
  name,
  presentation,
  heroUrl,
}: {
  name: string;
  presentation: ProductPresentation | undefined;
  heroUrl: string | null;
}): React.ReactElement {
  const [theme, setTheme] = React.useState<PreviewTheme>("dark");
  const [open, setOpen] = React.useState(false);
  const controls = (
    <Unlocked>
      <SegmentedControl
        size="sm"
        aria-label="Preview theme"
        options={THEMES}
        value={theme}
        onChange={setTheme}
      />
    </Unlocked>
  );
  const body = (
    <PreviewBody
      name={name}
      presentation={presentation}
      heroUrl={heroUrl}
      theme={theme}
    />
  );
  return (
    <>
      <section
        aria-labelledby="preview-title"
        className={cn(
          "overflow-hidden rounded-lg border border-border bg-surface-raised max-sm:hidden",
          "xl:sticky xl:top-4 xl:self-start",
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div className="flex items-baseline gap-2">
            <h2
              id="preview-title"
              className="text-lg font-medium text-fg-strong"
            >
              Preview
            </h2>
            <StatusPill tone="neutral" size="sm">
              Sample data
            </StatusPill>
          </div>
          {controls}
        </div>
        <div className="p-4">{body}</div>
      </section>
      <Unlocked>
        <Button
          variant="outline"
          className="w-full sm:hidden"
          iconStart={<Eye aria-hidden />}
          onClick={() => setOpen(true)}
        >
          Preview
        </Button>
      </Unlocked>
      <Drawer
        open={open}
        onOpenChange={setOpen}
        title="Preview"
        description="Sample data. Your icon and art are shown as they are."
      >
        <DrawerBody className="space-y-4">
          {controls}
          {body}
        </DrawerBody>
      </Drawer>
    </>
  );
}
