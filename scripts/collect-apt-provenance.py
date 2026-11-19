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
    return re.sub(r"\b[a-zA-Z][\w+.-]*:(?://|/)[^\s\"'<>]+", lambda m: uri_identity(m[0]), text)


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


def probe(argv, timeout=1):
    try:
        run = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        # A missing/unavailable command is diagnostic failure, never success.
        return {"exit": run.returncode, "stdout": sanitize(run.stdout[:1048576]),
                "stderr": sanitize(run.stderr[:32768]),
                "truncated": len(run.stdout) > 1048576 or len(run.stderr) > 32768}
    except subprocess.TimeoutExpired:
        return {"status": "timeout", "output": "not retained"}
    except OSError:
        return {"status": "unavailable", "output": "not retained"}


# Proposed diagnostic only: no acquisition, refresh, route or source changes.
def collect_transport_observation(root, runner=probe):
    settings = {
        "RETRIES": ("Acquire::Retries", "number"),
        "HTTP_TIMEOUT": ("Acquire::http::Timeout", "number"),
        "HTTPS_TIMEOUT": ("Acquire::https::Timeout", "number"),
        "HTTP_PIPELINE": ("Acquire::http::Pipeline-Depth", "number"),
        "HTTPS_PIPELINE": ("Acquire::https::Pipeline-Depth", "number"),
        "HTTP_DL_LIMIT": ("Acquire::http::Dl-Limit", "number"),
        "HTTPS_DL_LIMIT": ("Acquire::https::Dl-Limit", "number"),
        "IPV4": ("Acquire::ForceIPv4", "boolean"),
        "IPV6": ("Acquire::ForceIPv6", "boolean"),
        "QUEUE": ("Acquire::Queue-Mode", "queue"),
    }
    argv = ["apt-config", "shell"]
    for name, (key, _) in settings.items():
        argv.extend([name, key])
    observation = runner(argv)
    result = {
        "readiness_evidence": False,
        "source_exclusion_proof": False,
        "config_exit": observation.get("exit"),
        "config_status": observation.get("status", "observed"),
        "collection_status": "partial",
        "settings": {},
        "limitations": [
            "Unset values are not claims about APT defaults.",
            "Command-line overrides are not part of apt-config output.",
            "Proxy/authentication settings, DNS, routes and live transfer probes are not collected.",
            "Mirrorlist entries do not prove which endpoint served a transfer.",
        ],
    }
    if observation.get("exit") == 0 and not observation.get("truncated"):
        try:
            for assignment in shlex.split(observation.get("stdout", "")):
                key, sep, value = assignment.rstrip(";").partition("=")
                if not sep or key not in settings:
                    continue
                kind = settings[key][1]
                valid = (
                    (kind == "number" and re.fullmatch(r"[0-9]{1,9}", value))
                    or (kind == "boolean" and value.lower() in ("true", "false", "yes", "no", "1", "0"))
                    or (kind == "queue" and value in ("host", "access"))
                )
                result["settings"][settings[key][0]] = value if valid else "[unsupported value omitted]"
                if not valid:
                    result["config_status"] = "unsupported-values"
        except ValueError:
            result["config_status"] = "unparseable"
            result["settings"] = {}
    elif observation.get("truncated"):
        result["config_status"] = "truncated"
    try:
        import stat
        from contextlib import ExitStack
        # Production root is /. Root ancestors are trusted; every component
        # beneath its opened descriptor is anchored and cannot follow a symlink.
        with ExitStack() as cleanup:
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
            directory = os.open(root, flags)
            cleanup.callback(os.close, directory)
            for component in ("etc", "apt"):
                directory = os.open(component, flags, dir_fd=directory)
                cleanup.callback(os.close, directory)
            fd = os.open("apt-mirrors.txt", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                         dir_fd=directory)
            cleanup.callback(os.close, fd)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > 4096:
                result["mirrorlist"] = {"status": "nonregular or oversized omitted"}
                return result
            contents = os.read(fd, 4097)
        if len(contents) > 4096:
            result["mirrorlist"] = {"status": "oversized omitted"}
            return result
        entries = []
        omitted = 0
        for line in contents.decode("utf-8").splitlines():
            tokens = line.split()
            if not tokens or tokens[0].startswith("#"):
                continue
            try:
                uri = urlsplit(tokens[0])
                host = uri.hostname or ""
                if uri.scheme in ("http", "https") and (
                    host == "archive.ubuntu.com" or host.endswith(".archive.ubuntu.com")
                    or host in ("security.ubuntu.com", "ports.ubuntu.com")
                ):
                    entries.append(uri_identity(tokens[0]))
                else:
                    omitted += 1
            except ValueError:
                omitted += 1
        result["mirrorlist"] = {
            "status": "observed-public-origins", "entries": entries,
            "omitted_entries": omitted, "bytes": len(contents),
            "mtime_ns": info.st_mtime_ns,
        }
    except FileNotFoundError:
        result["mirrorlist"] = {"status": "absent"}
    except (OSError, UnicodeError):
        result["mirrorlist"] = {"status": "unreadable"}
    if (result["config_exit"] == 0 and result["config_status"] == "observed"
            and result["mirrorlist"].get("status") == "observed-public-origins"
            and result["mirrorlist"].get("omitted_entries") == 0):
        result["collection_status"] = "collected-observations"
    return result


