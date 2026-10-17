import * as React from "react";
import { t } from "../../lib/copy.js";
import { AlertCircle, Download, FileDown } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { toast } from "../../ui/toast.js";
import { YOUR_DATA_COPY } from "../copy/yourData.js";
import { isStepUpRequired, portalErrorCopy } from "../errors.js";
import { StepUpInline } from "./account/StepUpInline.js";
import { DataRow } from "./DataRow.js";

/** The request behind a download: `useExportAccountData` or `useExportProductData`. */
export interface DataDownload {
  mutate: (
    variables: void,
    options?: {
      onSuccess?: () => void;
      onError?: (err: unknown) => void;
      onSettled?: () => void;
    },
  ) => void;
  isPending: boolean;
  error: unknown;
}

/**
 * One **Download my data** row (I-11; S-16 §5.5): what the file holds, the button and an inline
 * refusal.
 *
 * - **A press starts it.** Nothing is fetched before: the file is personal data, so no render,
 *   focus or hover asks the Worker for it (it also needs a sign-in from the last five minutes).
 * - **One request at a time.** The button is `loading` (disabled) while it runs.
 * - **A stale sign-in** shows "Confirm it's you first" in place of the refusal, and confirming
 *   runs the download again.
 * - **Any other refusal stays on the page** under the row, in the portal's usual words (`429` to
 *   wait), and pressing again tries again. The button is disabled while the request runs, so focus
 *   returns to it afterwards.
 * - **The toast** says the download started and that the file is private.
 *
 * `title` and `description` say whose data it is: Account's file is the whole account, a product's
 * is only what that product holds, and the caller words the difference.
 */
export function DownloadData({
  title,
  description,
  label,
  download,
}: {
  title: string;
  description: string;
  /** The button's accessible name; its text is "Download". */
  label: string;
  download: DataDownload;
}): React.ReactElement {
  const button = React.useRef<HTMLButtonElement>(null);
  // A stale sign-in: the prompt takes the refusal's place, and confirming runs the download again.
  const [askFirst, setAskFirst] = React.useState(false);
  const failure =
    download.error && !isStepUpRequired(download.error)
      ? portalErrorCopy(download.error)
      : null;
  const start = (): void => {
    if (download.isPending) return;
    download.mutate(undefined, {
      onError: (err) => {
        if (isStepUpRequired(err)) setAskFirst(true);
      },
      onSuccess: () =>
        toast.success(YOUR_DATA_COPY["yourData.copy.started"], {
          description: YOUR_DATA_COPY["yourData.copy.private"],
        }),
      // Disabled while it ran, the button lost focus to the page: give it back.
      onSettled: () =>
        requestAnimationFrame(() => {
          const at = document.activeElement;
          if (!at || at === document.body || at.tagName === "MAIN")
            button.current?.focus();
        }),
    });
  };
  return (
    <DataRow
      icon={<FileDown aria-hidden />}
      title={title}
      description={description}
      below={
        <>
          {askFirst ? (
            <StepUpInline
              verb="download your data"
              onConfirmed={() => {
                setAskFirst(false);
                start();
              }}
              onCancel={() => {
                setAskFirst(false);
                requestAnimationFrame(() => button.current?.focus());
              }}
            />
          ) : null}
          {failure ? (
            <p role="alert" className="flex gap-2 text-sm text-danger">
              <AlertCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
              <span>
                {failure.title}. {failure.description}
              </span>
            </p>
          ) : null}
        </>
      }
    >
      <Button
        ref={button}
        variant="outline"
        className="w-full sm:w-auto"
        iconStart={<Download aria-hidden />}
        loading={download.isPending}
        aria-label={label}
        onClick={start}
      >
        {t("boot.consent.download")}
      </Button>
    </DataRow>
  );
}
