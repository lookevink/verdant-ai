#!/usr/bin/env python3
"""Apply a prepared, reviewed SQL import atomically using a temporary CLI login.
Keeps connection credentials in child-process environment, never shell-evals CLI output.
"""

import argparse
import hashlib
import json
import os
import shlex
import subprocess
from pathlib import Path

p = argparse.ArgumentParser(description=__doc__)
p.add_argument("sql", type=Path)
p.add_argument("--project-ref", required=True)
p.add_argument("--environment", choices=["sandbox", "production"], required=True)
args = p.parse_args()
receipt = json.loads(args.sql.with_suffix(".json").read_text())
if receipt["environment"] != args.environment:
    raise SystemExit("Import environment mismatch")
if receipt["sql_sha256"] != hashlib.sha256(args.sql.read_bytes()).hexdigest():
    raise SystemExit("Import SQL digest mismatch")
# --dry-run creates a short-lived CLI login and prints a pg_dump environment, without dumping.
r = subprocess.run(
    [
        "supabase",
        "db",
        "dump",
        "--linked",
        "--project-ref",
        args.project_ref,
        "--dry-run",
    ],
    capture_output=True,
    text=True,
)
if r.returncode:
    raise SystemExit(
        "Supabase temporary connection discovery failed; no import executed"
    )
allowed = {"PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"}
connection = {}
for line in r.stdout.splitlines():
    if line.startswith("export "):
        parts = shlex.split(line)
        if len(parts) == 2 and "=" in parts[1]:
            key, value = parts[1].split("=", 1)
            if key in allowed:
                connection[key] = value
if set(connection) != allowed:
    raise SystemExit("Incomplete temporary connection; no import executed")
# The application's existing service role has the required private-schema grants.
# Do not assume the broad postgres role for a data import.
r = subprocess.run(
    [
        "psql",
        "-X",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        "set role service_role",
        "-f",
        str(args.sql.resolve()),
    ],
    env={**os.environ, **connection, "PGSSLMODE": "require"},
    capture_output=True,
    text=True,
)
if r.returncode:
    # Redact any connection value if a client error happens to include it.
    error = r.stderr
    for value in connection.values():
        error = error.replace(value, "[redacted]")
    raise SystemExit(error)
print(
    json.dumps(
        {
            "status": "committed",
            "environment": args.environment,
            "project_ref": args.project_ref,
            "sql_sha256": receipt["sql_sha256"],
            "dataset_ids": receipt["dataset_ids"],
        }
    )
)
