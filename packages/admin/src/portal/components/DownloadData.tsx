import * as React from "react";
import { AlertCircle, Download } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { toast } from "../../ui/toast.js";
import { YOUR_DATA_COPY } from "../copy/yourData.js";
import { portalErrorCopy } from "../errors.js";

/** The request behind a download: `useExportAccountData` or `useExportProductData`. */
export interface DataDownload {
  mutate: (
    variables: void,
    options?: { onSuccess?: () => void; onSettled?: () => void },
  ) => void;
  isPending: boolean;
  error: unknown;
}

/**
 * One **Download my data** control (I-11; S-16 §5.5): what the file holds, the button, the name the
 * browser saves it under, and an inline refusal.
 *
 * - **A press starts it.** Nothing is fetched before: the file is personal data, so no render,
 *   focus or hover asks the Worker for it (it also needs a sign-in from the last five minutes).
 * - **One request at a time.** The button is `loading` (disabled) while it runs.
 * - **The file is named before and after**: under the button, and in the toast that says the
 *   download started (the toast is information, not a celebration).
 * - **A refusal stays on the page** under the button, in the portal's usual words (`401
 *   step_up_required` asks for a recent sign-in, `429` to wait), and pressing again tries again.
 *   The button is disabled while the request runs, so focus returns to it afterwards.
 *
 * `title` and `description` say whose data it is: Account's file is the whole account, a product's
 * is only what that product holds, and the caller words the difference.
 */
export function DownloadData({
  title,
  description,
  label,
  filename,
  download,
}: {
  title: string;
  description: string;
  label: string;
  /** What the browser saves it as. */
  filename: string;
  download: DataDownload;
}): React.ReactElement {
  const button = React.useRef<HTMLButtonElement>(null);
  const hintId = React.useId();
  const failure = download.error ? portalErrorCopy(download.error) : null;
  const start = (): void => {
    if (download.isPending) return;
    download.mutate(undefined, {
      onSuccess: () =>
        toast.success(YOUR_DATA_COPY["yourData.copy.started"], {
          description: filename,
        }),
      // Disabled while it ran, the button lost focus to the page: give it back.
      onSettled: () =>
        requestAnimationFrame(() => {
          const at = document.activeElement;
          if (!at || at === document.body) button.current?.focus();
        }),
    });
  };
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="font-medium text-fg-strong">{title}</p>
        <p className="text-sm text-fg-muted">{description}</p>
      </div>
      <Button
        ref={button}
        variant="outline"
        // A long product name wraps inside the card instead of running past it.
        className="h-auto min-h-9 max-w-full whitespace-normal py-2 text-left"
        iconStart={<Download aria-hidden />}
        loading={download.isPending}
        aria-describedby={hintId}
        onClick={start}
      >
        {label}
      </Button>
      {failure ? (
        <p role="alert" className="flex gap-2 text-sm text-danger">
          <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            {failure.title}. {failure.description}
          </span>
        </p>
      ) : null}
      <p id={hintId} className="text-xs text-fg-muted">
        Saved as {filename}. {YOUR_DATA_COPY["yourData.copy.private"]}
      </p>
    </div>
  );
}
