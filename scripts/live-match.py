#!/usr/bin/env python3
"""Live matchmaking check: two fresh accounts, nobody sends a code, and the
server has to put them in the same game by itself.

This is the whole point of the feature, so it is checked over HTTP against the
real server rather than in a unit test: if the query, the seat, the transaction
or the response shape is wrong, this is what notices.

    python scripts/live-match.py
"""
import sys
import time
import urllib.request
import urllib.error
import json
import http.cookiejar

BASE = "https://modali.powerpme.com/chess/api"
FAILS = []
CHECKS = [0]


def check(ok, label, detail=""):
    CHECKS[0] += 1
    if ok:
        print(f"  ok   {label}")
    else:
        FAILS.append(label)
        print(f"  FAIL {label}  {detail}")


class Client:
    """One signed-in player. The cookie jar is per instance, which is what makes
    this two different people rather than one confused one."""

    def __init__(self, tag):
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar))
        self.tag = tag
        # Named under the "probe" prefix on purpose: scripts/run-db-cleanup.py
        # deletes test accounts by that prefix, and a short prefix like "ma_"
        # would either be missed or start matching real usernames.
        self.name = f"probe_m{tag}_{int(time.time() * 1000) % 1000000}"

    def post(self, path, data):
        body = json.dumps({k: v for k, v in data.items() if v is not None}).encode()
        req = urllib.request.Request(
            f"{BASE}/{path}", data=body, method="POST",
            headers={"Content-Type": "application/json",
                     "Origin": "https://modali.powerpme.com"})
        try:
            with self.opener.open(req, timeout=30) as r:
                return r.status, json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            raw = e.read().decode()
            try:
                return e.code, json.loads(raw or "{}")
            except ValueError:
                return e.code, {"raw": raw[:200]}


def main():
    print(f"live matchmaking -> {BASE}\n")
    print("-- two strangers")
    a, b = Client("a"), Client("b")
    sa, ja = a.post("auth.php", {"action": "register", "username": a.name,
                                 "password": "matchpass123", "display_name": "M A"})
    sb, jb = b.post("auth.php", {"action": "register", "username": b.name,
                                 "password": "matchpass123", "display_name": "M B"})
    check(sa == 200 and ja.get("ok"), "player A registers", f"{sa} {ja.get('error')}")
    check(sb == 200 and jb.get("ok"), "player B registers", f"{sb} {jb.get('error')}")
    if FAILS:
        return 1

    print("\n-- A asks for quick play with nobody else waiting")
    sq, jq = a.post("game.php", {"action": "quick", "tc_base_ms": 180000,
                                 "tc_increment_ms": 2000})
    check(sq == 200 and jq.get("ok"), "quick play answers 200", f"{sq} {jq.get('error')}")
    check(jq.get("matched") is False, "with an empty queue it reports no match", str(jq.get("matched")))
    check(bool(jq.get("code")), "but it still hands back a room code", str(jq.get("code")))
    check(jq.get("game", {}).get("status") == "waiting", "and A is waiting in it",
          str(jq.get("game", {}).get("status")))
    code_a = jq.get("code")

    print("\n-- A is never matched with A")
    st, j = a.post("game.php", {"action": "quick", "tc_base_ms": 180000,
                                "tc_increment_ms": 2000})
    check(j.get("code") != code_a or j.get("matched") is False,
          "asking again does not seat A in A's own waiting game", str(j.get("code")))

    print("\n-- B asks, and the server has to do the pairing")
    sq, jq = b.post("game.php", {"action": "quick", "tc_base_ms": 180000,
                                 "tc_increment_ms": 2000})
    check(sq == 200 and jq.get("ok"), "quick play answers 200", f"{sq} {jq.get('error')}")
    check(jq.get("matched") is True, "B is told an opponent was found", str(jq.get("matched")))
    check(jq.get("code") == code_a, "B landed in A's room, not a new one",
          f"{jq.get('code')} vs {code_a}")
    check(jq.get("game", {}).get("status") == "active", "the game is live",
          str(jq.get("game", {}).get("status")))

    print("\n-- and it is a real game, not just a matching row")
    # publicState has no numeric id: the client addresses games by code.
    st, j = a.post("game.php", {"action": "state", "code": code_a})
    check(st == 200 and j.get("ok"), "A can read the game it was put in", f"{st} {j.get('error')}")
    g = j.get("game", {})
    check(g.get("status") == "active", "A sees it as active", str(g.get("status")))
    white, black = g.get("white") or {}, g.get("black") or {}
    check(bool(white.get("id")) and bool(black.get("id")),
          "both seats hold a real player", f"{white.get('id')} / {black.get('id')}")
    check(white.get("id") != black.get("id"), "and they are two different people",
          f"{white.get('id')} / {black.get('id')}")

    st, j = a.post("game.php", {"action": "move", "code": code_a,
                                "from": "e2", "to": "e4"})
    check(st == 200 and j.get("ok"), "A can play the opening move", f"{st} {j.get('error')}")
    st, j = b.post("game.php", {"action": "move", "code": code_a,
                                "from": "e7", "to": "e5"})
    check(st == 200 and j.get("ok"), "B can reply", f"{st} {j.get('error')}")

    print("\n-- a third player is never walked into a game in progress")
    c = Client("c")
    sc, jc = c.post("auth.php", {"action": "register", "username": c.name,
                                 "password": "matchpass123", "display_name": "M C"})
    st, j = c.post("game.php", {"action": "quick", "tc_base_ms": 180000,
                                "tc_increment_ms": 2000})
    check(st == 200 and j.get("ok"), "C gets a game", f"{st} {j.get('error')}")
    # C may legitimately be paired with a DIFFERENT waiting game (an earlier run
    # can leave one behind). What must never happen is C landing in a game that
    # already has two players in it, because that game has black_user set.
    check(j.get("code") != code_a, "and it is NOT the game A and B are playing",
          f"{j.get('code')} vs {code_a}")
    if j.get("matched"):
        cg = j.get("game", {})
        check(cg.get("status") == "active", "a matched game is genuinely live",
              str(cg.get("status")))

    print("\n" + "=" * 60)
    if FAILS:
        print(f"{len(FAILS)} FAILED - {CHECKS[0]} checks live")
        return 1
    print(f"ALL GREEN - {CHECKS[0]} checks live")
    return 0


if __name__ == "__main__":
    sys.exit(main())
