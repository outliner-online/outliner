"""Retain existing public Microsoft indexes only; never fetch or install.

APT's trust flag is an observation, not independent signature validation. Raw
catalogs are hash-linked to the retained clearsigned manifest, never treated as
readiness/source-exclusion proof. No key/auth/proxy file is opened.
"""
from email.parser import Parser
import hashlib
from pathlib import Path
import resource
import re
import subprocess
import tempfile
from urllib.parse import urlsplit

PREFIX = "packages.microsoft.com_ubuntu_26.04_prod_dists_resolute_"
MAX_BYTES = 4 * 1024 * 1024


def command(argv, cap=MAX_BYTES):
    def limit():
        resource.setrlimit(resource.RLIMIT_FSIZE, (cap, cap))
    with tempfile.TemporaryFile() as output:
        try:
            run = subprocess.run(argv, stdout=output, stderr=subprocess.DEVNULL,
                                 timeout=1, preexec_fn=limit)
            if run.returncode:
                return {"status": "command-failed", "exit": run.returncode}
            output.seek(0)
            data = output.read(cap + 1)
            if len(data) > cap:
                return {"status": "oversized"}
            return {"status": "observed", "exit": 0, "bytes": data}
        except subprocess.TimeoutExpired:
            return {"status": "timeout"}
        except OSError:
            return {"status": "unavailable"}


def public_target(uri):
    parsed = urlsplit(uri)
    return (parsed.scheme == "https" and parsed.hostname == "packages.microsoft.com"
            and parsed.port in (None, 443) and not parsed.username and not parsed.password
            and not parsed.query and not parsed.fragment
            and parsed.path.startswith("/ubuntu/26.04/prod/dists/resolute/")
            and parsed.path.endswith("/Packages"))


def contains_private_uri(text):
    # Catalogs are public, but refuse rather than export any credential-bearing
    # URI even if a future feed embeds one in a descriptive field.
    for value in re.findall(r"\b[a-zA-Z][\w+.-]*:(?://|/)[^\s\"'<>]+", text):
        uri = urlsplit(value)
        if uri.username or uri.password or uri.query or uri.fragment:
            return True
    return False


def manifest_entry(release, meta_key):
    text = release.decode("utf-8")
    if not text.startswith("-----BEGIN PGP SIGNED MESSAGE-----\n"):
        raise ValueError("not clearsigned")
    if text.count("-----BEGIN PGP SIGNATURE-----") != 1:
        raise ValueError("ambiguous signature armor")
    body = text.split("\n\n", 1)[1].split("\n-----BEGIN PGP SIGNATURE-----", 1)[0]
    fields = Parser().parsestr(body)
    hashes = fields.get_all("SHA256", [])
    if len(hashes) != 1:
        raise ValueError("missing or duplicate hash field")
    matches = []
    for row in hashes[0].splitlines():
        parts = row.split()
        if len(parts) == 3 and parts[2] == meta_key:
            digest, size, _ = parts
            if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
                raise ValueError("invalid digest")
            matches.append((digest, int(size)))
    if len(matches) != 1:
        raise ValueError("missing or duplicate catalog hash")
    return matches[0]


def save(output, name, data):
    if output.is_symlink():
        raise ValueError("unsafe output")
    output.mkdir(parents=True, exist_ok=True)
    target = output / name
    if target.exists():
        if target.is_symlink() or target.read_bytes() != data:
            raise ValueError("existing evidence differs")
    else:
        with target.open("xb") as stream:
            stream.write(data)
    return target.name


def collect_catalogs(root, lists, output, run=command):
    result = {"scope": "existing public Microsoft resolute package indexes only", "status": "incomplete",
              "freshness_proof": False, "independent_signature_validation": False,
              "source_exclusion_proof": False, "catalogs": []}
    indexes = run(["apt-get", "indextargets"])
    result["index_targets_status"] = {k: v for k, v in indexes.items() if k != "bytes"}
    if indexes.get("exit") != 0:
        return result
    try:
        paragraphs = indexes["bytes"].decode("utf-8").strip().split("\n\n")
        for paragraph in paragraphs:
            item = Parser().parsestr(paragraph)
            uri = item.get("URI", "")
            if item.get("Identifier") != "Packages" or not public_target(uri):
                continue
            record = {"status": "incomplete", "apt_trusted_observed": item.get("Trusted") == "yes"}
            result["catalogs"].append(record)
            if not record["apt_trusted_observed"]:
                record["status"] = "untrusted-index-observation"
                continue
            index = root / item.get("Filename", "").lstrip("/")
            if (index.is_symlink() or index.parent.resolve() != lists.resolve()
                    or not re.fullmatch(re.escape(PREFIX) + r"main_binary-(amd64|arm64|armhf|all)_Packages(?:\.(lz4|gz|xz|zst|bz2))?", index.name)
                    or not index.is_file()
                    or index.stat().st_size > MAX_BYTES):
                record["status"] = "unsafe-or-unavailable-index"
                continue
            release = lists / (PREFIX + "InRelease")
            if release.is_symlink() or not release.is_file() or release.stat().st_size > 262144:
                record["status"] = "manifest-unavailable"
                continue
            raw = run([str(root / "usr/lib/apt/apt-helper"), "cat-file", str(index)])
            if raw.get("exit") != 0:
                record["status"] = raw.get("status", "index-unavailable")
                continue
            data, signed = raw["bytes"], release.read_bytes()
            key = item.get("MetaKey", "")
            if not re.fullmatch(r"main/binary-(amd64|arm64|armhf|all)/Packages", key):
                record["status"] = "unsupported-meta-key"
                continue
            expected, size = manifest_entry(signed, key)
            if len(data) != size or hashlib.sha256(data).hexdigest() != expected:
                record["status"] = "manifest-hash-mismatch"
                continue
            if contains_private_uri(data.decode("utf-8")) or contains_private_uri(signed.decode("utf-8")):
                record["status"] = "private-uri-omitted"
                continue
            release_hash = hashlib.sha256(signed).hexdigest()
            record.update(status="retained-hash-linked", meta_key=key, sha256=expected, bytes=size,
                          index_mtime_ns=index.stat().st_mtime_ns,
                          manifest_sha256=release_hash,
                          manifest_file=save(output, "InRelease-" + release_hash + ".txt", signed),
                          packages_file=save(output, "Packages-" + expected + ".txt", data))
    except (OSError, ValueError, UnicodeError, KeyError):
        result["status"] = "incomplete"
        return result
    result["status"] = ("retained-observations" if result["catalogs"]
                        and all(x["status"] == "retained-hash-linked" for x in result["catalogs"])
                        else "incomplete")
    return result
