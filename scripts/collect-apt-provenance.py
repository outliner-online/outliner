#!/usr/bin/env python3
"""Offline APT observations, never readiness or proof that a source is optional.

No environment dump, auth.conf, proxy configuration, key contents, downloads,
package installation or index refresh. URI credentials/query/path are omitted.
The caller bounds the entire process inside its acquisition deadline.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time
from urllib.parse import urlsplit


def uri_identity(value):
    try:
        uri = urlsplit(value)
        if uri.scheme not in ("http", "https") or not uri.hostname:
            return "[non-http source omitted]"
        origin = f"{uri.scheme}://{uri.hostname}"
        if uri.port:
            origin += f":{uri.port}"
        digest = hashlib.sha256(uri.path.encode()).hexdigest()
        return f"{origin}/[path-sha256:{digest}]"
    except ValueError:
        return "[invalid URI omitted]"


def sanitize(text):
    return re.sub(r"[a-zA-Z][\w+.-]*://[^\s\"'<>]+", lambda m: uri_identity(m[0]), text)


def read_fields(path, allowed):
    """Only public source/pin fields; omit unknown and continuation contents."""
    result = []
    if not path.exists():
        return result
    if path.is_symlink() or path.stat().st_size > 262144:
        return [{"status": "symlink or oversized file omitted"}]
    for line in path.read_text().splitlines():
        if line[:1].isspace() or line.startswith("#"):
            continue
        if ":" in line:
            key, value = line.split(":", 1)
            if key in allowed:
                if key == "Signed-By":
                    # Never read key files or inline key contents.
                    value = "[key reference present; contents not collected]"
                result.append({key: sanitize(value.strip())})
        if line.startswith(("deb ", "deb-src ")):
            # Options can hold arbitrary data: retain only source URI and the
            # public distribution/component tokens after it.
            match = re.match(r"^(deb(?:-src)?)\s+(?:\[[^]]*\]\s+)?(\S+)\s+(.*)$", line)
            if match:
                result.append({"type": match[1], "uri": uri_identity(match[2]),
                               "suite_components": sanitize(match[3].split("#", 1)[0])})
    return result


def probe(argv):
    try:
        run = subprocess.run(argv, capture_output=True, text=True, timeout=1)
        # A missing/unavailable command is diagnostic failure, never success.
        return {"exit": run.returncode, "stdout": sanitize(run.stdout[:1048576]),
                "stderr": sanitize(run.stderr[:32768]),
                "truncated": len(run.stdout) > 1048576 or len(run.stderr) > 32768}
    except subprocess.TimeoutExpired:
        return {"status": "timeout", "output": "not retained"}
    except OSError:
        return {"status": "unavailable", "output": "not retained"}


def collect(root, required, runner=probe):
    config = runner(["apt-config", "shell", "ROOT", "Dir", "ETC", "Dir::Etc", "LIST", "Dir::Etc::sourcelist",
                     "PARTS", "Dir::Etc::sourceparts", "PREF", "Dir::Etc::preferences",
                     "PREFPARTS", "Dir::Etc::preferencesparts", "STATE", "Dir::State", "LISTS", "Dir::State::lists"])
    paths = {}
    if config.get("exit") == 0:
        for assignment in shlex.split(config["stdout"]):
            key, sep, value = assignment.rstrip(";").partition("=")
            if sep and key in ("ROOT", "ETC", "LIST", "PARTS", "PREF", "PREFPARTS", "STATE", "LISTS"):
                paths[key] = value
    # These are defaults only, not claims about an unobserved effective config.
    base = Path(paths.get("ROOT", "/"))
    etc = Path(paths.get("ETC", "etc/apt"))
    if not etc.is_absolute():
        etc = base / etc
    def mapped(value, base):
        path = Path(value)
        return root / str(path if path.is_absolute() else base / path).lstrip("/")
    sources = []
    pins = []
    for key, default, is_dir, allowed, target in [
        ("LIST", "sources.list", False, {"Types", "URIs", "Suites", "Components", "Architectures", "Enabled", "Signed-By"}, sources),
        ("PARTS", "sources.list.d", True, {"Types", "URIs", "Suites", "Components", "Architectures", "Enabled", "Signed-By"}, sources),
        ("PREF", "preferences", False, {"Package", "Pin", "Pin-Priority"}, pins),
        ("PREFPARTS", "preferences.d", True, {"Package", "Pin", "Pin-Priority"}, pins),
    ]:
        path = mapped(paths.get(key, default), etc)
        files = sorted(path.iterdir()) if is_dir and path.is_dir() else ([] if is_dir else [path])
        for file in files:
            if is_dir and target is sources and file.suffix not in (".list", ".sources"):
                continue
            if file.is_file():
                target.append({"file": str(file.relative_to(root)), "fields": read_fields(file, allowed)})
    state = Path(paths.get("STATE", "var/lib/apt"))
    if not state.is_absolute():
        state = base / state
    lists = mapped(paths.get("LISTS", "lists"), state)
    indexes = []
    if lists.is_dir():
        for file in sorted(lists.iterdir()):
            if file.is_file() and not file.is_symlink():
                st = file.stat()
                # Filenames may encode private paths; do not publish them.
                indexes.append({"name_sha256": hashlib.sha256(file.name.encode()).hexdigest(),
                                "bytes": st.st_size, "mtime_ns": st.st_mtime_ns})
    depends = runner(["apt-cache", "depends", "--recurse", "--important", *required]) if required else {"status": "no required set reached"}
    names = set(required)
    if depends.get("exit") == 0:
        names.update(re.findall(r"^([a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?)$", depends["stdout"], re.M))
    limited = len(names) > 4096
    names = sorted(names)[:4096]
    return {
        "schema": 1, "observed_at_ns": time.time_ns(),
        "purpose": "offline observations only; indexes may be stale/incomplete; not readiness or source-exclusion proof",
        "runner": {k: os.environ[k] for k in ("ImageOS", "ImageVersion", "RUNNER_OS", "RUNNER_ARCH", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT")
                   if k in os.environ and re.fullmatch(r"[a-zA-Z0-9._-]{1,100}", os.environ[k])},
        "architecture": runner(["dpkg", "--print-architecture"]),
        "config_status": {k: v for k, v in config.items() if k != "stdout"},
        "paths_observed": bool(paths), "source_fields": sources, "pin_fields": pins,
        "index_inventory": indexes, "required_by_repository": required,
        "installed": runner(["dpkg-query", "-W", "-f=${Package}\t${Version}\t${Status}\t${Provides}\n"]),
        "source_policy": runner(["apt-cache", "policy"]),
        "dependency_observation": depends, "dependency_names_limited": limited,
        "candidate_policy": runner(["apt-cache", "policy", *names]) if names else {"status": "no required set reached"},
        "limitations": ["Package closure uses existing indexes and may be incomplete.",
                        "Repository required set does not enumerate additional locked Playwright native dependency declarations.",
                        "Unknown source options, URI paths, key contents and credential configuration are intentionally not collected."],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("packages", nargs="*")
    args = parser.parse_args()
    if any(not re.fullmatch(r"[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?", p) for p in args.packages):
        parser.error("invalid package name")
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    # Timeout/error leaves an explicit incomplete record, not a ready claim.
    with target.open("x", encoding="utf-8") as stream:
        stream.write('{"status":"incomplete","readiness_evidence":false}\n')
    result = collect(Path("/"), args.packages)
    temporary = target.with_name(target.name + ".pending")
    with temporary.open("x", encoding="utf-8") as stream:
        json.dump(result, stream, indent=2)
        stream.write("\n")
    temporary.replace(target)


if __name__ == "__main__":
    main()
