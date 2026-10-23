import * as React from "react";
import { errorCopy, type ErrorContext } from "../lib/errorCopy.js";

/**
 * The words and wiring behind `ErrorState`, supplied by the app that mounts it: the console's
 * (the default, over `lib/errorCopy`) and the customer site's (`portal/errors.ts`). One component
 * draws every failed load; the voice decides what it says and which of the two looks it takes
 * (`tone`), so neither app changes how it reads.
 */

/** The customer site's wording for a failure, as `portal/errors.ts` words it. */
export interface PortalVoiceCopy {
  title: string;
  description: string;
  /** Whether trying again can help (a Retry button is offered). */
  retry: boolean;
  /** Title and description as one line, for a message with no heading above it. */
  line: string;
  /** The catalog's catch-all: a page may say what failed instead. */
  generic?: boolean;
  /** The Help page that explains this refusal, when there is one. */
  help?: string;
}

export interface ConsoleVoice {
  tone: "console";
  copy: (
    error: unknown,
    context?: ErrorContext,
  ) => ReturnType<typeof errorCopy>;
}

export interface PortalVoice {
  tone: "portal";
  copy: (error: unknown, opts: { account: boolean }) => PortalVoiceCopy;
  /** What a bug report needs: the refusal's code and status, or the error's name and message. */
  details: (error: unknown) => Record<string, unknown>;
  retryLabel: string;
  /** The label of the Help link a refusal may carry. */
  helpLabel: string;
  /** The app's Help link (quiet, underlined, 44 px). */
  HelpLink: React.ComponentType<{ href: string; children: React.ReactNode }>;
}

export type ErrorVoice = ConsoleVoice | PortalVoice;

export const consoleVoice: ConsoleVoice = {
  tone: "console",
  copy: errorCopy,
};

const ErrorVoiceContext = React.createContext<ErrorVoice>(consoleVoice);

export function ErrorVoiceProvider({
  voice,
  children,
}: {
  voice: ErrorVoice;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <ErrorVoiceContext.Provider value={voice}>
      {children}
    </ErrorVoiceContext.Provider>
  );
}

export function useErrorVoice(): ErrorVoice {
  return React.useContext(ErrorVoiceContext);
}
