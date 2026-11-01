#!/usr/bin/env python3
"""A throttled loopback server for export_check.sh's background-transfer run (U-41.6b).

usage: bulk_server.py <port> <log file>

Accepts PUT /<product>/sync/files/<collection>/<record>/upload/<id>/parts/<n> and answers 204. It reads the body
in small steps so that a 30 MiB upload takes long enough to press Home meanwhile. The log gets one line per event:
START <n> (the body began), PART <n> <bytes> (the body arrived whole), BAD <why> (no bearer, or a path that is not a
file route). No credential is written to the log.
"""
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT, LOG = int(sys.argv[1]), sys.argv[2]
ROUTE = re.compile(r"^/[A-Za-z0-9._-]+/sync/files/[A-Za-z0-9._:-]+/[A-Za-z0-9._:-]+/upload/[A-Za-z0-9._:-]+/parts/([0-9]{1,4})$")
lock = threading.Lock()


def log(line: str) -> None:
    with lock, open(LOG, "a") as f:
        f.write(line + "\n")


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_PUT(self) -> None:
        m = ROUTE.match(self.path)
        n = int(m.group(1)) if m else 0
        if not m:
            log("BAD path")
        if not (self.headers.get("Authorization") or "").startswith("Bearer "):
            log("BAD bearer")
        total = int(self.headers.get("Content-Length", "0"))
        log("START %d" % n)
        got = 0
        while got < total:
            chunk = self.rfile.read(min(65536, total - got))
            if not chunk:
                break
            got += len(chunk)
            time.sleep(0.03)
        log("PART %d %d" % (n, got))
        self.send_response(204)
        self.send_header("ETag", '"p%d"' % n)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, *a) -> None:
        pass


ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
