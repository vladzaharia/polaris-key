#!/usr/bin/env python3
"""S-11 static server for the feeds: logs method, path, Authorization, User-Agent, Range as JSON.
/redir/<host:port>/<path> answers 302 to http://<host:port>/<path> (cross-origin redirect probe)."""
import http.server, json, sys, time, os
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def _log(self, code):
        with open(os.environ.get("SRV_LOG", "srv.log"), "a") as f:
            f.write(json.dumps({"t": round(time.time(), 3), "port": self.server.server_port, "m": self.command, "path": self.path, "code": code,
                "auth": self.headers.get("Authorization"), "ua": self.headers.get("User-Agent"), "range": self.headers.get("Range")}) + "\n")
    def do_GET(self):
        if self.path.startswith("/redir/"):
            _, _, hp, rest = self.path.split("/", 3)
            self.send_response(302); self.send_header("Location", f"http://{hp}/{rest}"); self.end_headers(); self._log(302); return
        self._log(200 if os.path.exists(self.translate_path(self.path)) else 404)
        super().do_GET()
    def do_HEAD(self):
        self._log(0); super().do_HEAD()
port = int(sys.argv[1]); os.chdir(sys.argv[2])
http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
