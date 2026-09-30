# Tiny static server with Range and ETag support, for Obtainium's "Partial APK hash" and "ETag"
# versioning (python3 -m http.server has neither).  python3 range-server.py <dir> <port>
import http.server, os, re, sys, hashlib
ROOT = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def _file(self):
        p = os.path.join(ROOT, os.path.basename(self.path.split('?')[0]))
        return p if os.path.isfile(p) else None
    def _hdr(self, p, code, start, end, size):
        self.send_response(code)
        self.send_header('Content-Type', 'application/vnd.android.package-archive')
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('ETag', '"%x-%x"' % (size, int(os.path.getmtime(p))))
        self.send_header('Content-Length', str(end - start + 1))
        if code == 206: self.send_header('Content-Range', 'bytes %d-%d/%d' % (start, end, size))
        self.end_headers()
    def _serve(self, body):
        p = self._file()
        if not p: self.send_error(404); return
        size = os.path.getsize(p); start, end, code = 0, size - 1, 200
        m = re.match(r'bytes=(\d*)-(\d*)', self.headers.get('Range', ''))
        if m:
            code = 206
            if m.group(1): start = int(m.group(1)); end = int(m.group(2)) if m.group(2) else size - 1
            else: start = size - int(m.group(2))
            end = min(end, size - 1)
        self._hdr(p, code, start, end, size)
        if body:
            with open(p, 'rb') as f:
                f.seek(start); self.wfile.write(f.read(end - start + 1))
    def do_HEAD(self): self._serve(False)
    def do_GET(self): self._serve(True)
http.server.ThreadingHTTPServer(('127.0.0.1', int(sys.argv[2])), H).serve_forever()
