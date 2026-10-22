/**
 * The search dialog's behaviour (Search.astro, docs.search): Pagefind's JS API, one bundle per
 * reader, grouped results, the keyboard, `?q=` and the message-code jump.
 *
 * Which bundle (docs plan §3.1; the bundles are nested, public in member in admin, so exactly one
 * is loaded and never merged, which would return each public page twice):
 *   - polaris.locker serves Help's own bundle and nothing else (`pagefind-help`);
 *   - key.plrs.im: the highest tier the reader can open, asked of the console's `/manage/api/me`.
 *     A gated bundle is requested only after that answer says the session may read it.
 * "Help only" is a filter on that bundle (`door`, set on every page by PageTitle.astro).
 */

type Door = "help" | "developers" | "operate";
type Scope = "help" | "all";
type Tier = "public" | "member" | "admin";

interface PagefindData {
  url: string;
  meta?: { title?: string; trail?: string };
  filters?: { door?: string[] };
}
interface Pagefind {
  init(): Promise<void>;
  debouncedSearch(
    query: string,
    options: { filters?: Record<string, string> },
    wait: number,
  ): Promise<{ results: { data(): Promise<PagefindData> }[] } | null>;
}
interface Row {
  href: string;
  title: string;
  trail: string;
  door: Door | "jump";
}

const DOORS: readonly { id: Door; label: string }[] = [
  { id: "help", label: "Help" },
  { id: "developers", label: "Developers" },
  { id: "operate", label: "Operate" },
];
const BUNDLE: Record<Tier, string> = {
  public: "pagefind",
  member: "pagefind-member",
  admin: "pagefind-admin",
};
/** A query worth looking up as a message id: `rate_limited`, `activation.rate-limited`. */
const CODE_SHAPE = /^[a-z][a-z0-9._-]{2,}$/i;
const MAX_PER_GROUP = 6;
const ENGINE_TIMEOUT_MS = 10_000;

const timeout = <T>(p: Promise<T>): Promise<T> =>
  Promise.race([
    p,
    new Promise<never>((_, no) => setTimeout(no, ENGINE_TIMEOUT_MS)),
  ]);

const doorOfUrl = (url: string): Door =>
  /^(\/docs)?\/help(\/|$)/.test(url)
    ? "help"
    : /^(\/docs)?\/(operate|contribute)(\/|$)/.test(url)
      ? "operate"
      : "developers";

class SiteSearch extends HTMLElement {
  private readonly base = this.dataset.base ?? "/docs";
  private readonly home: Scope = this.dataset.scope === "help" ? "help" : "all";
  private scope: Scope = this.home;
  private canWiden = false;
  private engine: Promise<{ pf: Pagefind; widen: boolean }> | null = null;
  private codes: Promise<string[]> | null = null;
  private seq = 0;
  private rows: Row[] = [];
  private active = -1;
  private grace = 0;

  private readonly open_ = this.q<HTMLButtonElement>("button[data-open-modal]");
  private readonly dialog = this.q<HTMLDialogElement>("dialog");
  private readonly input = this.q<HTMLInputElement>("input");
  private readonly list = this.q<HTMLElement>(".pk-search-results");
  private readonly hint = this.q<HTMLElement>("[data-hint]");
  private readonly skeleton = this.q<HTMLElement>(".pk-search-skeleton");
  private readonly failed = this.q<HTMLElement>(".pk-search-failed-box");
  private readonly empty = this.q<HTMLElement>(".pk-search-empty");
  private readonly emptyText = this.q<HTMLElement>("[data-empty]");
  private readonly widen = this.q<HTMLButtonElement>(".pk-search-widen");
  private readonly status = this.q<HTMLElement>(".pk-search-status");
  private readonly scopeBox = this.q<HTMLElement>(".pk-search-scope");

  private q<T extends Element>(selector: string): T {
    return this.querySelector<T>(selector)!;
  }

