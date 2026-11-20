"""Real isolated socket and detached-process controls, never application mocks."""
import http.server
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.request

stage = sys.argv[1]
mode = os.environ['CONTROL_MODE']
attempt = int(os.environ['attempt'])
if stage == 'prepare':
    print(os.environ['SECRET_SENTINEL'], flush=True)
    if os.environ.get('WRITE_SERVICE_FILES'):
        # A real child writes directly to service files, outside stdout capture.
        # This path is independently checked against the PM2 configuration.
        subprocess.run([sys.executable, '-c', '''from pathlib import Path
import os
value = os.environ['SECRET_SENTINEL']
Path('logs').mkdir(exist_ok=True)
for name in ('logs/yjs-server.log', 'client/logs/startup.log',
             'server/logs/startup.log', 'firebase-debug.log'):
    path = Path(name)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value)
'''], check=True, timeout=2)
    # Deliberately detached and TERM-resistant: the subreaper must reap it.
    child = subprocess.Popen([sys.executable, '-c',
        'import signal,time;signal.signal(signal.SIGTERM,signal.SIG_IGN);time.sleep(60)'],
        start_new_session=True)
    with Path('owned.pids').open('a') as out:
        out.write(str(child.pid) + '\n')
    if mode == 'pre':
        time.sleep(60)
    if mode in ('recover', 'late') and attempt == 1:
        time.sleep(.7)
        sys.exit(7)
    if mode == 'failure':
        sys.exit(7)
elif stage == 'ready':
    # Listen on a real ephemeral port and independently probe HTTP readiness.
    server = http.server.HTTPServer(('127.0.0.1', 0), http.server.SimpleHTTPRequestHandler)
    import threading
    threading.Thread(target=server.serve_forever, daemon=True).start()
    with urllib.request.urlopen('http://127.0.0.1:' + str(server.server_port), timeout=1) as response:
        assert response.status == 200
    Path('ready').write_text(str(attempt))
    server.shutdown()
elif stage == 'finish':
    if mode in ('post', 'late'):
        time.sleep(60)
