#!/usr/bin/env python3
"""A logging HTTPS stand-in for `xcrun ba-serve`, for the iOS simulator only.

`ba-serve` needs a TLS identity in the Mac's keychain. This server reads a PEM certificate and
key from files instead, so the only trust change is a root certificate added to one simulator
(`xcrun simctl keychain <udid> add-root-cert ca.pem`). It serves:

  GET /manifest?...      a download manifest made by `xcrun ba-package download-manifest create`
                         from the .aar files of the active version set;
  GET /assets/<pack-id>  that pack's .aar, honouring Range requests.

and logs every request (method, path, query, Range, bytes sent, duration) as one JSON line, so
bytes on the wire per pack update are measured at the server.

usage: serve.py --cert leaf.pem --key leaf.key --packs <dir-with-v1-and-v2> --log out.jsonl
                [--port 54985] [--host localhost]
Switch the served version set at runtime:  curl -sk https://localhost:54985/_set?version=2

This measures the local development path only. Apple's CDN (TestFlight/App Store) may behave
differently; see the S-01 note.
"""
import argparse, glob, json, os, re, ssl, subprocess, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

STATE = {"version": 1}
LOCK = threading.Lock()


def manifest(packs_dir, version, base):
    aars = sorted(glob.glob(os.path.join(packs_dir, f"v{version}", "*.aar")))
    with tempfile.TemporaryDirectory() as t:
        out = os.path.join(t, "m.json")
        subprocess.run(["xcrun", "ba-package", "download-manifest", "create", *aars,
                        "--asset-pack-versions", *[str(version)] * len(aars), "--ios",
                        "--download-base-url", base, "-o", out, "-q"], check=True)
        return open(out, "rb").read()


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _log(self, **kw):
        with LOCK, open(self.server.logpath, "a") as f:
            f.write(json.dumps(kw) + "\n")

    def do_HEAD(self):
        self.do_GET(head=True)

    def do_GET(self, head=False):
        t0 = time.time()
        u = urlparse(self.path)
        q = parse_qs(u.query)
        rng = self.headers.get("Range")
        sent, status = 0, 200
        if u.path == "/_set":
            STATE["version"] = int(q.get("version", ["1"])[0])
            body = json.dumps(STATE).encode()
            self._send(200, body, "application/json", head)
        elif u.path.rstrip("/").endswith("manifest"):
            base = f"https://{self.server.public_host}:{self.server.server_port}/assets"
            body = manifest(self.server.packs, STATE["version"], base)
            self._send(200, body, "application/json", head)
            sent = len(body)
        elif u.path.startswith("/assets/"):
            pid = u.path.split("/")[2]
            path = os.path.join(self.server.packs, f"v{STATE['version']}", f"{pid}.aar")
            if not os.path.exists(path):
                status = 404
                self._send(404, b"not found", "text/plain", head)
            else:
                size = os.path.getsize(path)
                start, end = 0, size - 1
                m = re.match(r"bytes=(\d*)-(\d*)$", rng or "")
                if m:
                    if m.group(1):
                        start = int(m.group(1))
                        end = int(m.group(2)) if m.group(2) else size - 1
                    else:
                        start = size - int(m.group(2))
                    status = 206
                n = end - start + 1
                self.send_response(status)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(n))
                self.send_header("Accept-Ranges", "bytes")
                if status == 206:
                    self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.end_headers()
                if not head:
                    with open(path, "rb") as f:
                        f.seek(start)
                        left = n
                        while left:
                            b = f.read(min(1 << 20, left))
                            self.wfile.write(b)
                            left -= len(b)
                            sent += len(b)
        else:
            status = 404
            self._send(404, b"not found", "text/plain", head)
        self._log(t=round(t0, 3), method=self.command, path=u.path, query=u.query, range=rng,
                  status=status, sent=sent, ms=round((time.time() - t0) * 1000, 1),
                  version=STATE["version"], ua=self.headers.get("User-Agent"))

    def _send(self, code, body, ctype, head):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head:
            self.wfile.write(body)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cert", required=True)
    ap.add_argument("--key", required=True)
    ap.add_argument("--packs", required=True)
    ap.add_argument("--log", required=True)
    ap.add_argument("--port", type=int, default=54985)
    ap.add_argument("--host", default="localhost")
    a = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), H)
    srv.packs, srv.logpath, srv.public_host = os.path.abspath(a.packs), a.log, a.host
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(a.cert, a.key)
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    print(f"serving https://{a.host}:{a.port}/ from {srv.packs}", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
