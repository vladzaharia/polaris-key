# Tauri recipe

The gate in a Tauri v2 window, on the Tidewater fixtures.

- `src/`, `index.html`: the Vite front end. It builds and is linted like the other recipes.
- `src-tauri/`: a reference shell, committed and **not compiled in CI**. Its one permission is
  `opener:allow-open-url` for `https://*` (`capabilities/default.json`); no shell, fs or http.
  Crates are pinned to exact versions.
- The Rust bridge is not shipped (UK-21 is parked). Until it is, the elements run on fixtures,
  or live over `fetch` with a Worker.

Run it with the Tauri CLI (`cargo install tauri-cli --version "^2" --locked`, then
`cargo tauri dev` in this folder). Nothing here needs a Rust toolchain to build the front end.
