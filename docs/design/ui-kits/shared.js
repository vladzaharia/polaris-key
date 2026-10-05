// Shared helpers for the UI-kit mockups (docs/design/ui-kits/*.html).
// Mockups only: icons, a deterministic fake QR, product art and the theme switch.
// The theme comes from ?theme=dark|light and is written to <html data-theme>, so the
// generated @polaris-key/brand tokens (packages/brand/css/tokens.css) do the rest.

(function () {
  const params = new URLSearchParams(location.search);
  const theme = params.get("theme") === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  window.PK_THEME = theme;

  // Lucide-style 24px stroke icons (the kits ship Material Symbols on Android, SF Symbols on
  // Apple, and this set on web, desktop and Godot).
  const P = {
    key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
    laptop:
      '<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>',
    monitor:
      '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/>',
    phone:
      '<rect width="14" height="20" x="5" y="2" rx="3"/><path d="M11 18h2"/>',
    tablet:
      '<rect width="16" height="20" x="4" y="2" rx="2.5"/><path d="M11 18h2"/>',
    gamepad:
      '<path d="M6 11h4M8 9v4M15 12h.01M18 10h.01"/><path d="M17.32 5H6.68a4 4 0 0 0-3.98 3.59C2.6 9.42 2 14.46 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.41-1.41A2 2 0 0 1 9.83 16h4.34a2 2 0 0 1 1.41.59L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.54-.6-6.58-.69-7.26A4 4 0 0 0 17.32 5z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    alert:
      '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    arrowLeft: '<path d="m12 19-7-7 7-7M19 12H5"/>',
    arrowRight: '<path d="M5 12h14M12 5l7 7-7 7"/>',
    external:
      '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    download:
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    refresh:
      '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    user: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
    cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
    cloudCheck:
      '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/><path d="m9.5 14 2 2 3.5-3.5"/>',
    wifiOff:
      '<path d="M12 20h.01M8.5 16.43a5 5 0 0 1 7 0M2 8.82a15 15 0 0 1 4.17-2.65M10.66 5c4.01-.36 8.14.9 11.34 3.76M16.85 11.25a10 10 0 0 1 2.22 1.68M5 13a10 10 0 0 1 5.24-2.76M2 2l20 20"/>',
    globe:
      '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20"/>',
    shield:
      '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    sliders:
      '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
    logout:
      '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    update:
      '<circle cx="12" cy="12" r="10"/><path d="m16 12-4-4-4 4M12 16V8"/>',
    paste:
      '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
    qr: '<rect width="5" height="5" x="3" y="3" rx="1"/><rect width="5" height="5" x="16" y="3" rx="1"/><rect width="5" height="5" x="3" y="16" rx="1"/><path d="M21 16h-3a2 2 0 0 0-2 2v3M21 21v.01M12 7v3a2 2 0 0 1-2 2H7M3 12h.01M12 3h.01M12 16v.01M16 12h1M21 12v.01M12 21v-1"/>',
    mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    badge:
      '<path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/>',
    sparkle:
      '<path d="M12 3v3M12 18v3M3 12h3M18 12h3"/><circle cx="12" cy="12" r="3"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    flag: '<path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.33 2q2 0 3.67-.67a1 1 0 0 1 1.33.94v9.47a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.53"/>',
    play: '<path d="M6 4v16a1 1 0 0 0 1.52.85l13-8a1 1 0 0 0 0-1.7l-13-8A1 1 0 0 0 6 4z"/>',
    macmini:
      '<rect width="18" height="7" x="3" y="9" rx="2.5"/><path d="M7 19h10"/>',
    desktop:
      '<rect width="20" height="13" x="2" y="3" rx="2"/><path d="M8 21h8M12 16v5"/>',
    passkey:
      '<circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 11-5.7"/><circle cx="18" cy="14.5" r="2.5"/><path d="M18 17v5M18 19.5h2"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    bell: '<path d="M10.27 21a2 2 0 0 0 3.46 0M3.26 15.33A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.67C19.41 13.96 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.41 5.96-2.74 7.33"/>',
  };
  // Brand marks the platforms require (Sign in with Apple, Google) — drawn as the platform does.
  window.appleLogo = (s = 18) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M16.4 12.6c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8-1.6 0-3.1 1-4 2.4-1.7 3-.4 7.4 1.2 9.8.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.1-.8s1.9.8 3.2.8c1.3 0 2.1-1.2 2.9-2.4.9-1.4 1.3-2.7 1.3-2.8-.1 0-2.4-.9-2.4-3.9zM14 5.3c.7-.8 1.1-1.9 1-3-1 0-2.1.6-2.8 1.4-.6.7-1.2 1.8-1 2.9 1 .1 2.1-.5 2.8-1.3z"/></svg>`;
  window.googleG = (s = 18) =>
    `<svg width="${s}" height="${s}" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>`;

  // Determinate countdown ring (UI-KITS §1.5 rule 4): `left` is the fraction of the code's life left.
  window.countdown = (left = 0.78, s = 20, cls = "k-countdown") => {
    const r = (s - 2) / 2,
      c = 2 * Math.PI * r;
    return `<svg class="${cls}" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" aria-hidden="true"><circle class="track" cx="${s / 2}" cy="${s / 2}" r="${r}"/><circle class="left" cx="${s / 2}" cy="${s / 2}" r="${r}" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - left)).toFixed(2)}"/></svg>`;
  };

  window.icon = function (name, size = 20, extra = "") {
    return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${P[name] || ""}</svg>`;
  };

  // Product art is the developer's content: shown as supplied, never re-themed.
  const ART = {
    tidewater: (s) =>
      `<svg width="${s}" height="${s}" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" fill="#0b3a48"/><circle cx="46" cy="18" r="7" fill="#f5d38a"/><path d="M-2 40c6 0 7-6 13-6s7 6 13 6 7-6 13-6 7 6 13 6 7-6 13-6" stroke="#5fe3cf" stroke-width="5" fill="none" stroke-linecap="round"/><path d="M-2 51c6 0 7-6 13-6s7 6 13 6 7-6 13-6 7 6 13 6 7-6 13-6" stroke="#bff5ea" stroke-width="5" fill="none" stroke-linecap="round" opacity=".75"/></svg>`,
    driftkart: (s) =>
      `<svg width="${s}" height="${s}" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" fill="#ff5a2c"/><path d="M14 40h30l6-9H26l-4 5h-8z" fill="#1a0b06"/><circle cx="22" cy="44" r="5" fill="#1a0b06"/><circle cx="42" cy="44" r="5" fill="#1a0b06"/><path d="M8 24h18M4 31h14M10 17h12" stroke="#fff3e8" stroke-width="3.5" stroke-linecap="round"/></svg>`,
  };
  window.art = function (name, size) {
    return ART[name](size);
  };

  // A deterministic fake QR code (finder patterns + seeded noise). Mockup only.
  window.qr = function (size = 160, seed = 7, fg = "#060912", bg = "#ffffff") {
    const n = 29;
    let s = seed;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const cells = [];
    const finder = (x, y) => x < 7 && y < 7;
    const inF = (x, y) =>
      finder(x, y) || finder(n - 1 - x, y) || finder(x, n - 1 - y);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        if (inF(x, y)) continue;
        if (
          (x === 7 || y === 7 || x === n - 8 || y === n - 8) &&
          (x < 8 || x > n - 9) &&
          (y < 8 || y > n - 9)
        )
          continue;
        if (x === 6 || y === 6) {
          if ((x + y) % 2 === 0) cells.push([x, y]);
          continue;
        }
        if (rnd() > 0.52) cells.push([x, y]);
      }
    const f = (x, y) =>
      `<path d="M${x} ${y}h7v7h-7z M${x + 1} ${y + 1}v5h5v-5z" fill-rule="evenodd"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3"/>`;
    const q = 2;
    return `<svg class="qr" width="${size}" height="${size}" viewBox="${-q} ${-q} ${n + 2 * q} ${n + 2 * q}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect x="${-q}" y="${-q}" width="${n + 2 * q}" height="${n + 2 * q}" fill="${bg}"/><g fill="${fg}">${f(0, 0)}${f(n - 7, 0)}${f(0, n - 7)}${cells.map(([x, y]) => `<rect x="${x}" y="${y}" width="1" height="1"/>`).join("")}</g></svg>`;
  };

  // The Pinned K (display cut, no bit) for the optional Powered-by line only.
  window.pinnedK = function (size = 16) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 96 96" aria-hidden="true"><path fill="currentColor" d="M14 15.6 L35.6 5 Q37 4.3 37 6 L37 76 L14 87 Q13 87.5 13 86 L13 18 Q13 16.3 14 15.6 Z"/><path fill="currentColor" d="M41 44 L57 44 Q58 44 59 45 L81 67 Q82 68 81 69 L68 82 Q67 83 66 82 L41 57 Q40 56 40 55 L40 45 Q40 44 41 44 Z"/><path fill="currentColor" d="M64 6 L70 18 L82 24 L70 30 L64 42 L58 30 L46 24 L58 18 Z"/></svg>`;
  };

  // Fill every [data-icon], [data-art] and [data-qr] placeholder once the DOM is ready.
  function hydrate() {
    document.querySelectorAll("[data-icon]").forEach((el) => {
      el.innerHTML = icon(el.dataset.icon, +(el.dataset.size || 20));
    });
    document.querySelectorAll("[data-art]").forEach((el) => {
      el.innerHTML = art(el.dataset.art, +(el.dataset.size || 64));
    });
    document.querySelectorAll("[data-qr]").forEach((el) => {
      el.innerHTML = qr(+(el.dataset.size || 160), +(el.dataset.qr || 7));
    });
    document.querySelectorAll("[data-countdown]").forEach((el) => {
      el.innerHTML = countdown(
        +(el.dataset.countdown || 0.78),
        +(el.dataset.size || 20),
      );
    });
    document.querySelectorAll("[data-apple]").forEach((el) => {
      el.innerHTML = appleLogo(+(el.dataset.size || 18));
    });
    document.querySelectorAll("[data-google]").forEach((el) => {
      el.innerHTML = googleG(+(el.dataset.size || 18));
    });
    document.querySelectorAll("[data-k]").forEach((el) => {
      el.innerHTML = pinnedK(+(el.dataset.size || 14));
    });
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", hydrate);
  else hydrate();
})();
