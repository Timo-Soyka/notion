#!/usr/bin/env python3
# Kleiner Entwicklungs-Server für die Oberfläche ohne Zwischenspeicher,
# damit Änderungen an den JS-Modulen sofort im Browser ankommen.
import http.server, functools, sys, os
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 5178
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web')
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
    def log_message(self, *a):
        pass
http.server.ThreadingHTTPServer(('127.0.0.1', PORT), functools.partial(H, directory=ROOT)).serve_forever()
