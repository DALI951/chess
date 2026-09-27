#!/usr/bin/env python3
"""Run the one-shot schema installer on the live server, then lock it down again.

The .htaccess denies api/setup.php at the web server, which is the second lock
on top of the token. To run the installer over HTTPS both have to come off for
exactly one request - so this script:

  1. lifts only the setup.php deny (nothing else in .htaccess is touched)
  2. POSTs the token
  3. puts the original .htaccess back byte for byte
  4. deletes api/setup.php, so there is no second run to worry about

If any step throws, the restore in the finally block still happens: a failed
install must not leave the installer exposed.
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
REMOTE_ROOT = "/public_html/chess"
HT_REMOTE = f"{REMOTE_ROOT}/.htaccess"
URL = "https://modali.powerpme.com/chess/api/setup.php"
CREDS_FILE = os.path.join(HERE, "credentials.local.json")


from settings import load_token, sftp_password  # noqa: E402  (path set above)

DENY_BLOCK = """<FilesMatch "^(setup\\.php)$">
    Require all denied
</FilesMatch>"""


def connect():
    pw = sftp_password()
    if not pw:
        raise SystemExit("no SFTP password. set CHESS_SFTP_PASS, or fill in scripts/credentials.local.json")
    t = paramiko.Transport((HOST, 22))
    t.connect(username=USER, password=pw)
    return t, paramiko.SFTPClient.from_transport(t)


def main():
    token = load_token()
    if not token:
        raise SystemExit("no setup token. set CHESS_SETUP_TOKEN, or put one in .env")

    t, s = connect()
    original = None
    try:
        with s.open(HT_REMOTE, "rb") as f:
            original = f.read()
        text = original.decode("utf-8")
        if DENY_BLOCK not in text:
            print("the deny block was not found verbatim - refusing to guess")
            return 1

        lifted = text.replace(DENY_BLOCK, "# (installer temporarily unlocked by deploy)")
        with s.open(HT_REMOTE, "wb") as f:
            f.write(lifted.encode("utf-8"))
        print("unlocked setup.php")

        req = urllib.request.Request(
            URL, data=b"{}", method="POST",
            headers={"X-Setup-Token": token, "Content-Type": "application/json",
                     "Origin": "https://modali.powerpme.com"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                print("HTTP", r.status)
                print(r.read().decode("utf-8", "replace")[:1200])
        except urllib.error.HTTPError as e:
            print("HTTP", e.code)
            print(e.read().decode("utf-8", "replace")[:1200])
    finally:
        # restore the exact bytes we found, whatever happened
        if original is not None:
            with s.open(HT_REMOTE, "wb") as f:
                f.write(original)
            print("restored .htaccess")
        # and remove the one-shot installer entirely
        try:
            s.remove(f"{REMOTE_ROOT}/api/setup.php")
            print("deleted api/setup.php from the server")
        except IOError as e:
            print("api/setup.php already gone:", e)
        s.close()
        t.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
