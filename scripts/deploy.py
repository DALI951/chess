#!/usr/bin/env python3
"""Deploy the chess site to /public_html/chess on modali.powerpme.com.

Same shape as the sitehub/dekkan deploy scripts: paramiko Transport -> SFTP ->
wipe the app folder -> re-upload. Two things worth knowing about this one:

  * The host must be modali.powerpme.com. Connecting to the bare IP
    212.227.215.235 fails authentication on the same credentials, which looks
    exactly like a wrong password and is not one.

  * .env holds the database password. It goes to exactly one place, the app's
    own directory, which the .htaccess beside it denies. It must never be
    written to /public_html/, which is the document root. The deploy also
    removes the old config.local.php from the server, since Config.php reads
    .env first and a stale copy of the password lying around is a liability.

Credentials come from the environment, or from scripts/credentials.local.json
(gitignored), so a password never lands in a commit. Usage:

    set CHESS_SFTP_PASS=...            # or fill in credentials.local.json
    python scripts/deploy.py
    python scripts/deploy.py --dry-run
"""
import json
import os
import subprocess
import sys
import posixpath
import stat
import socket
import paramiko

HOST = "modali.powerpme.com"
USER = "modali"
REMOTE = "/public_html/chess"
CONFIG_REMOTE = f"{REMOTE}/.env"
# The old config file. It used to hold the same password in the same place, so
# every deploy deletes it from the server rather than leaving it to rot there.
LEGACY_REMOTE = f"{REMOTE}/config.local.php"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".github", "shots", "test-results"}
# the template and the real config are both handled explicitly below
# Anything git tracks that must still not have a public URL. `.env` is uploaded
# explicitly further down, because it is the one secret the server genuinely
# needs; the others are only ever uploaded transiently, by the script that uses
# them, which takes them off again afterwards.
SKIP_FILES = {
    "config.example.php", "config.local.php",
    ".env", ".env.example", ".env.local",
    # a token-guarded row-deleting script has no business having a permanent URL
    "db-cleanup.php", "setup.php",
}

# Replaced with a content hash on every deploy. See the block in main().
STAMP_TOKEN = "ASSETSTAMP"
# Text files get the token substituted; everything else is uploaded byte for byte.
TEXT_EXT = {".html", ".js", ".mjs", ".css", ".json", ".txt", ".md"}

CREDS_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "credentials.local.json")


def creds():
    """(password, where it came from). Never returns a value it did not read."""
    for var in ("CHESS_SFTP_PASS", "SITEHUB_SFTP_PASS", "DEKKAN_SFTP_PASS"):
        v = os.environ.get(var)
        if v:
            return v, var
    if os.path.isfile(CREDS_FILE):
        try:
            with open(CREDS_FILE, encoding="utf-8") as f:
                data = json.load(f)
            v = data.get("sftp_password") or data.get("password")
            if v:
                return v, os.path.basename(CREDS_FILE)
        except (OSError, ValueError) as e:
            print(f"could not read {CREDS_FILE}: {e}")
    return None, None


def walk(base):
    """The files to upload, taken from git rather than from the filesystem.

    This used to walk the directory and skip a hand-written list of filenames.
    That list is the wrong shape for the job: it can only name the secrets
    somebody remembered, and a new gitignored file is invisible to it. So
    scripts/credentials.local.json - the SFTP password - was uploaded to a
    public URL, because nobody had added it to the list.

    `git ls-files` cannot have that failure. Anything in .gitignore is, by
    definition, not in the index, so it cannot be selected here. The secret
    files stop being a thing to remember and become a thing that is impossible.
    """
    tracked = git_tracked(base)
    out = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            if fn in SKIP_FILES:
                continue
            # A dotfile has no business on a web server except the one that makes
            # it safe. .gitignore was being published, which is harmless on its
            # own and an invitation on its own terms: it is a list of the exact
            # filenames an attacker should try.
            if fn.startswith(".") and fn != ".htaccess":
                continue
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, base).replace(os.sep, "/")
            if tracked is not None and rel not in tracked:
                # untracked and not gitignored: a build artefact, or something
                # that was never added. Deploying a file git does not know about
                # is how a machine-local file ends up on the internet.
                continue
            out.append((rel, full))
    return out


