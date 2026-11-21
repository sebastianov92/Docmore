#!/usr/bin/env python3
"""Merges new Spanish texts into tools/strings.es.json.

    tools/add-strings.py <<'JSON'
    { "English key": "Texto en espanol" }
    JSON

Keeps the table sorted the way it was (insertion order) and rewrites it with
non-ASCII characters escaped, like the rest of the file.
"""
import json
import os
import sys

TABLE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "strings.es.json")
table = json.load(open(TABLE, encoding="utf-8"))
table.update(json.load(sys.stdin))
with open(TABLE, "w", encoding="utf-8") as handle:
    json.dump(table, handle, ensure_ascii=True, indent=2)
    handle.write("\n")
print("%d translations" % len(table))
