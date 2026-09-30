// S-06 web probe: what an installed-PWA detector sees in a plain tab, a Chromium `--app` window and
// WebKit, and what the Trusted Web Activity referrer check reads. Needs `playwright` resolvable
// (npm i playwright) and its Chromium + WebKit builds.
//   node display-mode.mjs
import http from 'node:http';
import { chromium, webkit } from 'playwright';

const page = `<!doctype html><html><head>
<link rel="manifest" href="/manifest.webmanifest"><title>probe</title></head><body>probe</body></html>`;
const manifest = JSON.stringify({ name: 'probe', start_url: '/', display: 'standalone', icons: [] });
const server = http.createServer((req, res) => {
  if (req.url === '/manifest.webmanifest') {
    res.writeHead(200, { 'content-type': 'application/manifest+json' });
    res.end(manifest);
  } else {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page);
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const readSignals = () => ({
  standalone: matchMedia('(display-mode: standalone)').matches,
  browser: matchMedia('(display-mode: browser)').matches,
  minimalUi: matchMedia('(display-mode: minimal-ui)').matches,
  fullscreen: matchMedia('(display-mode: fullscreen)').matches,
  windowControlsOverlay: matchMedia('(display-mode: window-controls-overlay)').matches,
  navigatorStandalone: 'standalone' in navigator ? navigator.standalone : 'absent',
  getInstalledRelatedApps: typeof navigator.getInstalledRelatedApps,
  referrer: document.referrer,
  userAgent: navigator.userAgent,
});

const rows = [];
async function record(label, pageObj, version) {
  rows.push({ label, version, ...(await pageObj.evaluate(readSignals)) });
}

// 1. Chromium, ordinary tab (headless shell)
{
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.goto(url);
  await record('chromium-tab', p, b.version());
  // 2. Referrer as a Trusted Web Activity would set it (emulated with a Referer header).
  await p.goto(url, { referer: 'android-app://com.example.twa/' });
  await record('chromium-tab-referrer-android-app', p, b.version());
  await b.close();
}
// 3. Chromium `--app=<url>` window (headed; the closest desktop stand-in for an installed app window)
{
  const ctx = await chromium.launchPersistentContext('', { headless: false, args: [`--app=${url}`] });
  await new Promise((r) => setTimeout(r, 1500));
  const p = ctx.pages().find((x) => x.url().startsWith(url)) ?? (await ctx.newPage());
  if (!p.url().startsWith(url)) await p.goto(url);
  await record('chromium-app-window', p, ctx.browser()?.version() ?? 'persistent');
  await ctx.close();
}
// 4. WebKit, ordinary tab
{
  const b = await webkit.launch();
  const p = await b.newPage();
  await p.goto(url);
  await record('webkit-tab', p, b.version());
  await b.close();
}
server.close();
for (const r of rows) console.log('WEB_PROBE_JSON ' + JSON.stringify(r));
