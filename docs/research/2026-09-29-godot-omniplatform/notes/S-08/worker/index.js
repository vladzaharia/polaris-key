import { WorkflowEntrypoint } from "cloudflare:workers";
import zenc from "./zenc.wasm";
import { makeEncoder } from "./zenc.mjs";

const log = []; // in-isolate event log, read back via /log
const note = (e) => {
  log.push({ t: Date.now(), ...e });
};

async function* bodyChunks(obj) {
  const r = obj.body.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) return;
    yield value;
  }
}
async function fillFrom(env, key) {
  return async (put) => {
    const o = await env.BLOBS.get(key);
    let off = 0;
    for await (const c of bodyChunks(o)) {
      put(off, c);
      off += c.length;
    }
  };
}

// Encode from -> to inside this isolate, streaming both from R2, write the frame to R2. Optionally verify.
export async function encodePair(
  env,
  {
    from,
    to,
    level = 19,
    clog = 0,
    hlog = 0,
    wlog = 0,
    ldm = -1,
    verify = true,
    outKey,
  },
) {
  const hf = await env.BLOBS.head(from),
    ht = await env.BLOBS.head(to);
  if (!hf || !ht) throw new Error("missing input");
  const enc = makeEncoder(zenc);
  const parts = [];
  const t0 = Date.now();
  const r = await enc.encode({
    prefixLen: hf.size,
    fillPrefix: await fillFrom(env, from),
    srcLen: ht.size,
    srcChunks: bodyChunks(await env.BLOBS.get(to)),
    level,
    clog,
    hlog,
    wlog,
    ldm,
    onOut: async (u) => {
      parts.push(u);
    },
  });
  const t1 = Date.now();
  const frame = new Uint8Array(r.outBytes);
  let o = 0;
  for (const p of parts) {
    frame.set(p, o);
    o += p.length;
  }
  await env.BLOBS.put(outKey, frame, {
    sha256: await crypto.subtle.digest("SHA-256", frame),
  });
  const res = {
    from,
    to,
    fromSize: hf.size,
    toSize: ht.size,
    ...r,
    encodeMsInIsolate: t1 - t0,
  };
  if (verify) {
    const dec = makeEncoder(zenc); // fresh instance: the encoder's bump heap is not reused
    const ds = new crypto.DigestStream("SHA-256");
    const w = ds.getWriter();
    const v = await dec.decode({
      prefixLen: hf.size,
      fillPrefix: await fillFrom(env, from),
      frameChunks: [frame],
      wlm: 30,
      onOut: async (u) => {
        await w.write(u);
      },
    });
    await w.close();
    const got = new Uint8Array(await ds.digest);
    const want = new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        await (await env.BLOBS.get(to)).arrayBuffer(),
      ),
    );
    res.verify = {
      ...v,
      ok: got.every((b, i) => b === want[i]) && v.outBytes === ht.size,
    };
  }
  return res;
}