def gitignored_in_plan(base, rels):
    """Which of these paths does git ignore? Empty if git cannot answer.

    -z matters here, on both sides. Without it git quotes any path it thinks
    needs escaping, and on Windows writing text=True to a subprocess' stdin
    turns every "\\n" into "\\r\\n" - so the last path on each line arrives
    carrying a phantom carriage return and the comparison silently stops
    matching. That is how a guard like this passes while catching nothing. And
    -z makes the INPUT NUL-separated too, so the patterns go out joined by NUL
    with a trailing one, and the output comes back the same way, unquoted.

    Note that .env is in the plan on purpose and is gitignored; the caller
    uploads it explicitly, so it is allowed through here.
    """
    allowed = {".env"}
    paths = [p for p in rels if p not in allowed]
    if not paths:
        return []
    try:
        r = subprocess.run(
            ["git", "-C", base, "check-ignore", "-z", "--stdin"],
            input=("\0".join(paths) + "\0").encode("utf-8"),
            capture_output=True, timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return []          # cannot check: walk() is still filtering by git ls-files
    if r.returncode not in (0, 1):
        return []
    return [p for p in r.stdout.decode("utf-8", "replace").split("\0") if p.strip()]


def git_tracked(base):
    """Every path git has in the index, as posix relative paths. None if git is
    unavailable, which makes walk() fall back to walking the tree - the old,
    unsafe behaviour, so this says so out loud rather than pretending."""
    try:
        r = subprocess.run(
            ["git", "-C", base, "ls-files", "-z"],
            capture_output=True, timeout=60, check=True,
        )
    except (OSError, subprocess.SubprocessError) as e:
        print(f"WARNING: git ls-files failed ({e}).")
        print("WARNING: falling back to walking the directory, so a gitignored")
        print("WARNING: secret CAN be uploaded. Commit your secrets' .gitignore")
        print("WARNING: rules and make sure git is on PATH, or check SKIP_FILES.")
        return None
    return {p for p in r.stdout.decode("utf-8", "replace").split("\0") if p}


def rm_rf(sftp, path):
    try:
        st = sftp.stat(path)
    except IOError:
        return
    if stat.S_ISDIR(st.st_mode):
        for item in sftp.listdir(path):
            rm_rf(sftp, posixpath.join(path, item))
        try:
            sftp.rmdir(path)
        except IOError:
            pass
    else:
        sftp.remove(path)


def asset_stamp(root):
    """A short hash of the cacheable assets, used as their ?v= query string.

    Hashes CONTENT, not mtimes, so touching a file changes nothing and editing
    one changes only what it should. Covers every module the page loads plus the
    stylesheet: app.js is a module graph, so a change deep in engine.js has to
    bust the entry point too, and a per-file hash would miss exactly that.
    """
    import hashlib
    h = hashlib.sha256()
    targets = [
        "assets/js/app.js", "assets/js/api.js", "assets/js/online.js",
        "assets/js/i18n.js", "assets/js/engine.js", "assets/js/pieces.js",
        "assets/js/worker-ai.js", "assets/css/style.css",
    ]
    for rel in targets:
        path = os.path.join(root, rel)
        h.update(rel.encode("utf-8"))
        if os.path.isfile(path):
            with open(path, "rb") as f:
                h.update(f.read())
    return h.hexdigest()[:10]


def main():
    dry = "--dry-run" in sys.argv
    pw, src = creds()
    if not pw:
        print("no credentials.")
        print(f"  set CHESS_SFTP_PASS, or put {{\"sftp_password\": \"...\"}} in {CREDS_FILE}")
        return 1
    print(f"credentials from {src}")

    try:
        socket.create_connection((HOST, 22), timeout=10).close()
    except OSError as e:
        print(f"{HOST}:22 unreachable ({e})")
        return 1

    t = paramiko.Transport((HOST, 22))
    t.connect(username=USER, password=pw)
    sftp = paramiko.SFTPClient.from_transport(t)
    print("connected")

    def mkdirs(path):
        cur = ""
        for p in path.strip("/").split("/"):
            cur += "/" + p
            try:
                sftp.stat(cur)
            except IOError:
                sftp.mkdir(cur)

    mkdirs(REMOTE)
    print(f"ensured {REMOTE}")

    if not dry:
        # wipe the app folder only, so stale files never stick. Everything else
        # in public_html - the other ~25 sites - is not touched.
        for item in sftp.listdir(REMOTE):
            if item in (".", ".."):
                continue
            rm_rf(sftp, posixpath.join(REMOTE, item))
        print("cleared old contents")

    files = walk(ROOT)
    files.sort()

    # Belt and braces, and the check that would have caught the credentials leak.
    # walk() already selects from `git ls-files`, so a gitignored file cannot get
    # in - but that is one mechanism doing all the work, and this asserts the
    # outcome directly. If a future change to walk() reintroduces the old
    # "skip a list of filenames I remembered" behaviour, the deploy stops here
    # with the name of the file in it, instead of publishing a password.
    leaks = gitignored_in_plan(ROOT, [rel for rel, _ in files])
    if leaks:
        print("\nREFUSING TO DEPLOY. These files are gitignored and must not be uploaded:")
        for rel in leaks:
            print(f"   {rel}")
        print("\nIf one of these is genuinely meant to be public, un-ignore it and")
        print("commit that, rather than adding it to SKIP_FILES here.")
        return 1

    # --- the cache stamp --------------------------------------------------------
    # .htaccess serves every .js and .css as max-age=31536000, immutable: one
    # year, and the browser is told never to come back and ask. That is correct
    # ONLY if the URL changes when the file does, and until now it did not -
    # index.html asked for "assets/js/app.js" forever. So a browser that visited
    # once kept the first app.js it ever downloaded, and every later fix -
    # including a broken promotion picker and dead quick-play buttons - was
    # invisible to anyone who had the site open. The code on the server was right
    # and the code in the browser was a year old, and nothing said so.
    #
    # The fix is a content hash in the query string, so the stamp is derived from
    # the files rather than remembered by a human: identical assets produce an
    # identical URL and stay cached, changed assets produce a new URL that no
    # cache has seen. Nobody has to bump anything.
    #
    # It replaces the ASSETSTAMP token in EVERY text asset, not just index.html,
    # and that detail is the whole ballgame. Stamping only the <script> tag fixes
    # the entry point and nothing else: app.js is a module graph, and its
    # imports - './engine.js', './i18n.js', './online.js' - are relative
    # specifiers that do NOT inherit the query string of the importer. So the
    # browser would fetch a brand new app.js and then reach straight into its
    # cache for last month's i18n.js. Fresh entry point, stale everything it
    # imports, which is a worse failure than uniform staleness because it looks
    # like a partial fix.
    stamp = asset_stamp(ROOT)
    print(f"asset stamp: {stamp}  (replaces ASSETSTAMP in every html/js/css)")

    stamped = 0
    for rel, full in files:
        remote = posixpath.join(REMOTE, rel)
        ext = os.path.splitext(rel)[1].lower()
        if ext in TEXT_EXT:
            with open(full, "rb") as f:
                text = f.read().decode("utf-8")
            hits = text.count(STAMP_TOKEN)
            text = text.replace(STAMP_TOKEN, stamp)
            if dry:
                print("  DRY put", rel, f"({hits} stamp{'s' if hits != 1 else ''})")
                continue
            mkdirs(posixpath.dirname(remote))
            with sftp.open(remote, "wb") as f:
                f.write(text.encode("utf-8"))
            stamped += hits
            print("  put", rel, f"({hits} stamp{'s' if hits != 1 else ''})" if hits else "")
            continue
        if dry:
            print("  DRY put", rel)
            continue
        mkdirs(posixpath.dirname(remote))
        sftp.put(full, remote)
        print("  put", rel)

    if stamped == 0:
        print("  !! no ASSETSTAMP token found anywhere - the site will not cache-bust")
    else:
        print(f"cache-busted {stamped} references")


    # The real config, re-uploaded every time because the wipe above removes it.
    # Its path is fixed: the SFTP account is chrooted to public_html, so there is
    # nowhere above the app to write, and it has to sit where the .htaccess
    # denies the name.
    local_env = os.path.join(ROOT, ".env")
    if os.path.isfile(local_env):
        if dry:
            print("  DRY put .env")
        else:
            sftp.put(local_env, CONFIG_REMOTE)
            print("  put .env (into the path .htaccess denies)")
    else:
        print("  !! no local .env - the API will not boot")

    # Remove the old PHP config from the server. It held the same password in
    # the same directory, and leaving a superseded secret on a live server is
    # just a second thing to forget about.
    if not dry:
        try:
            sftp.remove(LEGACY_REMOTE)
            print("  removed the old config.local.php from the server")
        except IOError:
            pass

    sftp.close()
    t.close()
    print(f"\n{'would deploy' if dry else 'done'}: {len(files)} files -> {REMOTE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
