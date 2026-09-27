#!/usr/bin/env python3
"""Remove the accounts and games scripts/live-smoke.py left behind.

Same shape as run-setup.py: put the one-shot script on the server, call it, take
it off again. The script itself is token-guarded and refuses to run unless every
user in the table is a test account, so this is safe to point at production.

    python scripts/run-db-cleanup.py            # dry run, deletes nothing
    python scripts/run-db-cleanup.py --apply    # actually delete

Why it exists: the site has no delete-account feature, so the live smoke test
cannot tidy up after itself. Left alone, a couple of runs later the leaderboard
reads "Smoke w 1516" at the top.
"""
import os
import sys
import json
import urllib.request
import urllib.error

import paramiko

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
HOST, USER = "modali.powerpme.com", "modali"
REMOTE = f"/public_html/chess/api/db-cleanup.php"
URL = "https://modali.powerpme.com/chess/api/db-cleanup.php"
CREDS_FILE = os.path.join(HERE, "credentials.local.json")


def sftp_password():
    for var in ("CHESS_SFTP_PASS", "SITEHUB_SFTP_PASS", "DEKKAN_SFTP_PASS"):
        v = os.environ.get(var)
        if v:
            return v
    if os.path.isfile(CREDS_FILE):
        with open(CREDS_FILE, encoding="utf-8") as f:
            return (json.load(f) or {}).get("sftp_password")
    return None


def load_token():
    v = os.environ.get("CHESS_SETUP_TOKEN")
    if v:
        return v
    path = os.path.join(ROOT, "config.local.php")
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                if "setup_token" in line and "=>" in line:
                    return line.split("=>", 1)[1].strip().strip("',\" ")
    return None


def main():
    apply_ = "--apply" in sys.argv
    pw, token = sftp_password(), load_token()
    if not pw:
        raise SystemExit("no SFTP password. set CHESS_SFTP_PASS, or fill in scripts/credentials.local.json")
    if not token:
        raise SystemExit("no setup token. set CHESS_SETUP_TOKEN, or put one in config.local.php")

    t = paramiko.Transport((HOST, 22))
    t.connect(username=USER, password=pw)
    s = paramiko.SFTPClient.from_transport(t)
    try:
        s.put(os.path.join(HERE, "db-cleanup.php"), REMOTE)
        print("uploaded the cleanup script")

        url = f"{URL}?mode={'apply' if apply_ else 'dry'}&t={token}"
        req = urllib.request.Request(url, headers={"Origin": "https://modali.powerpme.com"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                print(r.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            print("HTTP", e.code)
            print(e.read().decode("utf-8", "replace"))
    finally:
        # it deletes rows, so it does not stay on a public URL
        try:
            s.remove(REMOTE)
            print("\ndeleted the cleanup script from the server")
        except IOError:
            pass
        s.close()
        t.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
