/**
 * A-32.2: the GitHub Actions release workflow (`.github/workflows/release.yml`) as text. One
 * renderer for the console's first-release panel, the setup PR and the Ship builds guide, so the
 * three cannot drift (the docs test pins the guide's example block to it).
 */

/** The Action's repository path, without a ref. */
export const PUBLISH_ACTION = "vladzaharia/polaris-key/actions/publish";

/** The ref where no Worker can name its own commit (docs, the offline panel). */
export const ACTION_REF_PLACEHOLDER = "<commit-sha>";

export interface CiWorkflowPack {
  /** The pack's deliverable id. */
  id: string;
  /** Where the job finds the pack's files. */
  dir: string;
}

export interface RenderCiWorkflowInput {
  /** The product slug, named in the header comment. */
  product: string;
  /** The release channel the tag publishes to. */
  channel: string;
  /** What follows `@` on the Action: a full commit SHA, or `ACTION_REF_PLACEHOLDER`. */
  actionRef: string;
  /** `.pkey/release` declares `releaseKeys`: the step then gets the release key secret. */
  releaseKeys: boolean;
  /** Data-only packs: each is published by a job of its own with the delegated content key. */
  packs?: readonly CiWorkflowPack[];
  /** Where the build leaves the app's files. Default `dist`. */
  dir?: string;
}

const NAME = /^[a-z0-9][a-z0-9._-]*$/;

function checkToken(label: string, value: string, re: RegExp): void {
  if (!re.test(value)) throw new Error(`renderCiWorkflow: bad ${label}`);
}

function job(
  name: string,
  args: string,
  secrets: readonly string[],
  actionRef: string,
  note: string,
): string[] {
  return [
    `  ${name}:`,
    "    runs-on: ubuntu-latest",
    "    environment: release",
    "    permissions:",
    "      contents: read",
    "      id-token: write",
    "    steps:",
    "      - uses: actions/checkout@v4",
    `      ${note}`,
    `      - uses: ${PUBLISH_ACTION}@${actionRef}`,
    "        with:",
    `          args: ${args}`,
    ...secrets,
  ];
}

export function renderCiWorkflow(input: RenderCiWorkflowInput): string {
  const dir = input.dir ?? "dist";
  checkToken("product", input.product, NAME);
  checkToken("channel", input.channel, NAME);
  checkToken("dir", dir, /^[A-Za-z0-9._/-]+$/);
  checkToken("actionRef", input.actionRef, /^(<commit-sha>|[0-9a-f]{40})$/);
  const tag = "--tag ${{ github.ref_name }}";
  const lines = [
    `# Publishes ${input.product} (the slug in .pkey/product) when a v* tag is pushed.`,
    "name: Release",
    "on:",
    "  push:",
    '    tags: ["v*"]',
    "",
    "jobs:",
    ...job(
      "publish",
      `${tag} --channel ${input.channel} --dir ${dir}`,
      input.releaseKeys
        ? ["          release-key: ${{ secrets.PKEY_RELEASE_KEY }}"]
        : [],
      input.actionRef,
      "# Build your files into " + dir + " here, before the publish step.",
    ),
  ];
  for (const pack of input.packs ?? []) {
    checkToken("pack id", pack.id, NAME);
    checkToken("pack dir", pack.dir, /^[A-Za-z0-9._/-]+$/);
    lines.push(
      "",
      ...job(
        `publish-pack-${pack.id}`,
        `${tag} --channel ${input.channel} --deliverable ${pack.id} --dir ${pack.dir}`,
        ["          content-key: ${{ secrets.PKEY_CONTENT_KEY }}"],
        input.actionRef,
        `# Build the ${pack.id} pack into ${pack.dir} here, before the publish step.`,
      ),
    );
  }
  return lines.join("\n") + "\n";
}
