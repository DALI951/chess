#!/usr/bin/env python3
"""Check that nothing secret answers a public URL.

    python scripts/live-secrets.py [https://modali.powerpme.com/chess]

This exists because a deploy once published the SFTP password. Nothing failed:
the site worked, every test suite was green, and
https://modali.powerpme.com/chess/scripts/credentials.local.json returned the
password in plain text. A test that only asks "does the app work" cannot see
that, because the app was working.

So this asks the only question that matters about a secret file: does the
server give it to a stranger? The answer has to be a refusal - 403 from
.htaccess, or 404 because the file was never deployed - and anything else,
including a 200, fails the check.

Read-only: it issues GETs and looks at status codes. It never authenticates.
"""
import sys
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://modali.powerpme.com/chess").rstrip("/")

# Path -> why it must never be readable. A 200 on any of these is the bug.
FORBIDDEN = {
    ".env":                    "the database password and setup token",
    ".env.example":            "documents the shape of the one above",
    ".env.local":              "an env file local override",
    "config.local.php":        "the pre-.env secret file",
    "config.example.php":      "the template for it",
    "scripts/credentials.local.json": "the SFTP password",
    "credentials.local.json":  "the same file at the project root",
    "scripts/db-cleanup.php":  "token-guarded row deletion, uploaded only transiently",
    "api/db-cleanup.php":      "the same, at its runtime path",
    "api/setup.php":           "the one-shot installer",
    "setup.php":               "the same, at the project root",
    ".git/config":             "the repository itself",
    ".gitignore":              "not secret, but it is a map of what is",
}

# These must be readable, or the check is only proving the server is down.
REQUIRED = ["", "index.html", "assets/css/style.css", "assets/js/app.js"]

fails = 0


def status(url):
    req = urllib.request.Request(url, headers={"User-Agent": "live-secrets/1"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, len(r.read())
    except urllib.error.HTTPError as e:
        return e.code, 0
    except Exception as e:  # noqa: BLE001  (any failure to answer is not a pass)
        return f"unreachable ({type(e).__name__})", 0


print(f"secrets audit -> {BASE}\n")
print("-- these must be refused")
for path, why in FORBIDDEN.items():
    code, size = status(f"{BASE}/{path}")
    # 403 is .htaccess doing its job. 404 is the file never being there.
    # 401 is a host-level refusal, which is also fine. Anything else is not.
    ok = code in (401, 403, 404)
    fails += 0 if ok else 1
    print(f"  {'ok  ' if ok else 'FAIL'} {code}  /{path}  ({why})"
          + (f"  <-- {size} bytes served" if code == 200 else ""))

print("\n-- and these must still work, or the audit proves nothing")
for path in REQUIRED:
    code, _ = status(f"{BASE}/{path}")
    ok = code == 200
    fails += 0 if ok else 1
    print(f"  {'ok  ' if ok else 'FAIL'} {code}  /{path}")

print("\n" + "=" * 60)
if fails:
    print(f"{fails} SECRET EXPOSURE CHECK(S) FAILED")
    sys.exit(1)
print(f"NO SECRET ANSWERS A PUBLIC URL - {len(FORBIDDEN)} refused, {len(REQUIRED)} served")
