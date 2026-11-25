"""Observe a real delayed BuildKit client without trusting action evidence."""

import json
from pathlib import Path
import socket
import sys
import time


events = Path(sys.argv[1])


def record(event):
    with events.open("a", encoding="utf-8") as output:
        output.write(json.dumps({"event": event, "at": time.monotonic()}) + "\n")
        output.flush()


server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(("0.0.0.0", 18083))
server.listen(1)
record("observer-ready")
connection, _ = server.accept()
connection.recv(4096)
record("build-started")
connection.sendall(b"HTTP/1.0 200 OK\r\nConnection: close\r\n\r\n")
connection.settimeout(0.2)
natural_deadline = time.monotonic() + 30
while time.monotonic() < natural_deadline:
    try:
        if connection.recv(1) == b"":
            record("client-closed")
            break
    except TimeoutError:
        pass
else:
    record("natural-completion")
connection.close()
server.close()
