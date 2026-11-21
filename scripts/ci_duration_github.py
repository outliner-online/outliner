"""GitHub REST transport for the scheduled CI duration monitor."""

from dataclasses import dataclass
from http.client import IncompleteRead
import json
import os
import re
import ssl
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


@dataclass(frozen=True)
class Response:
    status: int
    data: object


class NativeLogUnavailable(ConnectionError):
    """A verified job-log storage fetch failed; contains no signed URL."""


class SafeRedirect(HTTPRedirectHandler):
    """Job logs redirect to signed storage; never forward repository credentials."""

    def __init__(self, *, native_log=False):
        super().__init__()
        self.native_log = native_log
        self.storage_host = None

    def redirect_request(self, request, fp, code, message, headers, new_url):
        origin, target = urlsplit(request.full_url), urlsplit(new_url)
        if origin.scheme == "https" and target.scheme != "https":
            raise RuntimeError("Refusing an insecure GitHub redirect")
        cross_origin = (origin.scheme, origin.netloc) != (target.scheme, target.netloc)
        if cross_origin:
            try:
                port = target.port
            except ValueError:
                raise RuntimeError("Refusing an untrusted GitHub redirect") from None
            if not self.native_log or target.scheme != "https" or port not in {None, 443} or target.username or target.password or re.fullmatch(r"productionresults[a-z0-9-]*\.blob\.core\.windows\.net", target.hostname or "") is None:
                raise RuntimeError("Refusing an untrusted GitHub redirect")
            self.storage_host = target.hostname
        redirected = super().redirect_request(request, fp, code, message, headers, new_url)
        if redirected is not None and (origin.scheme, origin.netloc) != (target.scheme, target.netloc):
            redirected.remove_header("Authorization")
        return redirected


class GitHubClient:
    """Use repository-relative endpoints and surface failed requests unchanged."""

    def __init__(self, token: str, repository: str, api_url: str = "https://api.github.com"):
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
        native_log = method == "GET" and re.fullmatch(r"actions/jobs/[0-9]+/logs", path) is not None
        redirect = SafeRedirect(native_log=native_log)
        try:
            with build_opener(redirect).open(request, timeout=30) as response:
                return Response(response.status, response.read().decode("utf-8") if native_log else self._decode(response.read()))
        except HTTPError as error:
            if native_log and redirect.storage_host == urlsplit(error.url).hostname and error.code in {403, 404, 410, 500, 502, 503, 504}:
                raise NativeLogUnavailable("Verified native log storage is unavailable") from None
            try:
                body = self._decode(error.read())
            except RuntimeError:
                # Gateway errors may contain HTML; preserve the HTTP status.
                body = None
            return Response(error.code, body)
        except (URLError, TimeoutError, ConnectionError, IncompleteRead) as error:
            if isinstance(getattr(error, "reason", error), ssl.SSLCertVerificationError):
                raise RuntimeError("Untrusted GitHub transport certificate") from None
            if native_log and redirect.storage_host:
                raise NativeLogUnavailable("Verified native log storage is unavailable") from None
            # A failed mutation may have reached GitHub. Reconciliation owns retry.
            raise ConnectionError("GitHub request failed before a usable response was received") from error

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
