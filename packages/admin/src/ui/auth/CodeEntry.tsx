import * as React from "react";
import { Button } from "../Button.js";
import { t } from "../../lib/copy.js";
import { CODE_LENGTH, CodeCells } from "./CodeCells.js";
import { QuietLink, QuietLinks } from "./parts.js";

/** What a verify answers when it did not end the step: the line to show under the cells. */
export interface CodeVerifyOutcome {
  error?: string;
  /** Out of tries, or the code expired: "Send a new code" is the way on, at once. */
  resendNow?: boolean;
}

/** What a resend answers: the next pause, a line to say, or that no more may be sent. */
export interface CodeResendOutcome {
  /** Seconds before the next "Send a new code". */
  wait?: number;
  status?: { text: string; tone: "success" | "muted" };
  /** This sign-in sent every code it may: no more resends. */
  capped?: boolean;
  error?: string;
}

/**
 * The six-cell code, its Continue, the resend countdown and the quiet exits (SIGN-IN.md §3.4):
 * one control for the sign-in's CodeStep and the finish step's code stage. The callers word the
 * errors and decide what a right code or a refused resend does; this owns the timing, the focus
 * and the announcements. A `verify` or `resend` that moves the step on simply navigates away.
 */
export function CodeEntry({
  resendIn,
  submitLabel,
  verify,
  resend,
  hint,
  children,
}: {
  /** Seconds before the first "Send a new code". */
  resendIn: number;
  submitLabel: string;
  verify: (code: string) => Promise<CodeVerifyOutcome | void>;
  resend: () => Promise<CodeResendOutcome | void>;
  /** A line under the cells ("Or open the link in the email"). */
  hint?: string;
  /** The step's own exits, after the resend ("Use a different email"). */
  children?: React.ReactNode;
}): React.ReactElement {
  const [code, setCode] = React.useState("");
  const [wait, setWait] = React.useState(resendIn);
  const [status, setStatus] = React.useState<{
    text: string;
    tone: "success" | "muted";
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [verifying, setVerifying] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [capped, setCapped] = React.useState(false);
  const errorId = React.useId();
  const inputId = React.useId();
  React.useEffect(() => {
    if (wait <= 0) return;
    const id = window.setTimeout(() => setWait((w) => w - 1), 1000);
    return () => window.clearTimeout(id);
  }, [wait]);

  const submit = async (value: string): Promise<void> => {
    if (value.length !== CODE_LENGTH || verifying) return;
    setVerifying(true);
    setError(null);
    setStatus(null);
    try {
      const out = await verify(value);
      if (out) {
        if (out.error) {
          setError(out.error);
          setCode("");
        }
        if (out.resendNow) setWait(0);
      }
    } finally {
      setVerifying(false);
    }
  };

  /** The resend's button goes away while this step stays: focus moves to the code (§9 item 9). */
  const focusCode = (): void => {
    document.getElementById(inputId)?.focus();
  };

  const sendNew = async (): Promise<void> => {
    if (sending) return;
    setSending(true);
    setError(null);
    setStatus(null);
    try {
      const out = await resend();
      if (!out) return;
      if (out.error) return void setError(out.error);
      if (out.wait !== undefined) setWait(out.wait);
      if (out.capped) setCapped(true);
      if (out.status) setStatus(out.status);
      if (out.status?.tone === "success") setCode("");
      focusCode();
    } finally {
      setSending(false);
    }
  };

  const clock = `${Math.floor(wait / 60)}:${String(wait % 60).padStart(2, "0")}`;
  return (
    <>
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(code);
        }}
      >
        <div className="space-y-1.5">
          <label
            htmlFor={inputId}
            className="text-sm font-medium text-fg-strong"
          >
            {t("signin.approve.codeLabel")}
          </label>
          <CodeCells
            id={inputId}
            value={code}
            invalid={Boolean(error)}
            describedBy={error ? errorId : undefined}
            onChange={(v) => {
              setCode(v);
              if (error) setError(null);
              if (v.length === CODE_LENGTH) void submit(v);
            }}
          />
          {error ? (
            <p id={errorId} role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </div>
        {hint ? <p className="text-sm text-fg-muted">{hint}</p> : null}
        <Button
          type="submit"
          variant="neutral"
          size="lg"
          className="h-auto min-h-12 w-full whitespace-normal py-2 text-center text-base font-semibold"
          disabled={code.length !== CODE_LENGTH}
          loading={verifying}
        >
          {submitLabel}
        </Button>
      </form>
      {/* Always in the tree so the resend is announced; visually hidden while empty. */}
      <div
        role="status"
        className={
          status
            ? status.tone === "success"
              ? "text-sm text-success"
              : "text-sm text-fg-muted"
            : "sr-only"
        }
      >
        {status?.text}
      </div>
      <QuietLinks>
        {capped ? null : wait > 0 ? (
          <span className="inline-flex min-h-11 items-center px-1 text-fg-muted">
            {t("signin.code.resendIn", { time: clock })}
          </span>
        ) : (
          <QuietLink onClick={() => void sendNew()}>
            {sending ? t("common.working") : t("signin.code.resend")}
          </QuietLink>
        )}
        {children}
      </QuietLinks>
    </>
  );
}
