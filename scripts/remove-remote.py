#!/usr/bin/env python3
"""Take one file off the server, immediately.

scripts/credentials.local.json is gitignored but was never in deploy.py's
SKIP_FILES, so a deploy uploaded the SFTP password to a public URL. This removes
it (and the one-shot cleanup script, which has no business being there either)
without waiting for the fix to be written, deployed and verified.

    python scripts/remove-remote.py scripts/credentials.local.json api/db-cleanup.php
"""
import os
import sys

import paramiko

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from settings import sftp_password  # noqa: E402

HOST, USER = "modali.powerpme.com", "modali"
REMOTE = "/public_html/chess"


def main():
    targets = sys.argv[1:]
    if not targets:
        raise SystemExit(__doc__)
    pw = sftp_password()
    if not pw:
        raise SystemExit("no SFTP password. set CHESS_SFTP_PASS, or fill in scripts/credentials.local.json")

    t = paramiko.Transport((HOST, 22))
    t.connect(username=USER, password=pw)
    s = paramiko.SFTPClient.from_transport(t)
    try:
        for rel in targets:
            path = f"{REMOTE}/{rel.lstrip('/')}"
            try:
                s.remove(path)
                print(f"removed {rel}")
            except IOError as e:
                print(f"{rel}: nothing to remove ({e})")
    finally:
        s.close()
        t.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