  constructor() {
    super();
    this.platformKeys();

    this.open_.addEventListener("click", () => this.show());
    this.open_.disabled = false;
    this.q("[data-close-modal]").addEventListener("click", () =>
      this.dialog.close(),
    );
    // The dialog fills its frame, so a click on the dialog itself is a click on the backdrop.
    this.dialog.addEventListener("click", (e) => {
      if (e.target === this.dialog) this.dialog.close();
    });
    this.dialog.addEventListener("close", () => {
      document.body.toggleAttribute("data-search-modal-open", false);
      const url = new URL(location.href);
      if (url.searchParams.has("q")) {
        url.searchParams.delete("q");
        history.replaceState(history.state, "", url);
      }
    });
    window.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (this.dialog.open) this.dialog.close();
        else this.show();
      }
    });

    this.input.addEventListener("input", () => this.run());
    this.input.addEventListener("keydown", (e) => this.keys(e));
    this.list.addEventListener("mousemove", (e) => {
      const row = (e.target as Element).closest<HTMLElement>("[role=option]");
      if (row) this.select(Number(row.dataset.i));
    });
    this.q(".pk-search-retry").addEventListener("click", () => {
      this.engine = null;
      this.run();
    });
    this.widen.addEventListener("click", () => this.setScope("all", true));
    this.scopeBox.addEventListener("click", (e) => {
      const b = (e.target as Element).closest<HTMLElement>("[data-scope]");
      if (b) this.setScope(b.dataset.scope as Scope, false);
    });
    this.scopeBox.addEventListener("keydown", (e) => {
      if (!/^Arrow(Left|Right|Up|Down)$/.test(e.key)) return;
      e.preventDefault();
      this.setScope(this.scope === "help" ? "all" : "help", false, true);
    });

    const q = new URLSearchParams(location.search).get("q");
    if (q) this.show(q);
  }

  /** ⌘ on Apple devices, Ctrl elsewhere; the keys are shown once the script knows which. */
  private platformKeys(): void {
    const mac = /(Mac|iPhone|iPod|iPad)/i.test(navigator.platform);
    const mod = mac ? "⌘" : "Ctrl";
    const trigger = this.q<HTMLElement>(".pk-search-kbd");
    trigger.querySelector("kbd")!.textContent = mod;
    trigger.hidden = false;
    this.q(".pk-search-mod").textContent = mod;
    if (mac) this.open_.setAttribute("aria-keyshortcuts", "Meta+K");
  }

  private show(query?: string): void {
    if (!this.dialog.open) this.dialog.showModal();
    document.body.toggleAttribute("data-search-modal-open", true);
    if (query !== undefined) this.input.value = query;
    this.input.focus();
    this.input.select();
    // Warm the engine, and learn whether this reader can widen to all docs.
    this.load().then(
      (e) => {
        this.canWiden = e.widen;
        this.syncScope();
      },
      () => {},
    );
    this.run();
  }

  private setScope(
    scope: Scope,
    focusInput: boolean,
    focusRadio = false,
  ): void {
    this.scope = scope;
    this.syncScope();
    if (focusRadio) this.q<HTMLElement>(`[data-scope=${scope}]`).focus();
    if (focusInput) this.input.focus();
    this.run();
  }

  private syncScope(): void {
    this.scopeBox.hidden = !(this.home === "help" && this.canWiden);
    for (const b of this.scopeBox.querySelectorAll<HTMLElement>(
      "[data-scope]",
    )) {
      const on = b.dataset.scope === this.scope;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
  }

  // ---- engine ----------------------------------------------------------------------------

  private async tier(): Promise<Tier> {
    try {
      const res = await fetch("/manage/api/me", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!res.ok) return "public";
      const me = (await res.json()) as {
        permissions?: { platform?: { view?: string[] } };
      };
      const view = me.permissions?.platform?.view ?? [];
      return view.includes("docs")
        ? "admin"
        : view.includes("console")
          ? "member"
          : "public";
    } catch {
      return "public";
    }
  }

  private load(): Promise<{ pf: Pagefind; widen: boolean }> {
    this.engine ??= (async () => {
      // Help is the customer host's: it serves Help's own bundle and redirects every other docs
      // path away, which is how a Help page there knows it cannot widen (a redirect is not followed).
      let customer = false;
      if (this.home === "help") {
        try {
          const probe = await fetch(
            `${this.base}/pagefind/pagefind-entry.json`,
            {
              method: "HEAD",
              redirect: "manual",
            },
          );
          customer = probe.type === "opaqueredirect" || !probe.ok;
        } catch {
          customer = true;
        }
      }
      const dir = customer ? "pagefind-help" : BUNDLE[await this.tier()];
      const pf = (await import(
        /* @vite-ignore */ `${this.base}/${dir}/pagefind.js`
      )) as Pagefind;
      await pf.init();
      return { pf, widen: this.home === "help" && !customer };
    })();
    this.engine.catch(() => {
      this.engine = null;
    });
    return this.engine;
  }

  private loadCodes(): Promise<string[]> {
    this.codes ??= fetch(`${this.base}/help/codes.json`)
      .then((r) => (r.ok ? (r.json() as Promise<string[]>) : []))
      .catch(() => []);
    return this.codes;
  }

  // ---- search ----------------------------------------------------------------------------

  private panel(
    which: "hint" | "skeleton" | "failed" | "empty" | "list" | "none",
  ): void {
    this.hint.hidden = which !== "hint";
    this.skeleton.hidden = which !== "skeleton";
    this.failed.hidden = which !== "failed";
    this.empty.hidden = which !== "empty";
    this.list.hidden = which !== "list";
    this.input.setAttribute("aria-expanded", String(which === "list"));
  }

  private async run(): Promise<void> {
    const mine = ++this.seq;
    const query = this.input.value.trim();
    clearTimeout(this.grace);
    this.rows = [];
    this.active = -1;
    this.input.removeAttribute("aria-activedescendant");
    if (query === "") {
      this.hint.textContent =
        this.scope === "help"
          ? "Search Help, or type a message code."
          : "Search the docs, or type a message code.";
      this.panel("hint");
      this.status.textContent = "";
      return;
    }
    // Skeleton rows only after a grace, so a quick answer does not flash them.
    this.grace = window.setTimeout(() => {
      if (mine === this.seq) this.panel("skeleton");
    }, 200);
    try {
      const { pf } = await timeout(this.load());
      const filters: Record<string, string> =
        this.scope === "help" ? { door: "help" } : {};
      const [found, codes] = await Promise.all([
        timeout(pf.debouncedSearch(query, { filters }, 120)),
        CODE_SHAPE.test(query) ? this.loadCodes() : Promise.resolve([]),
      ]);
      // null: a newer keystroke superseded this search.
      if (found === null || mine !== this.seq) return;
      const data = await timeout(
        Promise.all(found.results.slice(0, 30).map((r) => r.data())),
      );
      if (mine !== this.seq) return;
      clearTimeout(this.grace);
      const rows: Row[] = data.map((d) => {
        const door =
          (d.filters?.door?.[0] as Door | undefined) ?? doorOfUrl(d.url);
        return {
          // Pagefind has already put the site's base in front of the url.
          href: d.url,
          title: d.meta?.title ?? d.url,
          trail:
            d.meta?.trail ?? DOORS.find((x) => x.id === door)?.label ?? "Docs",
          door,
        };
      });
      const id = codes.find((c) => c.toLowerCase() === query.toLowerCase());
      if (id !== undefined)
        rows.unshift({
          href: `${this.base}/help/code/${id}/`,
          title: id,
          trail: "Help › Messages",
          door: "jump",
        });
      this.render(rows, query);
    } catch {
      if (mine !== this.seq) return;
      clearTimeout(this.grace);
      this.panel("failed");
      this.status.textContent = "";
    }
  }

  private render(rows: Row[], query: string): void {
    const groups: { key: Row["door"]; label: string; rows: Row[] }[] = [
      { key: "jump", label: "Jump to", rows: [] },
      ...DOORS.map((d) => ({ key: d.id, label: d.label, rows: [] as Row[] })),
    ];
    for (const r of rows) {
      const g = groups.find((x) => x.key === r.door)!;
      if (g.rows.length < MAX_PER_GROUP) g.rows.push(r);
    }
    this.list.replaceChildren();
    this.rows = [];
    for (const g of groups) {
      if (g.rows.length === 0) continue;
      const gid = `pk-search-g-${g.key}`;
      const box = document.createElement("div");
      box.setAttribute("role", "group");
      box.setAttribute("aria-labelledby", gid);
      const head = document.createElement("div");
      head.id = gid;
      head.className = "pk-search-group";
      head.textContent = g.label;
      box.append(head);
      for (const r of g.rows) box.append(this.row(r, this.rows.push(r) - 1));
      this.list.append(box);
    }
    if (this.rows.length === 0) {
      this.emptyText.textContent = `No results for “${query}”.`;
      this.widen.hidden = !(this.scope === "help" && this.canWiden);
      this.panel("empty");
      this.status.textContent = this.emptyText.textContent;
      return;
    }
    this.panel("list");
    this.select(0);
    const n = this.rows.length;
    this.status.textContent = `${n} ${n === 1 ? "result" : "results"}`;
  }

  private row(r: Row, i: number): HTMLElement {
    const a = document.createElement("a");
    a.id = `pk-search-o-${i}`;
    a.href = r.href;
    a.tabIndex = -1;
    a.className = "pk-search-row";
    a.dataset.i = String(i);
    a.setAttribute("role", "option");
    a.setAttribute("aria-selected", "false");
    const icon = document.createElement("span");
    icon.className = "pk-search-icon";
    const tpl = this.querySelector<HTMLTemplateElement>(
      `template[data-icon="${r.door === "jump" ? "jump" : `door-${r.door}`}"]`,
    );
    if (tpl) icon.append(tpl.content.cloneNode(true));
    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = r.title;
    const trail = document.createElement("small");
    trail.textContent = r.trail;
    text.append(title, trail);
    const enter = document.createElement("kbd");
    enter.setAttribute("aria-hidden", "true");
    enter.textContent = "↵";
    a.append(icon, text, enter);
    return a;
  }

  private select(i: number): void {
    if (this.rows.length === 0) return;
    this.active = (i + this.rows.length) % this.rows.length;
    for (const el of this.list.querySelectorAll<HTMLElement>("[role=option]")) {
      const on = Number(el.dataset.i) === this.active;
      el.setAttribute("aria-selected", String(on));
      if (on) {
        this.input.setAttribute("aria-activedescendant", el.id);
        el.scrollIntoView({ block: "nearest" });
      }
    }
  }

  private keys(e: KeyboardEvent): void {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (this.rows.length === 0) return;
      e.preventDefault();
      this.select(this.active + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Enter") {
      const row = this.rows[this.active];
      if (!row) return;
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) window.open(row.href, "_blank", "noopener");
      else location.assign(row.href);
    }
  }
}

if (!customElements.get("site-search"))
  customElements.define("site-search", SiteSearch);
