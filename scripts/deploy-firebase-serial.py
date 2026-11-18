#!/usr/bin/env python3
"""Deploy one Function at a time; publish other Firebase resources only after proof.

No outer retry: a failed/unknown command cannot become success via unchanged skip.
Receipts contain identities/hashes, never tool output or environment variables.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import zipfile

ROOT = Path(__file__).resolve().parent.parent


class RolloutError(Exception):
    pass


def command(argv, timeout, binary=False):
    try:
        result = subprocess.run(argv, cwd=ROOT, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise RolloutError(
            "Command timed out; outcome may be unknown. Inspect receipt/remote operation before retry."
        ) from exc
    if result.returncode:
        # Do not echo tool output: Functions discovery can log environment values.
        raise RolloutError(f"{Path(argv[0]).name} exited {result.returncode}")
    return result.stdout if binary else result.stdout.decode("utf-8")


def read_json(argv, timeout):
    try:
        return json.loads(command(argv, timeout))
    except (ValueError, UnicodeError) as exc:
        raise RolloutError("Tool returned invalid JSON") from exc


def source_inventory():
    source = ROOT / "functions"
    paths = {"package.json", "package-lock.json", "index.js"}
    for parent, dirs, files in os.walk(source):
        dirs[:] = [
            d
            for d in dirs
            if d not in {"node_modules", "test", "tests", "fixtures"}
            and not d.startswith(".")
        ]
        for name in files:
            if (
                name.endswith((".js", ".cjs", ".mjs"))
                and ".config." not in name
                and not name.startswith(".")
            ):
                paths.add(str((Path(parent) / name).relative_to(source)))
    return {
        name: hashlib.sha256((source / name).read_bytes()).hexdigest()
        for name in sorted(paths)
    }


def verify_source(source, expected, timeout):
    if not isinstance(source, dict) or not all(
        isinstance(source.get(k), str) and source[k]
        for k in ("bucket", "object", "generation")
    ):
        raise RolloutError("Missing immutable Functions source identity")
    if not re.fullmatch(r"[0-9]+", source["generation"]):
        raise RolloutError("Invalid source generation")
    uri = f"gs://{source['bucket']}/{source['object']}#{source['generation']}"
    payload = command(
        ["gcloud", "storage", "cat", uri, "--quiet"], timeout, binary=True
    )
    try:
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            for name, digest in expected.items():
                if (
                    archive.namelist().count(name) != 1
                    or hashlib.sha256(archive.read(name)).hexdigest() != digest
                ):
                    raise RolloutError(f"Deployed source mismatch: {name}")
    except (zipfile.BadZipFile, KeyError) as exc:
        raise RolloutError("Deployed source archive is invalid/incomplete") from exc
    return source


def readiness(function, service, project, region):
    config = function.get("serviceConfig", {})
    revision = config.get("revision")
    status = service.get("status", {})
    conditions = {c.get("type"): c.get("status") for c in status.get("conditions", [])}
    traffic = status.get("traffic", [])
    prefix = f"projects/{project}/locations/{region}/services/"
    if not isinstance(config.get("service"), str) or not config["service"].startswith(
        prefix
    ):
        raise RolloutError("Function points outside the expected project/region")
    return bool(
        function.get("state") == "ACTIVE"
        and revision
        and status.get("latestCreatedRevisionName") == revision
        and status.get("latestReadyRevisionName") == revision
        and all(
            conditions.get(k) == "True"
            for k in ("Ready", "ConfigurationsReady", "RoutesReady")
        )
        and traffic
        and all(
            t.get("revisionName") == revision for t in traffic if t.get("percent", 0)
        )
        and sum(
            t.get("percent", 0) for t in traffic if t.get("revisionName") == revision
        )
        == 100
    )


def deploy(args):
    receipt_dir = Path(args.receipt_dir)
    receipt_dir.mkdir(parents=True, exist_ok=False)
    receipt = {
        "phase": "PREFLIGHT",
        "project": args.project,
        "targets": [],
        "functions": [],
    }

    def save():
        temporary = receipt_dir / "receipt.tmp"
        temporary.write_text(json.dumps(receipt, indent=2) + "\n")
        temporary.replace(receipt_dir / "receipt.json")

    def firebase(only):
        return command(
            [
                str(ROOT / "scripts/firebase-cli.sh"),
                "deploy",
                "--only",
                only,
                "--project",
                args.project,
                "--non-interactive",
                "--force",
            ],
            args.command_timeout,
        )

    def verify(record, expected):
        name, region = record["name"], record["region"]
        record["phase"] = "VERIFYING"
        save()
        deadline = time.monotonic() + args.verify_timeout
        while True:
            record["verification_stage"] = "function-metadata"
            save()
            function = read_json(
                [
                    "gcloud",
                    "functions",
                    "describe",
                    name,
                    "--gen2",
                    "--project",
                    args.project,
                    "--region",
                    region,
                    "--quiet",
                    "--format=json(name,state,serviceConfig.service,serviceConfig.revision,buildConfig.source.storageSource)",
                ],
                args.command_timeout,
            )
            if (
                function.get("name")
                != f"projects/{args.project}/locations/{region}/functions/{name}"
            ):
                raise RolloutError("Wrong Function identity")
            service_path = function.get("serviceConfig", {}).get("service", "")
            prefix = f"projects/{args.project}/locations/{region}/services/"
            if not service_path.startswith(prefix) or not re.fullmatch(
                r"[a-z0-9-]+", service_path[len(prefix) :]
            ):
                raise RolloutError("Wrong service identity")
            record["verification_stage"] = "service-metadata"
            save()
            service = read_json(
                [
                    "gcloud",
                    "run",
                    "services",
                    "describe",
                    service_path[len(prefix) :],
                    "--project",
                    args.project,
                    "--region",
                    region,
                    "--quiet",
                    "--format=json(status.conditions,status.latestCreatedRevisionName,status.latestReadyRevisionName,status.traffic)",
                ],
                args.command_timeout,
            )
            # Retain only bounded operational facts, not provider messages/URLs.
            status = service.get("status", {})
            record["observation"] = {
                "state": function.get("state"),
                "expected_revision": function.get("serviceConfig", {}).get("revision"),
                "ready_revision": status.get("latestReadyRevisionName"),
                "traffic": status.get("traffic"),
                "conditions": [
                    {
                        "type": c.get("type"),
                        "status": c.get("status"),
                        "reason": c.get("reason"),
                    }
                    for c in status.get("conditions", [])
                ],
            }
            save()
            if readiness(function, service, args.project, region):
                record["verification_stage"] = "source-content"
                save()
                record["source"] = verify_source(
                    function.get("buildConfig", {})
                    .get("source", {})
                    .get("storageSource"),
                    expected,
                    args.command_timeout,
                )
                record["phase"] = "VERIFIED"
                save()
                break
            if time.monotonic() >= deadline:
                raise RolloutError(
                    f"{name}: expected revision is not Ready with 100% traffic"
                )
            time.sleep(min(5, max(0, deadline - time.monotonic())))

    save()
    try:
        config = json.loads((ROOT / "firebase.json").read_text())
        functions = config.get("functions")
        if (
            not isinstance(functions, list)
            or len(functions) != 1
            or functions[0].get("source") != "functions"
            or functions[0].get("codebase") != "default"
        ):
            raise RolloutError(
                "Changed Function codebase needs explicit inventory support"
            )
        targets = read_json(
            ["node", str(ROOT / "scripts/firebase-function-targets.cjs")],
            args.command_timeout,
        )
        if not targets or any(
            not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]*", t.get("name", ""))
            or t.get("region") != "us-central1"
            for t in targets
        ):
            raise RolloutError("Invalid Function inventory")
        if len({t["name"] for t in targets}) != len(targets):
            raise RolloutError("Duplicate Function inventory")
        deployed = read_json(
            [
                "gcloud",
                "functions",
                "list",
                "--v2",
                "--project",
                args.project,
                "--quiet",
                "--format=json(name)",
            ],
            args.command_timeout,
        )
        declared = {
            f"projects/{args.project}/locations/{t['region']}/functions/{t['name']}"
            for t in targets
        }
        if not isinstance(deployed, list) or any(
            f.get("name") not in declared for f in deployed
        ):
            raise RolloutError(
                "Undeclared deployed Functions require an explicit retirement plan"
            )
        expected = source_inventory()
        receipt.update({"targets": targets, "expected_source_sha256": expected})
        save()
        for target in targets:
            name, region = target["name"], target["region"]
            record = {"name": name, "region": region, "phase": "DEPLOY_MAY_BE_SENT"}
            receipt["functions"].append(record)
            save()
            print(f"Deploying {name} in {region}", flush=True)
            firebase(f"functions:{name}")
            record["phase"] = "VERIFYING"
            save()
            verify(record, expected)
        receipt["phase"] = "FINAL_VERIFICATION"
        save()
        for record in receipt["functions"]:
            verify(record, expected)
        receipt["phase"] = "OTHER_RESOURCES_MAY_BE_SENT"
        save()
        firebase("hosting,firestore:rules,storage")
        receipt["phase"] = "COMPLETE"
        save()
    except Exception as exc:
        receipt["phase"] = "FAILED_OR_UNCONFIRMED"
        receipt["error"] = (
            str(exc) if isinstance(exc, RolloutError) else type(exc).__name__
        )
        save()
        raise


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--receipt-dir", required=True)
    parser.add_argument("--command-timeout", type=float, default=900)
    parser.add_argument("--verify-timeout", type=float, default=120)
    options = parser.parse_args()
    if (
        not re.fullmatch(r"[a-z][a-z0-9-]+", options.project)
        or options.command_timeout <= 0
        or options.verify_timeout < 0
    ):
        parser.error("Invalid project or deadline")
    try:
        deploy(options)
    except Exception as error:
        print(
            str(error) if isinstance(error, RolloutError) else type(error).__name__,
            file=sys.stderr,
        )
        sys.exit(1)
