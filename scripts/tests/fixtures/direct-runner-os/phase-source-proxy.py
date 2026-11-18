"""Serve unchanged signed Ubuntu metadata; stall CLI-phase .deb acquisition."""

import http.server
import json
from pathlib import Path
import select
import time
import urllib.error
import urllib.request

log = Path('/tmp/nonroot-setup.log')
cache = {}


def event(name):
    print(json.dumps({'event': name, 'at': time.monotonic()}), flush=True)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        if (self.path.endswith('.deb') and log.exists()
                and 'Direct-runner stage: playwright-install-deps' in log.read_text()):
            event('PLAYWRIGHT_SOURCE_REQUEST')
            # Do not send a response. Independently observe that the real APT
            # client closes its connection when the acquisition is terminated.
            deadline = time.monotonic() + 300
            while time.monotonic() < deadline:
                if select.select([self.connection], [], [], .2)[0]:
                    if not self.connection.recv(1):
                        event('PLAYWRIGHT_SOURCE_CLIENT_CLOSED')
                        return
            event('PLAYWRIGHT_SOURCE_STILL_CONNECTED')
            return
        if self.path not in cache:
            try:
                response = urllib.request.urlopen('http://archive.ubuntu.com' + self.path, timeout=60)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                cache[self.path] = (response.status, response.read())
        status, body = cache[self.path]
        self.send_response(status)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


http.server.ThreadingHTTPServer.daemon_threads = True
server = http.server.ThreadingHTTPServer(('127.0.0.1', 18082), Handler)
event('SIGNED_PROXY_LISTENING')
server.serve_forever()
