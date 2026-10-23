/**
 * The refusal every command prints as ▲ and exits 4 on. A leaf module (it imports nothing), so
 * `credentials.ts`, `bundle.ts` and `netErrors.ts` can all take it without an import cycle.
 */

/** A refusal (exit 4): the sentence, the one fix, and the `--json` error code. */
export class Refusal extends Error {
  constructor(
    message: string,
    readonly fix?: string,
    readonly code: string = "refused",
  ) {
    super(message);
    this.name = "Refusal";
  }
}
