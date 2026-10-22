import * as React from "react";
import { ArrowRight } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { Callout } from "../../ui/Callout.js";
import { Input } from "../../ui/Input.js";
import {
  AutoList,
  ChoiceStep,
  DoneStep,
  FormStep,
  PrereqList,
  SnippetStep,
  Stepper,
  WaitingFor,
  Wizard,
  type WizardStep,
} from "../../ui/wizard/index.js";
import type { Story } from "../types.js";

const STEPS: WizardStep[] = [
  { id: "provider", label: "Provider", decided: "Kestrel Labs · Keycloak" },
  { id: "client", label: "Client", decided: "Secret sealed" },
  { id: "test", label: "Test sign-in" },
  { id: "domains", label: "Domains" },
  { id: "who", label: "Who signs in" },
];

function StepperDemo(): React.ReactElement {
  const [current, setCurrent] = React.useState("domains");
  return (
    <div className="space-y-6">
      <Stepper
        steps={STEPS}
        current={current}
        skipped={["test"]}
        onStep={setCurrent}
        label="New connection steps"
      />
      <Stepper
        variant="segments"
        steps={STEPS}
        current="test"
        label="Drawer steps"
      />
    </div>
  );
}

function PageWizardDemo(): React.ReactElement {
  const [current, setCurrent] = React.useState("test");
  const index = STEPS.findIndex((s) => s.id === current);
  return (
    <Wizard
      label="Add SSO connection"
      steps={STEPS}
      current={current}
      onStep={setCurrent}
      title="Test sign-in"
      why="Sign in once with a Kestrel Labs account to see what it sends."
      footer={{
        later: <Button variant="ghost">Do this later</Button>,
        onBack: index > 0 ? () => setCurrent(STEPS[index - 1]!.id) : undefined,
        primary: (
          <Button
            disabled
            iconEnd={<ArrowRight aria-hidden />}
            onClick={() => setCurrent(STEPS[index + 1]!.id)}
          >
            Continue to domains
          </Button>
        ),
        reason: "Fix the client to continue",
      }}
      aside={
        <>
          <h2 className="text-sm font-semibold text-fg-strong">
            What this sets up
          </h2>
          <p>
            The test shows the claims Kestrel Labs sends, before anyone else
            signs in.
          </p>
        </>
      }
    >
      <Callout
        tone="danger"
        title="Kestrel Labs didn't accept the client secret"
        action={
          <Button size="sm" variant="outline">
            Try again
          </Button>
        }
      >
        Copy the secret again from Keycloak and paste it on the Client step.
      </Callout>
    </Wizard>
  );
}

function DrawerWizardDemo(): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [current, setCurrent] = React.useState("a");
  const steps = [
    { id: "a", label: "Language" },
    { id: "b", label: "Add it" },
  ];
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Open the setup drawer
      </Button>
      <Wizard
        host="drawer"
        drawer={{ open, onOpenChange: setOpen, title: "Licensing quick start" }}
        label="Licensing quick start"
        steps={steps}
        current={current}
        title={current === "a" ? "Pick your language" : "Add the check"}
        why="One sentence of why, at most."
        footer={{
          onBack: current === "b" ? () => setCurrent("a") : undefined,
          primary:
            current === "a" ? (
              <Button onClick={() => setCurrent("b")}>Continue</Button>
            ) : (
              <Button onClick={() => setOpen(false)}>Done</Button>
            ),
        }}
      >
        <p className="text-sm text-fg">
          The drawer host keeps the page under it.
        </p>
      </Wizard>
    </>
  );
}

