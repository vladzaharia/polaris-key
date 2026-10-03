#!/usr/bin/env python3
"""P5-07 end-to-end feed server (from notes/S-11's server.py).

    python3 server.py <port> <root> <log>

Serves <root> on 127.0.0.1:<port> and appends one JSON line per request to <log>: method, path,
status, Authorization, User-Agent and Range, so a run can assert that the bearer reached the feed
and the bytes.

Two routes stand in for the Worker's:

  GET /velopack/<FileName>   for a FileName the feed lists (<root>/velopack/redirects.json, written
                             by gen_feeds.mts from the Worker's own Velopack code), a 302 to the
                             package's delivery URL; anything else, or a name that is not one plain
                             .nupkg segment, a 404. This is what the Worker's
                             /<p>/update/<channel>/velopack/<FileName> route answers. The feed,
                             /velopack/releases.<channel>.json, is served from <root>/velopack/;
                             /bytes/<path> serves <root>/<path> (the "bytes host").
  GET /redir/<host:port>/<path>  a 302 to http://<host:port>/<path> (a cross-origin redirect).
"""
import http.server
import json
import os
import re
import sys
import time


# The Worker's isVelopackFileName (updaterFeeds.ts): one plain .nupkg file-name segment.
VELOPACK_FILE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}\.nupkg$")


def velopack_redirects():
    """FileName -> delivery URL for every package the Velopack feed lists (gen_feeds.mts)."""
    try:
        with open(os.path.join(ROOT, "velopack", "redirects.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _log(self, code):
        with open(LOG, "a") as f:
            f.write(json.dumps({
                "t": round(time.time(), 3),
                "port": self.server.server_port,
                "method": self.command,
                "path": self.path,
                "status": code,
                "auth": self.headers.get("Authorization"),
                "ua": self.headers.get("User-Agent"),
                "range": self.headers.get("Range"),
            }) + "\n")

    def _redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()
        self._log(302)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path.startswith("/redir/"):
            _, _, hostport, rest = self.path.split("/", 3)
            return self._redirect(f"http://{hostport}/{rest}")
        if path.startswith("/velopack/") and path.endswith(".nupkg"):
            name = path[len("/velopack/"):]
            target = velopack_redirects().get(name)
            if target is None or not VELOPACK_FILE.match(name) or ".." in name:
                self.send_error(404)
                self._log(404)
                return
            return self._redirect(target)
        if path.startswith("/bytes/"):
            self.path = self.path[len("/bytes"):]
        exists = os.path.exists(self.translate_path(self.path))
        self._log(200 if exists else 404)
        super().do_GET()

    def do_HEAD(self):
        self._log(0)
        super().do_HEAD()


if __name__ == "__main__":
    PORT = int(sys.argv[1])
    ROOT = os.path.abspath(sys.argv[2])
    LOG = os.path.abspath(sys.argv[3])
    os.chdir(ROOT)
    http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
