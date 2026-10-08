import * as React from "react";
import type { Block, Inline, Line } from "../model/markdown.js";

/**
 * Release notes drawn from the Markdown tree (`model/markdown.ts`) as React elements, never as an
 * HTML string: React escapes every text node, so the notes cannot add markup, script or style,
 * and the page's CSP needs nothing new. Links are the safe ones the parser kept (`https:` with no
 * credentials, or `mailto:`); a web link opens in a new tab, like the page's other links out.
 */
export function Markdown({
  blocks,
}: {
  blocks: readonly Block[];
}): React.ReactElement {
  return (
    <>
      {blocks.map((b, i) => (
        <MarkdownBlock key={i} block={b} />
      ))}
    </>
  );
}

const HEADING_TAGS = ["h3", "h4", "h5", "h6"] as const;

function MarkdownBlock({ block: b }: { block: Block }): React.ReactElement {
  switch (b.kind) {
    case "heading": {
      const Tag = HEADING_TAGS[Math.min(Math.max(b.level, 3), 6) - 3]!;
      return (
        <Tag className="pt-1 text-[0.9375rem] font-bold text-fg-strong">
          <Inlines nodes={b.children} />
        </Tag>
      );
    }
    case "p":
      return (
        <p>
          <Lines lines={b.lines} />
        </p>
      );
    case "ul":
      return (
        <ul className="list-disc space-y-1.5 pl-5">
          {b.items.map((item, i) => (
            <li key={i}>
              <Lines lines={item} />
            </li>
          ))}
        </ul>
      );
    case "ol":
      return (
        <ol
          start={b.start === 1 ? undefined : b.start}
          className="list-decimal space-y-1.5 pl-5"
        >
          {b.items.map((item, i) => (
            <li key={i}>
              <Lines lines={item} />
            </li>
          ))}
        </ol>
      );
    case "quote":
      return (
        <blockquote className="border-l-2 border-border-strong pl-3 text-fg-muted">
          <Lines lines={b.lines} />
        </blockquote>
      );
    case "code":
      return (
        <pre className="overflow-x-auto rounded-md border border-border bg-surface-sunken p-3 font-mono text-[0.8125rem] text-fg-strong">
          <code>{b.text}</code>
        </pre>
      );
    case "hr":
      return <hr className="border-border" />;
  }
}

function Lines({ lines }: { lines: readonly Line[] }): React.ReactElement {
  return (
    <>
      {lines.map((line, i) => (
        <React.Fragment key={i}>
          {i > 0 ? <br /> : null}
          <Inlines nodes={line} />
        </React.Fragment>
      ))}
    </>
  );
}

function Inlines({ nodes }: { nodes: readonly Inline[] }): React.ReactElement {
  return (
    <>
      {nodes.map((n, i) => (
        <InlineNode key={i} node={n} />
      ))}
    </>
  );
}

function InlineNode({ node: n }: { node: Inline }): React.ReactElement {
  switch (n.kind) {
    case "text":
      return <>{n.text}</>;
    case "code":
      return (
        <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[0.8125rem] text-fg-strong">
          {n.text}
        </code>
      );
    case "strong":
      return (
        <strong className="font-bold text-fg-strong">
          <Inlines nodes={n.children} />
        </strong>
      );
    case "em":
      return (
        <em>
          <Inlines nodes={n.children} />
        </em>
      );
    case "del":
      return (
        <del>
          <Inlines nodes={n.children} />
        </del>
      );
    case "link":
      return n.href.startsWith("mailto:") ? (
        <a
          href={n.href}
          className="text-accent-fg underline underline-offset-2 hover:text-fg-strong"
        >
          <Inlines nodes={n.children} />
        </a>
      ) : (
        <a
          href={n.href}
          target="_blank"
          rel="noreferrer"
          className="text-accent-fg underline underline-offset-2 hover:text-fg-strong"
        >
          <Inlines nodes={n.children} />
        </a>
      );
  }
}
