"""Fetch one GitHub URL into the lab and record each HTTP body, including failures."""
from pathlib import Path
from urllib.parse import urlsplit
import json
import subprocess
import sys

url, name, revision = sys.argv[1:]
dest = Path("logs/r6/downloads")
ledger = dest / "requests.jsonl"
spent = sum(json.loads(line)["body_bytes"] for line in ledger.read_text().splitlines()) if ledger.exists() else 0
cap = 60_000_000 - spent
if urlsplit(url).scheme != "https" or urlsplit(url).hostname not in {"api.github.com", "github.com", "codeload.github.com", "raw.githubusercontent.com"}:
    sys.exit("GitHub HTTPS only")
if cap < 1 or "/" in name or (dest / name).exists():
    sys.exit("cap or filename")
cmd = ["curl", "-q", "--silent", "--show-error", "--max-time", "60", "--max-filesize", str(min(cap, 10_000_000)),
       "--proto", "=https", "-o", str(dest / name), "-w", "%{http_code} %{size_download}", url]
p = subprocess.run(cmd, stdout=subprocess.PIPE, text=True)
status, count = p.stdout.split()
rec = dict(url=url, revision=revision, file=name, http=int(status), body_bytes=int(count), curl_exit=p.returncode)
with ledger.open("a") as out:
    print(json.dumps(rec), file=out)
print(rec)
sys.exit(p.returncode or (0 if status == "200" else 1))
