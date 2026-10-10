// `ViewModel`: one component's view as a live value, for a framework binding (React's
// `useSyncExternalStore`, a Lit reactive controller, a Vue ref) or a Node main process that
// sends each view over a bridge to a plain renderer. It holds the input, recomputes the view on
// every change, runs DL7's loading delay as a model timer, and delivers through the UI-thread
// hook. The view is plain data, so a snapshot crosses any bridge as it is.

import { contextOf, type UiInput } from "./input.js";
import {
  DELAYED_LOADING_STATES,
  defaultSchedule,
  startLoadingTimer,
  type LoadingTimer,
  type Now,
  type Schedule,
} from "./loading.js";
import { MODELS } from "./models/index.js";
import { createStore, type Deliver, type Store } from "./store.js";
import type { View } from "./view.js";
import type { ComponentName } from "./vocabulary.js";

export interface ViewModelOptions {
  deliver?: Deliver;
  schedule?: Schedule;
  now?: Now;
}

export class ViewModel<C extends ComponentName = ComponentName> {
  readonly component: C;
  private input: UiInput;
  private readonly store: Store<View>;
  private readonly schedule: Schedule;
  private readonly now: Now | undefined;
  private timer: LoadingTimer | null = null;
  private disposed = false;

  constructor(
    component: C,
    input: UiInput = {},
    options: ViewModelOptions = {},
  ) {
    this.component = component;
    this.input = input;
    this.schedule = options.schedule ?? defaultSchedule;
    this.now = options.now;
    this.store = createStore<View>(this.compute(), {
      deliver: options.deliver,
      // A view is plain data: an equal one notifies no one.
      equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    });
  }

  /** The current view. */
  get view(): View {
    return this.store.get();
  }

  /** The input the view is computed from. */
  get snapshot(): UiInput {
    return this.input;
  }

  /** Called with each new view, through the UI-thread hook. */
  subscribe(listener: (view: View) => void): () => void {
    return this.store.subscribe(listener);
  }

  /** Change the input: a patch over the last one, or a new input from it. */
  update(next: Partial<UiInput> | ((prev: UiInput) => UiInput)): void {
    if (this.disposed) return;
    this.input =
      typeof next === "function"
        ? next(this.input)
        : { ...this.input, ...next };
    this.store.set(this.compute());
  }

  /** Stop the loading timer; no view is delivered after this. */
  dispose(): void {
    this.disposed = true;
    this.timer?.stop();
    this.timer = null;
  }

  /**
   * The view for the current input. A delayed loading state (`vocabulary.loadingDelay`) starts
   * the model timer and shows nothing until it fires; any other state stops it. An input that
   * already says how long it waited (`elapsedMs`) is taken as it is.
   */
  private compute(): View {
    const model = MODELS[this.component];
    const plain = model(contextOf(this.input));
    if (this.input.elapsedMs !== undefined) return plain;
    const delayed = DELAYED_LOADING_STATES.includes(
      `${plain.component}.${plain.state}`,
    );
    if (!delayed || this.disposed) {
      this.timer?.stop();
      this.timer = null;
      return plain;
    }
    if (!this.timer)
      this.timer = startLoadingTimer(() => this.store.set(this.compute()), {
        schedule: this.schedule,
        ...(this.now ? { now: this.now } : {}),
      });
    return model(contextOf({ ...this.input, elapsedMs: this.timer.elapsed() }));
  }
}
