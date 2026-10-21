import * as React from "react";
import { Button } from "../../../../ui/Button.js";
import { Skeleton } from "../../../../ui/Skeleton.js";
import { Wizard, type WizardStep } from "../../../../ui/wizard/index.js";
import { STOREFRONTS_FLOW } from "../../../wizard/flows.js";
import { Link, useSearchParam } from "../../../router.js";
import { codecs, r } from "../../../routes.js";
import { FLOW_STEPS } from "../model/flowSteps.js";
import { TITLE } from "../model/flowCopy.js";

const stepCodec = codecs.oneOf(FLOW_STEPS, "choose");
const STEPS: readonly WizardStep[] = STOREFRONTS_FLOW.steps.map((x) => ({
  id: x.id,
  label: x.label,
}));

/**
 * The Add to storefronts frame while the stores load (B-225): the stepper and the step's heading
 * are already known from the URL, so only the body is a skeleton.
 */
export function FlowSkeleton({ slug }: { slug: string }): React.ReactElement {
  const [step] = useSearchParam("step", stepCodec, { replace: false });
  return (
    <Wizard
      centered={false}
      label="Add to storefronts"
      steps={STEPS}
      current={step}
      title={TITLE[step]!}
      footer={{
        later: (
          <Button variant="ghost" asChild>
            <Link to={r.storefronts(slug)}>Do this later</Link>
          </Button>
        ),
      }}
    >
      <Skeleton className="h-48 w-full" />
    </Wizard>
  );
}
