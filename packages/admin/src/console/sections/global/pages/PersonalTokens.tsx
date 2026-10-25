/**
 * Personal tokens (`#/personal-tokens`), reached from the account menu (ST-34.11, D-9).
 *
 * Every member sees Yours: their own tokens, both scopes, with Revoke. Whoever holds the platform
 * area (the one `/account-tokens` asks for) also gets Everyone: the F-33 roster of people's tokens. The server enforces both lists; the tab is a view.
 */

import * as React from "react";
import { docsUrl } from "../../../../lib/docsLinks.js";
import { PageHeader } from "../../../../ui/PageHeader.js";
import { SegmentedControl } from "../../../../ui/SegmentedControl.js";
import { useCan } from "../../../access/useCan.js";
import { navigate, useRoute } from "../../../router.js";
import { r } from "../../../routes.js";
import { CollectionTemplate } from "../../../templates/Collection.js";
import { OwnPersonalTokens } from "./OwnPersonalTokens.js";
import { PersonalTokensRoster } from "./PersonalTokensRoster.js";

type Tab = "yours" | "everyone";

export function PersonalTokens(): React.ReactElement {
  const everyone = useCan("platform");
  // The tab is in the route (`?who=everyone`), so Back, reload and links keep it.
  const route = useRoute();
  const shown: Tab =
    everyone && route.query.get("who") === "everyone" ? "everyone" : "yours";
  return (
    <CollectionTemplate
      header={
        <PageHeader
          title="Personal tokens"
          description={
            <>
              What <code>pkey</code> and package installs use to act as you.{" "}
              <a
                className="underline underline-offset-2 hover:text-fg-strong"
                href={docsUrl("personalTokens")}
                target="_blank"
                rel="noreferrer"
              >
                Learn more
              </a>
            </>
          }
        />
      }
    >
      {everyone ? (
        <SegmentedControl<Tab>
          aria-label="Whose tokens"
          wrap
          options={[
            { value: "yours", label: "Yours" },
            { value: "everyone", label: "Everyone" },
          ]}
          value={shown}
          onChange={(t) =>
            navigate(r.personalTokens(t === "everyone" ? t : undefined))
          }
        />
      ) : null}
      {shown === "everyone" ? <PersonalTokensRoster /> : <OwnPersonalTokens />}
    </CollectionTemplate>
  );
}
