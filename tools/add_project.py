#!/usr/bin/env python3
"""Add (or update) a project entry in wrangler.toml's PROJECTS block.

The PROJECTS var is a JSON object inside a TOML triple-quoted string;
this rewrites only that block, preserving the rest of the file.
"""
import argparse
import json
import re
import sys
import tomllib
from pathlib import Path

TOML = Path(__file__).resolve().parent.parent / "wrangler.toml"

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("name", help="project id (used in the /v1/<name> route)")
parser.add_argument("--origin", action="append", default=[], dest="origins",
                    help="allowed page Origin (repeatable); none = allow all")
parser.add_argument("--api-base",
                    default="https://generativelanguage.googleapis.com/v1beta/openai",
                    help="OpenAI-compatible endpoint (default: Gemini)")
parser.add_argument("--model", default="gemini-3.5-flash",
                    help="server-pinned model (default: %(default)s)")
parser.add_argument("--key", default="KEY_GEMINI",
                    help="Worker secret name holding the API key (default: %(default)s)")
parser.add_argument("--max-body", type=int, default=None,
                    help="request size cap in bytes (default: worker's 80000)")
args = parser.parse_args()

if not re.fullmatch(r"[\w-]+", args.name):
    sys.exit(f"project name {args.name!r} must match [\\w-]+ (it becomes a URL segment)")

src = TOML.read_text()
projects = json.loads(tomllib.loads(src)["vars"]["PROJECTS"])

entry = {"origins": args.origins, "apiBase": args.api_base,
         "model": args.model, "keySecret": args.key}
if args.max_body:
    entry["maxBodyBytes"] = args.max_body
verb = "updated" if args.name in projects else "added"
projects[args.name] = entry

block = "PROJECTS = '''\n" + json.dumps(projects, indent=2) + "\n'''"
out, n = re.subn(r"PROJECTS = '''.*?'''", block, src, count=1, flags=re.S)
if n != 1:
    sys.exit("could not find the PROJECTS = '''...''' block in wrangler.toml")
TOML.write_text(out)

# Round-trip check: the file must still parse to the projects we intended.
assert json.loads(tomllib.loads(out)["vars"]["PROJECTS"]) == projects
print(f"{verb} {args.name}: model={args.model} key={args.key} "
      f"origins={','.join(args.origins) or '* (all)'}")
