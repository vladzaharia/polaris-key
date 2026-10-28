import * as React from "react";
import type { FeedPackageVersion } from "../../../../api.js";

/** F-22: how each native client is named on a version's source line. */
const CLIENT_LABEL: Record<string, string> = {
  npm: "npm publish",
  twine: "twine upload",
  swift: "swift package-registry publish",
  maven: "Maven/Gradle deploy",
};

export function sourceLine(v: FeedPackageVersion): React.ReactNode {
  const s = v.source;
  const via = s.via === "oci-push" ? " · docker push" : "";
  if (s.kind === "oidc")
    return (
      <>
        Trusted publisher{s.publisher ? ` ${s.publisher}` : ""}
        {s.runUrl ? (
          <>
            {" · "}
            <a
              href={s.runUrl}
              target="_blank"
              rel="noreferrer"
              className="py-1 text-accent-fg underline underline-offset-4"
            >
              run
            </a>
          </>
        ) : null}
        {via}
      </>
    );
  if (s.kind === "static")
    return (
      <>
        CI token
        {s.tokenId ? <span className="font-mono"> {s.tokenId}</span> : null}
        {s.client ? ` · ${CLIENT_LABEL[s.client] ?? s.client}` : null}
        {via}
      </>
    );
  if (s.kind === "registry")
    return (
      <>
        Registry token
        {s.tokenId ? <span className="font-mono"> {s.tokenId}</span> : null}
        {s.client ? ` · ${CLIENT_LABEL[s.client] ?? s.client}` : null}
        {via}
      </>
    );
  if (s.kind === "console") return "The console";
  return "Unknown source";
}
