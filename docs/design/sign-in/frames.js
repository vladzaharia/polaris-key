/*
 * SIGN-IN.md key frames. Every frame renders at desktop (1440 wide) and phone (390 wide); the
 * theme comes from ?theme=dark|light. render.cjs screenshots every [data-shot] element.
 * Copy here is the copy in SIGN-IN.md §5.2 (copy keys); keep the two in step.
 */
(function () {
  const params = new URLSearchParams(location.search);
  const theme = params.get("theme") || "dark";
  document.documentElement.setAttribute("data-theme", theme);
  const only = params.get("only");

  // ---------- icons ----------
  const S = (d, extra = "") =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;
  const I = {
    mark: `<svg class="mark" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 4 L9 1 L9 19 L3 22 Z"/><path fill="currentColor" d="M11 12 L15 12 L21 18 L18 21 L11 14 Z"/><path fill="currentColor" d="M17 1 L19 4 L23 6 L19 8 L17 11 L15 8 L11 6 L15 4 Z"/></svg>`,
    apple: `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M16.36 12.62c-.02-2.2 1.8-3.26 1.88-3.31-1.03-1.5-2.62-1.7-3.18-1.73-1.35-.14-2.64.8-3.33.8-.69 0-1.74-.78-2.87-.76-1.47.02-2.83.86-3.59 2.18-1.53 2.66-.39 6.59 1.1 8.75.73 1.05 1.6 2.24 2.73 2.2 1.1-.05 1.51-.71 2.84-.71 1.32 0 1.7.71 2.86.69 1.18-.02 1.93-1.07 2.65-2.13.84-1.22 1.18-2.4 1.2-2.46-.03-.01-2.3-.88-2.32-3.5zM14.18 6.15c.6-.73 1.01-1.75.9-2.76-.87.04-1.92.58-2.54 1.31-.56.65-1.05 1.68-.92 2.67.97.08 1.96-.49 2.56-1.22z"/></svg>`,
    google: `<svg viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>`,
    steam: `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M11.98 0C5.68 0 .53 4.86.04 11.04l6.44 2.66a3.4 3.4 0 0 1 1.92-.59h.19l2.87-4.15v-.06a4.53 4.53 0 1 1 4.53 4.53h-.1l-4.08 2.92v.16a3.4 3.4 0 0 1-6.74.66L.4 15.4A12 12 0 1 0 11.98 0zM7.54 18.21l-1.47-.61a2.55 2.55 0 1 0 1.4-3.5l1.52.63a1.88 1.88 0 1 1-1.45 3.48zm11.42-9.3a3.02 3.02 0 1 0-6.04 0 3.02 3.02 0 0 0 6.04 0zm-5.28 0a2.27 2.27 0 1 1 4.54 0 2.27 2.27 0 0 1-4.54 0z"/></svg>`,
    key: S(
      '<circle cx="7.5" cy="15.5" r="3.5"/><path d="M10 13l8-8M15 8l3 3M17 6l2 2"/>',
    ),
    users: S(
      '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6"/><path d="M15.5 5.2a3 3 0 0 1 0 5.6M17.5 14.6c1.6.6 2.6 2.1 3 4.4"/>',
    ),
    lock: S(
      '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    ),
    laptop: S(
      '<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>',
    ),
    desktop: S(
      '<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M9 20h6M12 16v4"/>',
    ),
    tv: S(
      '<rect x="3" y="5" width="18" height="12" rx="1.5"/><path d="M8 21h8"/>',
    ),
    phone: S(
      '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18.5h2"/>',
    ),
    globe: S(
      '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    ),
    check: S('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    arrow: S('<path d="M5 12h14M13 6l6 6-6 6"/>'),
    passkey: S(
      '<circle cx="9" cy="8" r="3.5"/><path d="M3 19c.6-3.2 3-5 6-5 1.3 0 2.5.3 3.4.9"/><circle cx="17.5" cy="14.5" r="2"/><path d="M17.5 16.5v4M17.5 18.5h1.6"/>',
    ),
    mail: S(
      '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
    ),
    chev: S('<path d="M6 9l6 6 6-6"/>'),
    info: S('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'),
    warn: S('<path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17h.01"/>'),
    cloud: S(
      '<path d="M7 18h10a4 4 0 0 0 .5-8 6 6 0 0 0-11.5 1.5A3.3 3.3 0 0 0 7 18z"/>',
    ),
    user: S(
      '<circle cx="12" cy="8" r="4"/><path d="M4 20c1-4 4-6 8-6s7 2 8 6"/>',
    ),
    qrscan: S('<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/>'),
    ban: S('<circle cx="12" cy="12" r="8.5"/><path d="M6 18L18 6"/>'),
    star: `<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 1.5l2.6 6.3 6.9.5-5.3 4.4 1.7 6.7L12 15.8l-5.9 3.6 1.7-6.7L2.5 8.3l6.9-.5z"/></svg>`,
  };

  // ---------- product art ----------
  const art = {
    tidewater: `<svg viewBox="0 0 52 52" width="100%" height="100%"><rect width="52" height="52" fill="#0f2a33"/><path d="M0 22c9-4 17 4 26 0s17-4 26 0v30H0z" fill="#16525a"/><path d="M0 30c9-4 17 4 26 0s17-4 26 0v22H0z" fill="#f2c9a0"/><path d="M0 37c9-4 17 4 26 0s17-4 26 0v15H0z" fill="#f08a68"/></svg>`,
    driftkart: `<svg viewBox="0 0 52 52" width="100%" height="100%"><rect width="52" height="52" fill="#f26a1b"/><circle cx="16" cy="36" r="6" fill="#1b1b1f"/><circle cx="38" cy="36" r="6" fill="#1b1b1f"/><path d="M9 31l6-11h18l8 11z" fill="#fff4e8"/><path d="M20 20l3-6h8l2 6z" fill="#1b1b1f"/></svg>`,
    saltwind: `<svg viewBox="0 0 52 52" width="100%" height="100%"><defs><linearGradient id="sw" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7cc4e8"/><stop offset="1" stop-color="#1f5e8a"/></linearGradient></defs><rect width="52" height="52" fill="url(#sw)"/><path d="M27 8v30H12z" fill="#fff"/><path d="M29 14v24h11z" fill="#e8f4fb"/><path d="M8 40h36l-5 5H13z" fill="#123a55"/></svg>`,
    nightfall: `<svg viewBox="0 0 52 52" width="100%" height="100%"><rect width="52" height="52" fill="#1d1640"/><circle cx="30" cy="20" r="11" fill="#e9e1ff"/><circle cx="35" cy="16" r="10" fill="#1d1640"/><path d="M0 40l12-8 10 6 12-10 18 12v12H0z" fill="#2f2466"/></svg>`,
    mossgarden: `<svg viewBox="0 0 52 52" width="100%" height="100%"><rect width="52" height="52" fill="#20402c"/><circle cx="18" cy="30" r="12" fill="#3f8a4f"/><circle cx="34" cy="26" r="13" fill="#5fb06a"/><circle cx="27" cy="38" r="9" fill="#9ad27f"/></svg>`,
    storytime: `<svg viewBox="0 0 52 52" width="100%" height="100%"><rect width="52" height="52" fill="#3b2a5c"/><circle cx="39" cy="13" r="5" fill="#ffd98a"/><path d="M8 18c6-2 12-2 18 2v22c-6-4-12-4-18-2z" fill="#fdf3e1"/><path d="M44 18c-6-2-12-2-18 2v22c6-4 12-4 18-2z" fill="#f1e2c4"/><path d="M26 20v22" stroke="#3b2a5c" stroke-width="1.5"/></svg>`,
  };

  // ---------- deterministic helpers ----------
  function rng(seed) {
    let s = seed;
    return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  }
  function stars(w, h) {
    const r = rng(7);
    let dots = "";
    const n = Math.round((w * h) / 9000);
    for (let i = 0; i < n; i++) {
      const o = 0.18 + r() * 0.5;
      const size = r() < 0.08 ? 1.6 : 0.9;
      dots += `<circle cx="${(r() * w).toFixed(1)}" cy="${(r() * h).toFixed(1)}" r="${size}" fill="var(--pk-text-subtle)" opacity="${o.toFixed(2)}"/>`;
    }
    return `<svg class="stars" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${dots}</svg>`;
  }
  function qr(seed = 3) {
    const n = 25;
    const r = rng(seed);
    let cells = "";
    const finder = (x, y) =>
      `<rect x="${x}" y="${y}" width="7" height="7" fill="#000"/><rect x="${x + 1}" y="${y + 1}" width="5" height="5" fill="#fff"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3" fill="#000"/>`;
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const inF =
          (x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9);
        if (!inF && r() < 0.48)
          cells += `<rect x="${x}" y="${y}" width="1" height="1" fill="#000"/>`;
      }
    return `<svg class="qr" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="QR code">${cells}${finder(0, 0)}${finder(n - 7, 0)}${finder(0, n - 7)}</svg>`;
  }

  // ---------- building blocks ----------
  const lockup = (surface) =>
    `<div class="lockup">${I.mark}<span class="word">Polaris Key</span>${surface ? `<span class="sep"></span><span class="surface">${surface}</span>` : ""}</div>`;
  const appHeader = ({ icon, app, dev, where, whereIcon, code }) =>
    `<div class="card-head"><div class="icon">${art[icon]}</div><div><div class="t"><b>${app}</b> wants you to sign in</div><div class="w">${dev}<span>·</span>${I[whereIcon] || ""}<span>${where}</span></div>${
      code
        ? `<div class="codepanel"><span>Code on the screen</span><code>${code}</code><span>Check it matches the screen</span></div>`
        : ""
    }</div></div>`;
  const contextHeader = ({ icon, product, dev, line }) =>
    `<div class="card-head"><div class="icon">${art[icon]}</div><div><div class="t"><b>${product}</b> · ${dev}</div><div class="w">${line}</div></div></div>`;
  const footer = (app, dev) =>
    `<div class="card-foot">${I.lock}<span>Polaris Key signs you in for ${app}. ${dev} never sees your codes or passkeys.</span></div>`;
  const providers = (list) =>
    `<div class="providers ${list.length === 1 ? "one" : ""}" role="group" aria-label="Or continue with">${list
      .map(
        (p) =>
          `<div class="p" aria-label="Continue with ${p}">${I[p.toLowerCase()]}</div>`,
      )
      .join("")}</div>`;
  const field = (label, value, opts = {}) =>
    `<div><label class="lab">${label}</label><div class="input ${value ? "" : "ph"} ${opts.focus ? "focus" : ""}">${value || opts.ph || "you@example.com"}</div>${opts.help ? `<div class="help">${opts.help}</div>` : ""}</div>`;
  const btn = (kind, label, icon) =>
    `<div class="btn ${kind}">${label}${icon ? I[icon] : ""}</div>`;
  const person = (x = "Not you?") =>
    `<div class="person"><div class="avatar">MF</div><div><div class="n">Mara Fennick</div><div class="e">mara@fennick.studio</div></div><span class="x link">${x}</span></div>`;
  const meter = (used, limit) =>
    `<div class="meter" role="img" aria-label="${used} of ${limit} devices in use">${Array.from({ length: limit }, (_, i) => `<i class="${i < used ? "on" : ""}"></i>`).join("")}</div>`;
  // Full and blocked rows are not radios (SIGN-IN §3.14, D-45): a glyph sits where the radio would.
  // Row anatomy (SIGN-IN.md §3.6, O-11): title + tag; the tier as a neutral pill with the device
  // counter, or "Account-wide · unlimited devices"; then "{origin} · {term}"; a meter on seat rows.
  // `hideCount` is the mixed rule: seat rows drop the counter and meter when the account also
  // holds an Account-wide license for the product.
  const lic = ({
    name,
    tier,
    meta,
    used,
    limit,
    accountWide,
    hideCount,
    noMeter,
    sel,
    full,
    blocked,
    tag,
    tagKind,
    act,
    extra,
  }) => {
    const count = accountWide
      ? `<span class="aw">${I.users}Account-wide · unlimited devices</span>`
      : limit && !hideCount
        ? `<span>${used} of ${limit} ${limit === 1 ? "device" : "devices"}</span>`
        : "";
    const line2 =
      tier || count
        ? `<div class="tl">${tier ? `<span class="pill">${tier}</span>` : ""}${count}</div>`
        : "";
    const showMeter = limit && !accountWide && !hideCount && !noMeter;
    return `<div class="lic ${sel ? "sel" : ""} ${full ? "full" : ""} ${blocked ? "blocked" : ""}">${full || blocked ? `<div class="nosel" aria-hidden="true">${I.ban}</div>` : `<div class="radio"></div>`}<div class="ln">${name}</div>${tag ? `<span class="tag ${tagKind || ""}">${tag}</span>` : "<span></span>"}${line2}${meta ? `<div class="lm">${meta}</div>` : ""}${showMeter ? meter(used, limit) : ""}${act ? `<div class="act">${act}</div>` : ""}${extra || ""}</div>`;
  };
  const fullAct = `<div class="btn secondary inline">Replace a device</div><span class="link">Free a device</span>`;
  const FULL = {
    full: true,
    tag: "No free devices",
    tagKind: "warn",
    act: fullAct,
  };
  const chosen = (name, meta) =>
    `<div class="lic chosen"><div class="ln">${name}</div><span class="link" style="align-self:center">Change</span><div class="lm">${meta}</div></div>`;
  const quiet = (key) =>
    `<div class="links">${key ? `<span>${I.key} Use a license key instead</span>` : ""}<span>Cancel</span></div>`;
  const below = `<div class="below">Help · Privacy · Terms</div>`;

  // ---------- frames ----------
  // Each frame: { id, surface?, head?, body, foot?, kit? }
  const frames = [];
  const F = (f) => frames.push(f);

  // 01 Portal direct: MethodsStep
  F({
    id: "01-methods-portal",
    body: `<h1>Sign in to Polaris Key</h1>
      ${field("Email", "", { ph: "you@example.com" })}
      ${btn("primary", "Continue", "arrow")}
      <div class="or">or</div>
      ${providers(["Apple", "Google", "Steam"])}
      ${btn("ghost", `<span class="acc">${I.passkey.replace("<svg", '<svg width="18" height="18"')}</span> Sign in with a passkey`)}
      <div class="links"><span>${I.key} Have a license key?</span><span>${I.qrscan} Sign in with another device</span></div>`,
  });

  // 02 Device code passthrough (TV), Steam only
  F({
    id: "02-methods-device-code",
    head: appHeader({
      icon: "driftkart",
      app: "Drift Kart",
      dev: "Pitlane Games",
      where: "on Living room TV",
      whereIcon: "tv",
      code: "WDJB-MJHT",
    }),
    body: `<h1>Sign in to finish on Living room TV</h1>
      <p class="lede">Use your phone or computer here. Living room TV continues by itself when you're done.</p>
      ${field("Email", "")}
      ${btn("primary", "Continue", "arrow")}
      <div class="or">or</div>
      ${providers(["Steam"])}
      ${btn("ghost", `<span class="acc">${I.passkey.replace("<svg", '<svg width="18" height="18"')}</span> Sign in with a passkey`)}
      <p class="small center">Didn't start this yourself? <span class="link">Cancel it</span>. Someone may be trying to use your account.</p>`,
    foot: footer("Drift Kart", "Pitlane Games"),
  });

  // 03 CodeStep inside a web passthrough
  F({
    id: "03-code",
    head: appHeader({
      icon: "tidewater",
      app: "Tidewater Studio",
      dev: "Harbor Audio",
      where: "studio.harbor.audio",
      whereIcon: "globe",
    }),
    body: `<h1>Check your email</h1>
      <p class="lede">We sent a code and a sign-in link to <b>mara@fennick.studio</b>. Both work for 10 minutes.</p>
      <div><label class="lab">Code</label><div class="cells"><div>4</div><div>8</div><div>1</div><div class="cur"></div><div></div><div></div></div></div>
      <p class="small">Or open the link in the email. Keep this tab open.</p>
      ${btn("primary disabled", "Continue")}
      <div class="links"><span class="muted">Send a new code in 0:42</span><span class="link">Use a different email</span></div>`,
    foot: footer("Tidewater Studio", "Harbor Audio"),
  });

  // 04 EmailGateStep: Steam (no email), inside a native app passthrough
  F({
    id: "04-email-gate-steam",
    head: appHeader({
      icon: "saltwind",
      app: "Saltwind",
      dev: "Tern Works",
      where: "on Mara's iPhone",
      whereIcon: "phone",
    }),
    body: `<div class="strip">${I.steam} Signed in with Steam · marafox<span class="ok">${I.check} Done</span></div>
      <h1>Confirm your email</h1>
      <p class="lede">One step before Saltwind. We send sign-in codes, receipts and security notices here.</p>
      <div class="keycard"><div class="avatar" style="background:linear-gradient(135deg,#3a6f8f,#79b5cf)">mf</div><div style="flex:1">${field("Your name", "marafox")}<div class="help">Name and picture from Steam. <span class="link">Change picture</span></div></div></div>
      ${field("Email", "", { ph: "you@example.com", focus: true, help: "Steam doesn't share an email. Add one so you can get back in without Steam." })}
      ${btn("primary", "Send code")}
      <p class="small center"><span class="link">Cancel sign-in</span></p>
      <p class="small">By continuing you agree to the Polaris Key Terms and Privacy Policy.</p>`,
    foot: footer("Saltwind", "Tern Works"),
  });

  // 05 LicenseChoiceStep: many licenses, one full; rank-first preselects, nothing binds until the primary
  F({
    id: "05-choice-many",
    head: appHeader({
      icon: "tidewater",
      app: "Tidewater Studio",
      dev: "Harbor Audio",
      where: "on Mara's MacBook Pro",
      whereIcon: "laptop",
    }),
    body: `${person()}
      <h1>Choose a license for this device</h1>
      <p class="lede">Tidewater Studio will use it on Mara's MacBook Pro.</p>
      <div role="radiogroup" aria-label="Licenses for Tidewater Studio" style="display:flex;flex-direction:column;gap:10px">
      ${lic({ name: "Tidewater Studio", tier: "Pro", meta: "Bought from Harbor Audio · Lifetime", used: 2, limit: 3, sel: true })}
      ${lic({ name: "Tidewater Studio", tier: "Edu", meta: "Added with a key · Until 12 Jun 2027", used: 2, limit: 2, ...FULL })}
      </div>
      ${btn("primary", "Use this license and continue")}
      ${quiet(true)}`,
    foot: footer("Tidewater Studio", "Harbor Audio"),
  });

  // 06 Replace a device, expanded on the full license: one confirm that names both devices
  F({
    id: "06-choice-replace",
    head: appHeader({
      icon: "tidewater",
      app: "Tidewater Studio",
      dev: "Harbor Audio",
      where: "on Mara's MacBook Pro",
      whereIcon: "laptop",
    }),
    body: `${person()}
      <h1>Choose a license for this device</h1>
      <div role="radiogroup" aria-label="Licenses for Tidewater Studio" style="display:flex;flex-direction:column;gap:10px">
      ${lic({ name: "Tidewater Studio", tier: "Pro", meta: "Bought from Harbor Audio · Lifetime", used: 2, limit: 3 })}
      ${lic({
        name: "Tidewater Studio",
        tier: "Edu",
        meta: "Added with a key · Until 12 Jun 2027",
        used: 2,
        limit: 2,
        full: true,
        tag: "No free devices",
        tagKind: "warn",
        extra: `<div class="replace"><h2>Replace a device</h2>
          <div class="devs" role="radiogroup" aria-label="Devices on Tidewater Studio Edu">
            <div class="dev sel"><div class="radio"></div>${I.laptop.replace("<svg", '<svg class="g"')}<div><div class="dn">Work laptop</div><div class="dm">Windows · last used 23 days ago</div></div><span class="tag">Least recent</span></div>
            <div class="dev"><div class="radio"></div>${I.desktop.replace("<svg", '<svg class="g"')}<div><div class="dn">Studio iMac</div><div class="dm">macOS · last used 4 minutes ago</div></div><span class="tag active">Active now</span></div>
          </div>
          <div class="confirm"><h3>Replace Work laptop?</h3>
            <p>Work laptop signs out of Tidewater Studio and Mara's MacBook Pro takes its seat. Work laptop can sign in again later if a seat is free. We'll email you about it.</p>
            ${btn("primary", "Replace and continue")}
            ${btn("ghost", "Back")}
          </div>
        </div>`,
      })}
      </div>`,
    foot: footer("Tidewater Studio", "Harbor Audio"),
  });

  // 07 ConsentStep after the choice: the chosen license with Change (one decision per screen)
  F({
    id: "07-consent",
    head: appHeader({
      icon: "tidewater",
      app: "Tidewater Studio",
      dev: "Harbor Audio",
      where: "on Mara's MacBook Pro",
      whereIcon: "laptop",
    }),
    body: `${person()}
      <h1>Continue to Tidewater Studio as Mara?</h1>
      <div class="group-label">License for this device</div>
      ${chosen("Tidewater Studio Pro", "Lifetime · this Mac becomes device 3 of 3")}
      <div class="group-label">Tidewater Studio will also get</div>
      <div class="items">
        <div class="item">${I.cloud}<div class="in">Cloud Sync</div><div class="im">Your presets, templates and preferences</div></div>
        <div class="item">${I.user}<div class="in">Your profile and email</div><div class="im">Mara Fennick, your picture · mara@fennick.studio</div></div>
      </div>
      <p class="small">It gets its own id for you, and won't see your other products or how you sign in.</p>
      ${btn("primary", "Continue to Tidewater Studio")}
      ${btn("ghost", "Cancel")}`,
    foot: footer("Tidewater Studio", "Harbor Audio"),
  });

  // 08 Zero licenses, the product auto-issues: the new license is shown and minted only on the primary
  F({
    id: "08-choice-new",
    head: appHeader({
      icon: "saltwind",
      app: "Saltwind",
      dev: "Tern Works",
      where: "on Mara's iPhone",
      whereIcon: "phone",
    }),
    body: `${person()}
      <h1>Choose a license for this device</h1>
      <p class="lede">You don't have a Saltwind license yet. Tern Works gives you this one.</p>
      ${lic({ name: "Saltwind", tier: "Free", meta: "Created when you continue", used: 1, limit: 2, noMeter: true, sel: true, tag: "New", tagKind: "new" })}
      ${btn("primary", "Use this license and continue")}
      ${quiet(true)}`,
    foot: footer("Saltwind", "Tern Works"),
  });

  // 09 Every paid license full: no New row, nothing preselected; Replace a device is the way in
  F({
    id: "09-choice-all-full",
    head: appHeader({
      icon: "tidewater",
      app: "Tidewater Studio",
      dev: "Harbor Audio",
      where: "on Mara's MacBook Pro",
      whereIcon: "laptop",
    }),
    body: `${person()}
      <h1>Choose a license for this device</h1>
      <div class="notice warn">${I.warn}<span>Your licenses are on all their devices. Replace a device to use one here.</span></div>
      <div style="display:flex;flex-direction:column;gap:10px">
      ${lic({ name: "Tidewater Studio", tier: "Pro", meta: "Bought from Harbor Audio · Lifetime", used: 3, limit: 3, ...FULL })}
      ${lic({ name: "Tidewater Studio", tier: "Edu", meta: "Added with a key · Until 12 Jun 2027", used: 2, limit: 2, ...FULL })}
      </div>
      ${btn("primary disabled", "Use this license and continue")}
      ${quiet(true)}`,
    foot: footer("Tidewater Studio", "Harbor Audio"),
  });

  // 10 Licence-key on-ramp, before sign-in, entries remaining (app sent the person)
  F({
    id: "10-key-onramp",
    head: appHeader({
      icon: "nightfall",
      app: "Nightfall",
      dev: "Lanternworks",
      where: "on Mara's PC",
      whereIcon: "desktop",
    }),
    body: `<div class="keycard"><div class="icon">${art.nightfall}</div><div style="flex:1"><div class="ln" style="color:var(--pk-text-strong);font-weight:500">Nightfall · Standard</div><div class="small mono">pkey_nightfall_…Tz4g</div></div><span class="tag new">${"Key works"}</span></div>
      <h1>Keep Nightfall in an account</h1>
      <div><div class="segs"><i class="used"></i><i class="used"></i><i class="used"></i><i></i><i></i></div><div class="help">2 of 5 key entries left · This will be entry 3</div></div>
      ${field("Email", "")}
      ${btn("primary", "Create account")}
      <div class="or">or</div>
      ${providers(["Google", "Steam"])}
      ${btn("ghost", "Skip for now")}
      <p class="small center">Already have an account? <span class="link">Sign in</span></p>`,
    foot: footer("Nightfall", "Lanternworks"),
  });

  // 11 ReturnStep: a licence was just added or issued
  F({
    id: "11-return",
    head: appHeader({
      icon: "saltwind",
      app: "Saltwind",
      dev: "Tern Works",
      where: "on Mara's iPhone",
      whereIcon: "phone",
    }),
    body: `<div class="success-mark">${I.check}</div>
      <h1 class="center">Saltwind is yours</h1>
      <div class="prodrow"><div class="icon">${art.saltwind}</div><div style="flex:1"><div class="ln" style="color:var(--pk-text-strong);font-weight:500">Saltwind</div><div class="small">Free · in your library</div></div></div>
      ${btn("primary", "Return to Saltwind")}
      <p class="small center">Returning by itself in 3 s · <span class="link">Stay here</span></p>`,
    foot: footer("Saltwind", "Tern Works"),
  });

  // 12 Device code done
  F({
    id: "12-device-done",
    head: appHeader({
      icon: "driftkart",
      app: "Drift Kart",
      dev: "Pitlane Games",
      where: "on Living room TV",
      whereIcon: "tv",
    }),
    body: `<div class="success-mark">${I.tv}</div>
      <h1 class="center">Drift Kart is signed in on Living room TV</h1>
      <p class="lede center">Look at Living room TV: it continues by itself.</p>
      <div class="person"><div class="avatar">MF</div><div><div class="n">Mara Fennick</div><div class="e">Signed in with Steam · Drift Kart Season Pass</div></div></div>
      ${btn("secondary", "Sign the TV out")}`,
    foot: footer("Drift Kart", "Pitlane Games"),
  });

  // 13 Console: identifier-first, known operator chip
  F({
    id: "13-console",
    surface: "Console",
    body: `<h1>Sign in to the console</h1>
      <div class="chip"><div class="avatar">VZ</div><span>vlad@zaharia.dev</span><span class="ch link">Change</span></div>
      ${btn("primary", "Continue", "arrow")}
      <p class="small">Next: Pocket ID at id.zaharia.dev</p>
      <div class="or">or</div>
      ${btn("secondary", `<span class="acc" style="color:var(--pk-accent-fg)">${I.passkey.replace("<svg", '<svg width="18" height="18"')}</span> Sign in with a passkey`)}`,
  });

  // 14 Console: session ended in place
  F({
    id: "14-console-session-ended",
    surface: "Console",
    body: `<h1>Your session ended</h1>
      <p class="lede">Sign in again to carry on. Your unsaved changes stay in this tab.</p>
      <div class="chip"><div class="avatar">VZ</div><span>vlad@zaharia.dev</span><span class="ch link">Change</span></div>
      ${btn("primary", "Continue", "arrow")}
      <p class="small">Next: Pocket ID at id.zaharia.dev</p>`,
  });

  // 15 Worker page: expired or used code or link (no JS)
  F({
    id: "15-expired",
    body: `<h1>That code or link has expired</h1>
      <p class="lede">Codes and links work once, for 10 minutes.</p>
      ${btn("primary", "Send a new code")}
      <p class="small center">We'll send it to m•••@fennick.studio · <span class="link">Use a different email</span></p>`,
  });

  // 16 Identity off: the friendly card, methods still work for the library
  F({
    id: "16-identity-off",
    head: contextHeader({
      icon: "mossgarden",
      product: "Mossgarden",
      dev: "Little Fern",
      line: "Your license, downloads and devices",
    }),
    body: `<div class="notice info">${I.info}<span>Mossgarden doesn't use Polaris Key sign-in. Open Mossgarden and enter your license key there.</span></div>
      <h1>Sign in</h1>
      <p class="lede">Sign in here to see Mossgarden in your library.</p>
      ${field("Email", "")}
      ${btn("primary", "Continue", "arrow")}
      <div class="or">or</div>
      ${providers(["Apple", "Google", "Steam"])}`,
  });

  // 17 Sign in with another device: the new browser shows a code, a signed-in device approves
  F({
    id: "17-another-device",
    body: `<h1>Sign in with another device</h1>
      <p class="lede">On a phone or computer where you're signed in to Polaris Key, scan the code, or open Account → Approve a new device and type it.</p>
      <div style="display:flex;gap:18px;align-items:center;flex-wrap:wrap">${qr(11)}<div><div class="bigcode">KRQP-BMXD</div><div class="small">Works for 4:52</div></div></div>
      <div class="notice info"><span class="spinner"></span><span>Waiting for you to approve it on the other device…</span></div>
      ${btn("ghost", "Use another way to sign in")}`,
  });

  // 18 Kit: native LicenseChoice after a native Apple sign-in (I-13 `choose`), product as hero
  F({
    id: "18-kit-choice",
    kit: true,
    body: `<div class="phead hero"><div class="icon">${art.saltwind}</div>Saltwind</div>
      <div class="who">Signed in as Mara Fennick · <span class="link">Not you?</span></div>
      <h1>Choose a license for this device</h1>
      <p class="lede">Saltwind will use it on Mara's iPhone.</p>
      ${lic({ name: "Saltwind", tier: "Pro", meta: "Bought on the App Store · Yearly, until 2 Feb 2027", used: 1, limit: 3, sel: true })}
      ${lic({ name: "Saltwind", tier: "Free", meta: "Created when you signed in", used: 2, limit: 2, full: true, tag: "No free devices", tagKind: "warn", act: `<div class="btn secondary inline">Replace a device</div>` })}
      <div style="flex:1"></div>
      ${btn("primary", "Use this license and continue")}
      <p class="small center">Polaris Key signs you in for Saltwind. Tern Works never sees your codes or passkeys.</p>`,
  });

  // 19 Every license full on an auto-issue product: Create a new free license is explicit, never preselected
  F({
    id: "19-choice-create",
    head: appHeader({
      icon: "saltwind",
      app: "Saltwind",
      dev: "Tern Works",
      where: "on Mara's iPad",
      whereIcon: "phone",
    }),
    body: `${person()}
      <h1>Choose a license for this device</h1>
      <div class="notice warn">${I.warn}<span>Your licenses are on all their devices. Replace a device, or create a new free license.</span></div>
      <div role="radiogroup" aria-label="Licenses for Saltwind" style="display:flex;flex-direction:column;gap:10px">
      ${lic({ name: "Saltwind", tier: "Free", meta: "Created when you signed in", used: 2, limit: 2, ...FULL })}
      ${lic({ name: "Create a new free license", tier: "Free", used: 1, limit: 2, noMeter: true, meta: "A separate license · created when you continue", tag: "New", tagKind: "new" })}
      </div>
      ${btn("primary disabled", "Use this license and continue")}
      ${quiet(false)}`,
    foot: footer("Saltwind", "Tern Works"),
  });

  // 20 No license in this account, no auto-issue: the key is taken inline; never a dead end
  F({
    id: "20-choice-none",
    head: appHeader({
      icon: "nightfall",
      app: "Nightfall",
      dev: "Lanternworks",
      where: "on Mara's PC",
      whereIcon: "desktop",
    }),
    body: `${person()}
      <h1>No Nightfall license in this account</h1>
      <p class="lede">Bought it with another email? Sign in with that account instead.</p>
      ${field("License key", "", { ph: '<span class="mono">pkey_nightfall_…</span>', help: "Paste the key from your receipt email." })}
      ${btn("primary", "Add and use on this device")}
      ${btn("secondary", "Get Nightfall")}
      <div class="links"><span class="link">Use another account</span><span>Cancel</span></div>`,
    foot: footer("Nightfall", "Lanternworks"),
  });

  // 21 Device already runs on a license the account doesn't hold: Keep, never naming it (P1-07)
  F({
    id: "21-choice-keep",
    head: appHeader({
      icon: "driftkart",
      app: "Drift Kart",
      dev: "Pitlane Games",
      where: "on Living room TV",
      whereIcon: "tv",
      code: "WDJB-MJHT",
    }),
    body: `${person()}
      <h1>Choose a license for this device</h1>
      <p class="lede">Drift Kart will use it on Living room TV.</p>
      <div role="radiogroup" aria-label="Licenses for Drift Kart" style="display:flex;flex-direction:column;gap:10px">
      ${lic({ name: "Keep the license this device uses", meta: "Drift Kart keeps running as it does now.", sel: true })}
      ${lic({ name: "Drift Kart", tier: "Season Pass", meta: "Bought on Steam · Until 1 Mar 2027", used: 1, limit: 3 })}
      </div>
      ${btn("primary", "Use this license and continue")}
      ${quiet(false)}`,
    foot: footer("Drift Kart", "Pitlane Games"),
  });

  // 22 A seat license and an Account-wide license for one product (owner vocabulary, O-11): the
  // seat license hides its device counter; the Account-wide row reads "unlimited devices".
  F({
    id: "22-choice-account-wide",
    head: appHeader({
      icon: "storytime",
      app: "Storytime",
      dev: "Bramble Books",
      where: "on Mara's iPad",
      whereIcon: "phone",
    }),
    body: `${person()}
      <h1>Choose a license for this device</h1>
      <p class="lede">Storytime will use it on Mara's iPad.</p>
      <div role="radiogroup" aria-label="Licenses for Storytime" style="display:flex;flex-direction:column;gap:10px">
      ${lic({ name: "Storytime", tier: "Standard", meta: "Bought on the App Store · Lifetime", used: 1, limit: 5, hideCount: true, sel: true })}
      ${lic({ name: "Storytime", tier: "Standard", accountWide: true, meta: "Created when you signed in · Lifetime" })}
      </div>
      ${btn("primary", "Use this license and continue")}
      ${quiet(false)}`,
    foot: footer("Storytime", "Bramble Books"),
  });

  // ---------- render ----------
  const board = document.getElementById("board");
  for (const f of frames) {
    if (only && !f.id.startsWith(only)) continue;
    for (const size of ["desktop", "phone"]) {
      const el = document.createElement("section");
      el.className = `screen ${size} ${f.kit ? "kit" : ""} ${f.head ? "app" : ""}`;
      el.setAttribute("data-shot", `${f.id}-${size}`);
      if (f.kit) {
        el.innerHTML =
          size === "phone"
            ? `<div class="statusbar"><span>9:41</span><span>●●● ▮</span></div><div class="sheet"><div class="grab"></div>${f.body}</div>`
            : `${stars(1440, 900)}<div class="card" style="margin-top:40px"><div class="body">${f.body}</div></div>`;
      } else {
        el.innerHTML = `${size === "desktop" ? stars(1440, 1100) : ""}${lockup(f.surface)}<div class="card">${f.head || ""}<div class="body">${f.body}</div>${f.foot || ""}</div>${below}`;
      }
      board.appendChild(el);
    }
  }
})();
