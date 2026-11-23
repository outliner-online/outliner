"""Proxy signed Ubuntu metadata but deterministically stall package bodies."""

import http.server
import time
import urllib.error
import urllib.request


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if self.path.endswith('.deb'):
            print('OBSERVED_FIRST_MIRROR_PACKAGE_STALL ' + self.path.rsplit('/', 1)[-1], flush=True)
            try:
                with urllib.request.urlopen('http://archive.ubuntu.com' + self.path, timeout=60) as response:
                    self.send_response(response.status)
                    self.send_header('Content-Length', response.headers['Content-Length'])
                    self.end_headers()
                    # Genuine upstream bytes keep APT's transport active, but
                    # can never complete before the production 150s supervisor.
                    while byte := response.read(1):
                        self.wfile.write(byte)
                        self.wfile.flush()
                        time.sleep(5)
            except (BrokenPipeError, ConnectionResetError):
                print('OBSERVED_FIRST_MIRROR_CLIENT_CLOSED', flush=True)
            return
        upstream = 'http://security.ubuntu.com' if 'resolute-security' in self.path else 'http://archive.ubuntu.com'
        try:
            response = urllib.request.urlopen(upstream + self.path, timeout=60)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read()
            self.send_response(response.status)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)


server = http.server.ThreadingHTTPServer(('0.0.0.0', 80), Handler)
server.daemon_threads = True
print('OBSERVED_FIRST_MIRROR_LISTENING', flush=True)
server.serve_forever()
