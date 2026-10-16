# Examples

Runnable samples per SDK and host. Each is a standalone project that installs the SDK from Polaris
Key's package feed, not from this repository. Route the feed first: an npm sample's `.npmrc` holds
`@polaris-key:registry=https://pkg.plrs.im/npm/polaris-key/`, and the Python samples install
`polaris-key` from [the PyPI feed](https://key.plrs.im/docs/build/install/).

| Sample                               | Shows                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| [`node-express`](./node-express)     | Verifying a client's license on a backend with `@polaris-key/server/express`          |
| [`server-express`](./server-express) | A gated Express app: an entitlement, sign-in and a `/whoami` probe                    |
| [`server-hono`](./server-hono)       | The same on Hono (Workers, Bun, Deno, Node)                                           |
| [`server-next`](./server-next)       | The same as Next.js App Router route handlers                                         |
| [`node-cli`](./node-cli)             | A commander CLI with the full kit, sign-in and device-limit recovery                  |
| [`node-electron`](./node-electron)   | Electron main + preload + the React kit over the PolarisBridge                        |
| [`python-cli`](./python-cli)         | A product CLI that mounts the Polaris Key verbs and gates its own command on `boot()` |
| [`python-renpy`](./python-renpy)     | A Ren'Py splash-screen boot and a minimal activation screen                           |
| [`ui`](./ui)                         | The UI-kit samples hub: one runnable sample per kit                                   |

Other SDK samples live beside their SDK: `sdks/godot/examples/minimal` and `sdks/kotlin/samples/`.

`packages/sdk-node/test/examples.test.ts` checks that every name the Node samples import from
`@polaris-key/node` exists, and `sdks/python/tests/test_samples.py` compiles the Python samples, so
a rename fails the SDK's tests instead of the sample.