def collect(root, required, runner=probe, *, phase="before", output=None, checkpoint=lambda result: None):
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
    result = {
        "schema": 2, "observed_at_ns": time.time_ns(), "phase": phase,
        "collection_status": "partial", "readiness_evidence": False, "source_exclusion_proof": False,
        "refresh_boundary": "strict refresh returned success" if phase == "after-refresh" else "not asserted",
        "purpose": "offline observations only; indexes may be stale/incomplete; not readiness or source-exclusion proof",
        "runner": {k: os.environ[k] for k in ("ImageOS", "ImageVersion", "RUNNER_OS", "RUNNER_ARCH", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT")
                   if k in os.environ and re.fullmatch(r"[a-zA-Z0-9._-]{1,100}", os.environ[k])},
        "architecture": runner(["dpkg", "--print-architecture"]),
        "config_status": {k: v for k, v in config.items() if k != "stdout"},
        "paths_observed": bool(paths), "source_fields": sources, "pin_fields": pins,
        "index_inventory": indexes, "required_by_repository": required,
        "limitations": ["Package closure uses existing indexes and may be incomplete.",
                        "Dependency/provider output is a cached observation, not independently resolved authoritative solver closure.",
                        "APT trust and signed-manifest hash links are observations, not independent signature/freshness verification.",
                        "Unknown source options, URI paths, key contents and credential configuration are intentionally not collected."],
    }
    checkpoint(result)
    if phase == "before":
        result["transport_observation"] = {"collection_status": "partial", "status": "pending"}
        checkpoint(result)
        result["transport_observation"] = collect_transport_observation(root, runner)
        checkpoint(result)
    names = set(required)
    if phase != "before":
        repository = Path(__file__).resolve().parents[1]
        native = probe(["node", str(repository / "scripts/locked-browser-os-packages.cjs"),
                        str(repository), os.environ.get("E2E_BROWSER", "chromium")], timeout=3)
        result["locked_native_probe"] = {k: v for k, v in native.items() if k not in ("stdout", "stderr")}
        if native.get("exit") == 0 and not native.get("truncated"):
            try:
                declarations = json.loads(native["stdout"])
                native_names = declarations["packages"]
                if not native_names or any(not re.fullmatch(r"[a-z0-9][a-z0-9+.-]*", name) for name in native_names):
                    raise ValueError("unsupported package declaration")
                result["locked_native_declarations"] = declarations
                names.update(native_names)
            except (ValueError, KeyError, TypeError):
                result["locked_native_probe"] = {"status": "unsupported-declarations"}
        checkpoint(result)
    if phase == "after-refresh" and output:
        from apt_catalog_evidence import collect_catalogs
        catalog_dir = output.with_name(output.stem + ".catalogs")
        result["catalog_directory"] = catalog_dir.name
        result["public_catalog_observations"] = collect_catalogs(root, lists, catalog_dir)
        checkpoint(result)
    for key, command in [
        ("installed", ["dpkg-query", "-W", "-f=${Package}\t${Version}\t${Status}\t${Provides}\n"]),
        ("source_policy", ["apt-cache", "policy"]),
        ("provider_observation", ["apt-cache", "showpkg", *sorted(names)]),
        ("dependency_observation", ["apt-cache", "depends", "--recurse", "--important", *sorted(names)]),
    ]:
        result[key] = runner(command) if names else {"status": "no required set reached"}
        checkpoint(result)
    depends = result["dependency_observation"]
    if depends.get("exit") == 0 and not depends.get("truncated"):
        names.update(re.findall(r"^([a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?)$", depends["stdout"], re.M))
    result["dependency_names_limited"] = len(names) > 4096
    result["queried_candidate_names"] = sorted(names)[:4096]
    result["candidate_policy"] = runner(["apt-cache", "policy", *sorted(names)[:4096]]) if names else {"status": "no required set reached"}
    keys = ["architecture", "config_status", "installed", "source_policy", "provider_observation", "dependency_observation", "candidate_policy"]
    if phase != "before":
        keys.append("locked_native_probe")
    complete = all(result[key].get("exit") == 0 and not result[key].get("truncated") for key in keys)
    if phase == "before":
        complete = complete and result["transport_observation"]["collection_status"] == "collected-observations"
    if phase == "after-refresh":
        complete = complete and result.get("public_catalog_observations", {}).get("status") == "retained-observations"
    result["collection_status"] = "collected-observations" if complete and not result["dependency_names_limited"] else "partial"
    checkpoint(result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    parser.add_argument("--phase", choices=["before", "after-refresh", "after"], default="before")
    parser.add_argument("packages", nargs="*")
    args = parser.parse_args()
    if any(not re.fullmatch(r"[a-z0-9][a-z0-9+.-]*(?::[a-z0-9]+)?", p) for p in args.packages):
        parser.error("invalid package name")
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    # Timeout/error leaves an explicit incomplete record, not a ready claim.
    with target.open("x", encoding="utf-8") as stream:
        stream.write('{"status":"incomplete","readiness_evidence":false}\n')
    def checkpoint(result):
        temporary = target.with_name(target.name + ".pending")
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump(result, stream, indent=2)
            stream.write("\n")
        temporary.replace(target)
    collect(Path("/"), args.packages, phase=args.phase, output=target, checkpoint=checkpoint)


if __name__ == "__main__":
    main()