function StepsDemo(): React.ReactElement {
  const [lang, setLang] = React.useState<string | null>("ts");
  const [found, setFound] = React.useState<string | null>(null);
  return (
    <div className="max-w-2xl space-y-8">
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-fg-strong">ChoiceStep</h3>
        <ChoiceStep
          legend="Language"
          value={lang}
          onChange={setLang}
          choices={[
            {
              value: "ts",
              label: "TypeScript",
              description: "Node and the browser.",
              recommended: "Matches your repository.",
            },
            { value: "py", label: "Python", description: "3.9 and later." },
          ]}
        />
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-fg-strong">PrereqList</h3>
        <PrereqList
          rows={[
            {
              id: "team",
              label: "App Store team connection",
              detail: "Acme Inc.",
              state: "met",
            },
            {
              id: "app",
              label: "The product's app",
              detail: "Pick the app in App Store Connect.",
              state: "unmet",
              fix: (
                <Button size="sm" variant="outline">
                  Pick the app
                </Button>
              ),
            },
            {
              id: "write",
              label: "Write access",
              detail: "Shown by the first write.",
              state: "unknown",
            },
          ]}
        />
      </section>
      <AutoList
        items={[
          {
            id: "1",
            label: "Create the release environment",
            state: "done",
            result: "release",
            source: "GitHub App",
          },
          {
            id: "2",
            label: "Open the setup pull request",
            state: "doing",
            source: "GitHub App",
          },
          {
            id: "3",
            label: "Add the trusted publisher",
            state: "failed",
            result: "Permission missing",
            action: (
              <Button size="sm" variant="outline">
                Try again
              </Button>
            ),
          },
          { id: "4", label: "Protect v* tags", state: "will" },
        ]}
      />
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-fg-strong">WaitingFor</h3>
        <WaitingFor
          waiting="Waiting for the first release from CI"
          found={found}
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => setFound(found ? null : "0.1.0 arrived 12 s ago")}
        >
          {found ? "Reset" : "Simulate the release"}
        </Button>
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-fg-strong">SnippetStep</h3>
        <SnippetStep
          tabs={[
            {
              id: "ts",
              label: "TypeScript",
              filename: "src/licensing.ts",
              language: "ts",
              code: 'import { PolarisKey } from "@polaris-key/node";\n\nconst pkey = new PolarisKey({ product: "acme" });',
              where: "Anywhere your app starts",
            },
            {
              id: "json",
              label: "Config",
              filename: ".pkey/product.json",
              language: "json",
              code: '{ "product": { "slug": "acme" } }',
              where: "Repository root",
            },
          ]}
        />
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-fg-strong">FormStep</h3>
        <FormStep
          formId="kit-form"
          onSubmit={() => undefined}
          error={{
            title: "Nothing was saved",
            description: "Your input is still here.",
          }}
        >
          <label className="block space-y-1 text-sm">
            <span className="font-medium text-fg-strong">Issuer URL</span>
            <Input defaultValue="https://sso.kestrel.example.com" />
          </label>
        </FormStep>
      </section>
      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-fg-strong">DoneStep</h3>
        <DoneStep
          result="Google Play is set up"
          detail="The first upload went through."
          next={[
            <Button key="a" variant="outline">
              Open Google Play
            </Button>,
          ]}
        />
      </section>
    </div>
  );
}

export const stories: Story[] = [
  {
    id: "stepper",
    group: "Templates",
    title: "Stepper",
    description:
      "Done steps say what was decided; a skipped step says so; future steps are disabled with a reason. Below, the drawer's segments.",
    render: () => <StepperDemo />,
  },
  {
    id: "wizard-page",
    group: "Templates",
    title: "Wizard (page host)",
    description:
      "A failed step in the centred 960 px column: the stepper, one question, the reason Continue is off.",
    render: () => <PageWizardDemo />,
  },
  {
    id: "wizard-drawer",
    group: "Templates",
    title: "Wizard (drawer host)",
    description: "Segments under the title; the step carries “Step n of m”.",
    render: () => <DrawerWizardDemo />,
  },
  {
    id: "wizard-steps",
    group: "Templates",
    title: "Wizard steps",
    description:
      "ChoiceStep, PrereqList, AutoList, WaitingFor, SnippetStep, FormStep and DoneStep.",
    render: () => <StepsDemo />,
  },
];
