import * as React from "react";
import { Pencil } from "lucide-react";
import { Button } from "../../../../ui/Button.js";
import { useWriteGate } from "../../../access/useCan.js";
import { Link } from "../../../router.js";
import { r } from "../../../routes.js";

/**
 * "Edit catalog" (B-230). A member without Managed config edit gets the button off, with whom to
 * ask, instead of a link into an editor the Worker would refuse at publish.
 */
export function EditCatalogButton({
  slug,
  icon = true,
}: {
  slug: string;
  icon?: boolean;
}): React.ReactElement {
  const gate = useWriteGate("config", slug);
  const iconStart = icon ? <Pencil aria-hidden /> : undefined;
  return gate.allowed ? (
    <Button asChild iconStart={iconStart}>
      <Link to={r.catalogEdit(slug)}>Edit catalog</Link>
    </Button>
  ) : (
    <Button iconStart={iconStart} disabledReason={gate.disabledReason}>
      Edit catalog
    </Button>
  );
}
