import * as React from "react";
import { AlertCircle, ArrowLeft, RefreshCw } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { CopyButton } from "../../ui/CopyButton.js";
import { t } from "../../lib/copy.js";
import { href } from "../router.js";

/**
 * The Locker's error boundary (PORTAL.md §6.4): a page that throws while rendering (one malformed
 * API field) takes down only its own outlet, never the header, Help or sign-out. It says that
 * something didn't load, offers Try again and the way back to the Library, and keeps Copy details
 * for a bug report. `resetKey` is the route: navigating away clears the failure.
 */
export class PortalErrorBoundary extends React.Component<
  { children: React.ReactNode; resetKey: string },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidUpdate(prev: { resetKey: string }): void {
    if (this.state.error && prev.resetKey !== this.props.resetKey)
      this.setState({ error: null });
  }

  override render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        role="alert"
        className="flex max-w-xl flex-col items-start gap-3 rounded-xl border border-border bg-surface-raised p-6"
      >
        <AlertCircle aria-hidden className="size-6 text-danger" />
        <h1 className="text-lg font-semibold text-fg-strong">
          {t("locker.error.page.title")}
        </h1>
        <p className="text-fg-muted">{t("locker.error.page.body")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            iconStart={<RefreshCw aria-hidden />}
            onClick={() => this.setState({ error: null })}
          >
            {t("signin.retry")}
          </Button>
          <Button variant="ghost" asChild>
            <a href={href.library()}>
              <ArrowLeft aria-hidden />
              {t("locker.discover.empty.back")}
            </a>
          </Button>
          <CopyButton
            value={`${error.name}: ${error.message}`}
            label="Copy details"
            showLabel
            size="md"
            text="Copy details"
          />
        </div>
      </div>
    );
  }
}
