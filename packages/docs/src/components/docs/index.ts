/**
 * The docs components, used in MDX (docs plan §8.3): their names, where they live and what each
 * takes. DOC-03a builds them with final props and no styling; DOC-02a restyles them on the
 * console's `ui/`. `contribute/docs-components` renders this list, and `docsComponents.test.ts`
 * fails when a component file and this registry disagree.
 *
 * `KitBaselines` lives in `../ui/` with the UI-kit section's other blocks.
 */

export interface DocsComponent {
  /** The component's name in MDX. */
  name: string;
  /** File under `src/components/docs/`, or a path from `src/components/`. */
  file: string;
  /** What it renders. */
  summary: string;
  /** Props as `name: type` (a trailing ? marks an optional prop). */
  props: readonly string[];
}

export const DOCS_COMPONENTS: readonly DocsComponent[] = [
  {
    name: "SdkPicker",
    file: "SdkPicker.astro",
    summary: "The page-level SDK choice, kept in ?sdk= and in the browser.",
    props: ["sdks?: SdkId[]", "initial?: SdkId"],
  },
  {
    name: "Lanes",
    file: "Lanes.astro",
    summary: "The two integration lanes around app code, at equal depth.",
    props: ["intro: string", "lanes?: LaneId[]", 'slots: "kit", "library"'],
  },
  {
    name: "Generated",
    file: "Generated.astro",
    summary:
      "SDK usage from SP-33's generator. Fails the build until it ships.",
    props: [
      "feature: string",
      "sdk?: SdkId",
      "lane?: LaneId",
      'part?: "usage" | "install" | "states"',
    ],
  },
  {
    name: "Snippet",
    file: "Snippet.astro",
    summary: "A region of a compiled source file, titled with its file name.",
    props: [
      "src: string",
      "region?: string",
      "lang?: string",
      "title?: string",
    ],
  },
  {
    name: "InstallSteps",
    file: "InstallSteps.astro",
    summary: "Registry routing, then the install, from the CLI's feedsSetup().",
    props: ["sdk: SdkId"],
  },
  {
    name: "StatesToHandle",
    file: "StatesToHandle.astro",
    summary:
      "Every state an own-UI app shows, with its copy key and Help link.",
    props: ["states: { state: string; copyKey: string; helpId?: string }[]"],
  },
  {
    name: "Steps",
    file: "Steps.astro",
    summary: "A numbered list of steps, one action each.",
    props: ["slot: an ordered list"],
  },
  {
    name: "Callout",
    file: "Callout.astro",
    summary: "An admonition with one meaning per type.",
    props: ['type: "note" | "tip" | "caution" | "danger"', "title: string"],
  },
  {
    name: "Pill",
    file: "Pill.astro",
    summary: "A short status label with a word.",
    props: [
      'tone?: "neutral" | "info" | "success" | "warning" | "danger" | "signed"',
    ],
  },
  {
    name: "Status",
    file: "Status.astro",
    summary: "Shipped, Not built yet or Beta, for a row of a status table.",
    props: ['state: "shipped" | "not-built" | "beta"'],
  },
  {
    name: "FeatureCard",
    file: "FeatureCard.astro",
    summary: "A card that routes to a feature, in its service accent.",
    props: ["feature: FeatureId", "description: string", "href?: string"],
  },
  {
    name: "CardGrid",
    file: "CardGrid.astro",
    summary: "A grid of cards.",
    props: ["stagger?: boolean"],
  },
  {
    name: "PortalShot",
    file: "PortalShot.astro",
    summary: "A portal screen from its committed baselines, dark and light.",
    props: ["id: PortalShotId", "caption: string", "alt: string"],
  },
  {
    name: "KitBaselines",
    file: "../ui/KitBaselines.astro",
    summary: "A UI-kit component's baselines, one tab per kit.",
    props: ["component: string"],
  },
  {
    name: "HelpMessage",
    file: "HelpMessage.astro",
    summary:
      "One Help message entry: the catalog title as the heading, the id as its anchor.",
    props: ["id: string"],
  },
  {
    name: "UiLabel",
    file: "UiLabel.astro",
    summary: "A UI label exactly as the screen shows it, in bold.",
    props: ["name: string", "slot: the label text"],
  },
  {
    name: "ConsoleLink",
    file: "ConsoleLink.astro",
    summary: "A deep link that opens a console page.",
    props: ["to: string", "slot: the link text"],
  },
  {
    name: "PortalLink",
    file: "PortalLink.astro",
    summary: "A link into the customer portal.",
    props: ["to: string", "slot: the link text"],
  },
  {
    name: "Requires",
    file: "Requires.astro",
    summary: "The chip row under a title: features, role, SDK minimum.",
    props: ["features?: FeatureId[]", "role?: string", "sdk?: string[]"],
  },
  {
    name: "RunbookSection",
    file: "RunbookSection.astro",
    summary: "One H2 section of docs/RUNBOOK.md or docs/DEPLOYMENT.md.",
    props: ['file: "RUNBOOK" | "DEPLOYMENT"', "heading: string"],
  },
];
