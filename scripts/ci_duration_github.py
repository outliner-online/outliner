"""GitHub REST transport for the scheduled CI duration monitor."""

from dataclasses import dataclass
import json
import os
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


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
        try:
            with build_opener(MetadataRedirect()).open(request, timeout=30) as response:
                return Response(response.status, self._decode(response.read()))
        except HTTPError as error:
            try:
                body = self._decode(error.read())
            except RuntimeError:
                # Gateway errors may contain HTML; preserve the HTTP status.
                body = None
            return Response(error.code, body)
        except URLError as error:
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
