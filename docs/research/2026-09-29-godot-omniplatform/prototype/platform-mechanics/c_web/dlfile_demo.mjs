// S-05 (c): HTTPRequest.download_file on web deletes the downloaded file (4.7.2). One page load per
// browser with dlfile=1; prints what the probe saw. Needs `node server.mjs` running.
import { chromium, webkit } from "playwright-core";
const base = "http://localhost:8765";
for (const [name, bt] of process.argv[2] === "webkit"
  ? [["webkit", webkit]]
  : process.argv[2] === "chromium"
    ? [["chromium", chromium]]
    : [
        ["chromium", chromium],
        ["webkit", webkit],
      ]) {
  const b = await bt.launch({ headless: true });
  const p = await (await b.newContext()).newPage();
  const before = (await (await fetch(base + "/_reports")).json()).length;
  await p.goto(
    `${base}/?mode=idb&n=1&set=w1&run=dlfile&dlfile=1&chunk=4194304`,
  );
  let rep;
  for (let i = 0; i < 400 && !rep; i++) {
    const rs = await (await fetch(base + "/_reports")).json();
    if (rs.length > before) rep = JSON.parse(rs[rs.length - 1]);
    else await new Promise((r) => setTimeout(r, 250));
  }
  console.log(
    name,
    JSON.stringify({
      downloads: rep?.downloads,
      dbg: rep?.dbg,
      mounts: rep?.mounts,
      files_user: rep?.files_user,
    }),
  );
  await b.close();
}
