import * as React from "react";
import { Mail } from "lucide-react";
import { Button } from "../../../ui/Button.js";
import { toast } from "../../../ui/toast.js";
import { useEmailDownload } from "../../data.js";
import { portalErrorCopy } from "../../errors.js";
import { GET_IT_COPY as C, emailName, emailSent } from "../../copy/getIt.js";
import type { PlatformKey } from "../Glyphs.js";
import { osName } from "../../model/library.js";
import { t } from "../../../lib/copy.js";

/**
 * "Email me the download" (G23): the focused download's one primary on a phone that is looking at
 * a build for another OS, never a download of it. It mails the account's own address the link to
 * this page for `platform` (`POST /api/products/<p>/email-download`), the way the Library's
 * quick action does. Sized and filled like {@link DownloadButton}'s `lead`, so the primary does
 * not change look between a computer and a phone.
 */
export function EmailDownloadButton({
  product,
  productName,
  platform,
}: {
  product: string;
  productName: string;
  platform: PlatformKey;
}): React.ReactElement {
  const email = useEmailDownload();
  const os = osName(platform);
  return (
    <Button
      size="lg"
      className="h-12 px-6"
      loading={email.isPending}
      iconStart={<Mail aria-hidden />}
      aria-label={emailName(productName, os)}
      onClick={() =>
        email.mutate(
          { product, platform },
          {
            onSuccess: () =>
              toast.success(t("signin.code.title"), {
                description: emailSent(productName, os),
              }),
            onError: (err) =>
              toast.error(t("locker.quick.emailFailed"), {
                description: portalErrorCopy(err).description,
              }),
          },
        )
      }
    >
      {C["getIt.flow.emailMe"]}
    </Button>
  );
}