export class DeltaWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const p = event.payload;
    note({ wf: event.instanceId, phase: "start", attempt: p.attempt ?? 0 });
    const plan = await step.do("plan", async () => {
      const hf = await this.env.BLOBS.head(p.from),
        ht = await this.env.BLOBS.head(p.to);
      const existing = await this.env.BLOBS.head(p.outKey);
      return {
        fromSize: hf?.size ?? -1,
        toSize: ht?.size ?? -1,
        exists: !!existing,
      };
    });
    if (plan.exists) {
      note({ wf: event.instanceId, phase: "skip-exists" });
      return { skipped: true };
    }
    let flaky = 0;
    const res = await step.do(
      "encode",
      {
        retries: { limit: 2, delay: "1 second", backoff: "constant" },
        timeout: "15 minutes",
      },
      async () => {
        if (p.failFirst && flaky++ === 0) {
          note({ wf: event.instanceId, phase: "encode-throw" });
          throw new Error("injected");
        }
        const r = await encodePair(this.env, p);
        note({
          wf: event.instanceId,
          phase: "encoded",
          bytes: r.outBytes,
          ok: r.verify?.ok,
        });
        return {
          outBytes: r.outBytes,
          memBytes: r.memBytes,
          verified: r.verify?.ok ?? null,
        };
      },
    );
    await step.do("record", async () => {
      note({ wf: event.instanceId, phase: "record" });
      return true;
    });
    return res;
  }
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    try {
      if (u.pathname === "/put") {
        // body -> R2 key
        const k = u.searchParams.get("key");
        await env.BLOBS.put(k, req.body);
        return Response.json({ k, size: (await env.BLOBS.head(k)).size });
      }
      if (u.pathname === "/encode")
        return Response.json(await encodePair(env, await req.json()));
      if (u.pathname === "/send") {
        const b = await req.json();
        await env.DELTA_QUEUE.sendBatch(b.map((body) => ({ body })));
        return Response.json({ sent: b.length });
      }
      if (u.pathname === "/log") return Response.json(log);
      if (u.pathname === "/wf") {
        const i = await env.DELTA_WORKFLOW.get(u.searchParams.get("id"));
        return Response.json({ id: i.id, status: await i.status() });
      }
      if (u.pathname === "/wfcreate") {
        // probe duplicate-id semantics
        const id = u.searchParams.get("id");
        const out = [];
        for (let k = 0; k < 2; k++) {
          try {
            const i = await env.DELTA_WORKFLOW.create({
              id,
              params: { probe: k },
            });
            out.push({ ok: i.id });
          } catch (e) {
            out.push({ err: String(e) });
          }
        }
        try {
          const b = await env.DELTA_WORKFLOW.createBatch([
            { id, params: {} },
            { id: id + "-b", params: {} },
          ]);
          out.push({ batch: b.map((i) => i.id) });
        } catch (e) {
          out.push({ batchErr: String(e) });
        }
        return Response.json(out);
      }
      if (u.pathname === "/mem") {
        // does local workerd enforce 128 MB?
        const mb = +u.searchParams.get("mb");
        const m = new WebAssembly.Memory({ initial: 1 });
        m.grow(Math.ceil(mb * 16));
        new Uint8Array(m.buffer).fill(1);
        return Response.json({ grownMB: m.buffer.byteLength / 1048576 });
      }
      if (u.pathname === "/spin") {
        const ms = +u.searchParams.get("ms");
        const t = performance.now();
        let x = 0;
        const e = Date.now();
        while (performance.now() - t < ms) {
          x++;
          if (x % 1e6 === 0) await null;
        }
        return Response.json({
          x,
          perfDelta: performance.now() - t,
          dateDelta: Date.now() - e,
        });
      }
      return new Response("not found", { status: 404 });
    } catch (e) {
      return Response.json(
        { error: String(e), stack: e.stack },
        { status: 500 },
      );
    }
  },
  async queue(batch, env) {
    for (const m of batch.messages) {
      const b = m.body;
      note({
        q: batch.queue,
        id: m.id,
        attempts: m.attempts,
        kind: b.kind ?? (b.action ? "r2-event" : "?"),
      });
      if (batch.queue.endsWith("-dlq")) {
        m.ack();
        continue;
      }
      if (b.kind === "poison") {
        m.retry();
        continue;
      }
      if (b.kind === "throw") throw new Error("consumer throws");
      // R2 event notification shape -> derive pair (here the message carries from/to directly or via object key)
      const p = b.action
        ? {
            from: b.object.key.replace(/rc5/, "rc4"),
            to: b.object.key,
            outKey: "deltas/" + b.object.key + ".pf.zst",
            level: 19,
          }
        : b;
      const id = ("delta-" + p.from + "-" + p.to)
        .replace(/[^A-Za-z0-9_-]/g, "_")
        .slice(0, 100);
      try {
        await env.DELTA_WORKFLOW.create({ id, params: p });
        note({ q: batch.queue, created: id });
      } catch (e) {
        note({ q: batch.queue, dup: id, err: String(e).slice(0, 200) });
      }
      m.ack();
    }
  },
};
