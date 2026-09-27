"""Read the setup token, so it is written down in exactly one place.

Three sources, in order: the environment, then .env, then the older
config.local.php. The .env reader here matches Config::parseDotEnv() in PHP:
a # does not start a comment mid-value unless whitespace comes first, and
quotes are stripped. The production password ends in "#", so a lazier reader
truncates it and the resulting "Access denied" blames the wrong thing.
"""
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def parse_dotenv(text):
    """-> {KEY: value}. Mirrors Config::parseDotEnv()."""
    out = {}
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        value = value.strip()
        if value[:1] in ('"', "'"):
            quote = value[0]
            end = value.rfind(quote)
            if end > 0:
                inner = value[1:end]
                if quote == '"':
                    inner = (inner.replace('\\n', "\n").replace('\\r', "\r")
                                 .replace('\\t', "\t").replace('\\"', '"')
                                 .replace('\\\\', '\\'))
                out[key] = inner
                continue
        # an inline comment needs whitespace before the #
        m = re.search(r"\s+#", value)
        if m:
            value = value[:m.start()].rstrip()
        out[key] = value
    return out


def load_token():
    """The setup token, or None. Callers must refuse to run without one."""
    v = os.environ.get("CHESS_SETUP_TOKEN")
    if v:
        return v
    env = os.path.join(ROOT, ".env")
    if os.path.isfile(env):
        with open(env, encoding="utf-8") as f:
            t = parse_dotenv(f.read()).get("CHESS_SETUP_TOKEN")
        if t:
            return t
    legacy = os.path.join(ROOT, "config.local.php")
    if os.path.isfile(legacy):
        with open(legacy, encoding="utf-8") as f:
            for line in f:
                if "setup_token" in line and "=>" in line:
                    return line.split("=>", 1)[1].strip().strip("',\" ")
    return None


def sftp_password():
    """The SFTP password: environment first, then the gitignored local file."""
    for var in ("CHESS_SFTP_PASS", "SITEHUB_SFTP_PASS", "DEKKAN_SFTP_PASS"):
        v = os.environ.get(var)
        if v:
            return v
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "credentials.local.json")
    if os.path.isfile(path):
        import json
        with open(path, encoding="utf-8") as f:
            return (json.load(f) or {}).get("sftp_password")
    return None
