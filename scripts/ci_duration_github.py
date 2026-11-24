"""GitHub REST transport for the scheduled CI duration monitor."""

from dataclasses import dataclass
from http.client import IncompleteRead
import json
import os
from pathlib import Path
import time
import threading
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from loguru import logger


class ReadBudgetExceeded(RuntimeError):
    """Required evidence was not completely read within the reserved window."""


def write_json(path: Path, value: object) -> None:
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


class ScanClient:
    def __init__(self, client, directory: Path | None, required_seconds: float, optional_seconds: float):
        self.client = client
        self.directory = directory
        self.started = time.monotonic()
        self.admission_deadline = self.started + required_seconds
        self.deadline = self.admission_deadline
        self.optional_seconds = optional_seconds
        self.stage = 'source-verification'
        self.phase_started = self.started
        self.phase_seconds = {}
        self.state = 'running'
        self.error = None
        self.last_request = None
        self.counts = {}
        self.checkpoint = lambda: None
        self._lock = threading.RLock()
        self.save()

    def save(self):
        with self._lock:
            try:
                self._save()
            except Exception as error:
                logger.warning('Scan progress unavailable ({}); continuing', type(error).__name__)

    def _save(self):
        if self.directory is not None:
            self.directory.mkdir(parents=True, exist_ok=True)
            write_json(self.directory / 'scan-progress.json', {
                'stage': self.stage, 'state': self.state, 'error_type': self.error,
                'elapsed_seconds': round(time.monotonic() - self.started, 3),
                'last_request': self.last_request, 'requests_by_stage': self.counts,
                'stage_seconds': {**self.phase_seconds, self.stage: round(time.monotonic() - self.phase_started, 3)},
                'note': 'Progress is not an aggregate report or evidence of successful publication.',
            })

    def phase(self, name):
        self.phase_seconds[self.stage] = round(time.monotonic() - self.phase_started, 3)
        self.phase_started = time.monotonic()
        self.stage = name
        self.save()
        logger.info('CI duration monitor stage: {}', name)

    def remaining(self):
        return self.deadline - time.monotonic()

    def request(self, method, path, payload=None):
        # No query strings, response bodies, credentials or exception messages.
        request_info = {'method': method, 'path': path.split('?')[0]}
        with self._lock:
            self.last_request = request_info
            self.save()
        if method == 'GET' and self.remaining() <= 0:
            raise ReadBudgetExceeded('GitHub read budget exhausted; required evidence is incomplete')
        setter = getattr(self.client, 'set_read_deadline', None)
        if setter is not None:
            setter(self.deadline if method == 'GET' else None)
        started = time.monotonic()
        with self._lock:
            counters = self.counts.setdefault(self.stage, {'attempts': 0, 'seconds': 0, 'errors': 0, 'statuses': {}})
            counters['attempts'] += 1
        try:
            # The optional read deadline can change; admission's cutoff cannot.
            # Check every mutation immediately before sending it, including
            # follow-up comments/labels after an earlier confirmed mutation.
            if method != 'GET' and time.monotonic() >= self.admission_deadline:
                raise ReadBudgetExceeded('Issue mutation admission cutoff expired')
            response = self.client.request(method, path, payload)
            status = str(response.status)
            with self._lock:
                counters['statuses'][status] = counters['statuses'].get(status, 0) + 1
            if method == 'GET' and self.remaining() <= 0:
                raise ReadBudgetExceeded('GitHub read budget exhausted; required evidence is incomplete')
            return response
        except Exception as error:
            with self._lock:
                self.last_request = request_info
                counters['last_error_type'] = type(error).__name__
                counters['errors'] += 1
            raise
        finally:
            with self._lock:
                counters['seconds'] = round(counters['seconds'] + time.monotonic() - started, 3)
            if setter is not None:
                setter(None)
            self.save()


@dataclass(frozen=True)
class Response:
    status: int
    data: object


class MetadataRedirect(HTTPRedirectHandler):
    """Metadata admission never needs cross-origin log/artifact redirects."""

    def redirect_request(self, request, fp, code, message, headers, new_url):
        origin, target = urlsplit(request.full_url), urlsplit(new_url)
        if (origin.scheme, origin.netloc) != (target.scheme, target.netloc):
            raise RuntimeError("Refusing an untrusted metadata redirect")
        return super().redirect_request(request, fp, code, message, headers, new_url)


class GitHubClient:
    """Use repository-relative endpoints and surface failed requests unchanged."""

    def __init__(self, token: str, repository: str, api_url: str = "https://api.github.com"):
        self._read_deadline = threading.local()
        self._token = token
        self._base = f"{api_url.rstrip('/')}/repos/{repository}/"

    def request(self, method: str, path: str, payload: object = None) -> Response:
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "outliner-ci-duration-monitor",
        }
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        data = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(payload).encode("utf-8")
        url = self._base + path.lstrip("/") if path else self._base.rstrip("/")
        request = Request(url, data=data, headers=headers, method=method)
        deadline = getattr(self._read_deadline, 'value', None)
        timeout = 30 if deadline is None else min(30, max(0.001, deadline - time.monotonic()))
        try:
            with build_opener(MetadataRedirect()).open(request, timeout=timeout) as response:
                return Response(response.status, self._decode(self._read(response)))
        except HTTPError as error:
            try:
                body = self._decode(self._read(error))
            except RuntimeError:
                # Gateway errors may contain HTML; preserve the HTTP status.
                body = None
            return Response(error.code, body)
        except URLError as error:
            # A failed mutation may have reached GitHub. Reconciliation owns retry.
            raise ConnectionError("GitHub request failed before a usable response was received") from error

    def set_read_deadline(self, deadline: float | None) -> None:
        self._read_deadline.value = deadline

    def _read(self, response) -> bytes:
        deadline = getattr(self._read_deadline, 'value', None)
        if deadline is None:
            return response.read()
        # read1 returns after one buffered/socket read, so a trickling response
        # cannot reset a per-operation socket timeout indefinitely. One blocked
        # operation can still take the opener timeout (at most thirty seconds).
        chunks = []
        while True:
            if time.monotonic() >= deadline:
                raise ReadBudgetExceeded("GitHub response exceeded the read budget")
            chunk = response.read1(65536)
            if not chunk:
                raw = response.fp if isinstance(response, HTTPError) else response
                remaining = getattr(raw, 'length', None)
                if remaining:
                    raise IncompleteRead(b''.join(chunks), remaining)
                return b''.join(chunks)
            chunks.append(chunk)

    @staticmethod
    def _decode(body: bytes) -> object:
        if not body:
            return None
        try:
            return json.loads(body)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise RuntimeError("GitHub returned a non-JSON response") from error


def create_client(token: str, repository: str) -> GitHubClient:
    return GitHubClient(token, repository, os.environ.get("GITHUB_API_URL", "https://api.github.com"))
