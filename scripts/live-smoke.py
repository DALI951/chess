#!/usr/bin/env python3
"""Live smoke test against the deployed site.

The PHP suite runs on a fake database, which is exactly why a site can be green
locally and 500 on every game creation: nothing local ever binds a real NOT NULL
column or a real native prepared statement. So this drives the actual endpoint
over HTTPS, with two real accounts, and checks the numbers that matter:

  register -> create -> join -> move -> resign -> rating moved for both players

Ratings are the last step on purpose. settleRatings() is a transaction behind
four different entry points, and a bug in it is invisible until a game actually
ends and two rows are written.

Usage:  python scripts/live-smoke.py [https://modali.powerpme.com/chess]
"""
import json
import random
import sys
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "https://modali.powerpme.com/chess").rstrip("/")

passed = 0
failed = 0


def check(ok, what, extra=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"  ok   {what}")
    else:
        failed += 1
        print(f"  FAIL {what}" + (f"  -> {extra}" if extra else ""))


class Client:
    """One logged-in session: keeps its own cookie jar, like a browser tab."""

    def __init__(self):
        self.cookies = {}
        self.user = None

    def post(self, path, body):
        url = f"{BASE}/api/{path}"
        data = json.dumps(body).encode()
        req = urllib.request.Request(url, data=data, method="POST", headers={
            "Content-Type": "application/json",
            "Origin": BASE.split("/chess")[0],
            **({"Cookie": "; ".join(f"{k}={v}" for k, v in self.cookies.items())} if self.cookies else {}),
        })
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                for hdr in r.headers.get_all("Set-Cookie") or []:
                    pair = hdr.split(";")[0]
                    if "=" in pair:
                        k, v = pair.split("=", 1)
                        self.cookies[k.strip()] = v.strip()
                return r.status, json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            raw = e.read()
            try:
                return e.code, json.loads(raw or b"{}")
            except ValueError:
                return e.code, {"_raw": raw[:200].decode("utf-8", "replace")}

    def register(self, tag):
        name = f"smoke_{tag}_{random.randint(1000, 9999)}"
        st, j = self.post("auth.php", {
            "action": "register", "username": name,
            "password": "smokepass123", "display_name": f"Smoke {tag}",
        })
        if st != 200 or not j.get("ok"):
            raise SystemExit(f"register failed for {name}: {st} {j}")
        self.user = j["user"]
        return self.user


def main():
    print(f"live smoke -> {BASE}\n")

    print("-- accounts")
    a, b = Client(), Client()
    ua = a.register("w")
    ub = b.register("b")
    check(ua["rating"] == 1500 and ub["rating"] == 1500, "both new accounts start at 1500",
          f"{ua['rating']}/{ub['rating']}")
    check(ua["id"] != ub["id"], "the two accounts are distinct", f"{ua['id']}/{ub['id']}")

    print("\n-- create and join")
    st, j = a.post("game.php", {"action": "create", "tc_base_ms": 600000, "tc_increment_ms": 0, "open": True})
    check(st == 200 and j.get("ok"), "create returns 200", f"{st} {j}")
    code = j.get("code")
    check(bool(code) and len(code) == 6, "a 6-character room code came back", str(code))
    check(j["game"]["status"] == "waiting", "an open game starts waiting", j["game"]["status"])
    check(j["game"]["rated"] is True, "the game is rated", str(j["game"].get("rated")))

    st, j = b.post("game.php", {"action": "join", "code": code})
    check(st == 200 and j.get("ok"), "the second player joins", f"{st} {j}")
    check(j["game"]["status"] == "active", "the game is active once both are seated", j["game"]["status"])

    print("\n-- play")
    st, j = a.post("game.php", {"action": "move", "code": code, "from": "e2", "to": "e4"})
    check(st == 200 and j.get("ok"), "white moves e2-e4", f"{st} {j}")
    check(j["game"]["ply"] == 1, "the move count advanced", str(j["game"].get("ply")))
    check("e4" in j["game"]["moves"], "the SAN of the move is recorded", str(j["game"].get("moves")))

    st, j = b.post("game.php", {"action": "move", "code": code, "from": "e7", "to": "e5"})
    check(st == 200 and j.get("ok"), "black moves e7-e5", f"{st} {j}")

    st, j = a.post("game.php", {"action": "move", "code": code, "from": "f1", "to": "c4"})
    check(st == 200 and j.get("ok"), "white moves Bc4", f"{st} {j}")
    check(j["game"]["turn"] == "black", "it is black's turn", str(j["game"].get("turn")))

    print("\n-- the server refuses nonsense")
    st, j = b.post("game.php", {"action": "move", "code": code, "from": "e5", "to": "e4"})
    check(not j.get("ok"), "moving a pawn twice is refused", f"{st} {j.get('error')}")
    st, j = b.post("game.php", {"action": "move", "code": code, "from": "e4", "to": "e5"})
    check(not j.get("ok"), "the opponent's own move is refused as illegal", f"{st} {j.get('error')}")
    # black is to move here, so this has to be an illegal move by BLACK or the
    # turn check answers it first and the test proves nothing about legality
    st, j = b.post("game.php", {"action": "move", "code": code, "from": "a8", "to": "a4"})
    check(j.get("error") == "illegal_move", "a rook cannot jump its own pawn", f"{st} {j.get('error')}")

    print("\n-- resign, and the ratings that follow")
    st, j = b.post("game.php", {"action": "resign", "code": code})
    check(st == 200 and j.get("ok"), "black resigns", f"{st} {j}")
    check(j["game"]["status"] == "ended", "the game is ended", str(j["game"].get("status")))
    check(j["game"]["reason"] == "resign", "the reason is recorded", str(j["game"].get("reason")))
    check(j["game"]["result"] == 1, "white won from white's point of view", str(j["game"].get("result")))

    st, j = a.post("social.php", {"action": "me"})
    check(st == 200 and j.get("ok"), "the winner's record reads back", f"{st} {j}")
    rec = j.get("record", {})
    check(rec.get("played") == 1 and rec.get("wins") == 1,
          "one game played, one win", json.dumps(rec))
    check(j["user"]["rating"] > 1500, "the winner's rating went up",
          f"{ua['rating']} -> {j['user']['rating']}")

    st, j = b.post("social.php", {"action": "me"})
    rec = j.get("record", {})
    check(rec.get("played") == 1 and rec.get("losses") == 1,
          "one game played, one loss", json.dumps(rec))
    check(j["user"]["rating"] < 1500, "the loser's rating went down",
          f"{ub['rating']} -> {j['user']['rating']}")

    print("\n-- rates only happen once")
    st, j = b.post("game.php", {"action": "resign", "code": code})
    check(not j.get("ok") or st != 200, "a second resignation is refused", f"{st} {j}")
    st, j = b.post("social.php", {"action": "me"})
    check(j.get("record", {}).get("played") == 1, "the record still says one game",
          json.dumps(j.get("record")))

    print("\n-- leaderboard")
    st, j = a.post("social.php", {"action": "leaderboard"})
    check(st == 200 and j.get("ok"), "the leaderboard loads", f"{st} {j}")
    check(any(p["username"] == ua["username"] for p in j.get("players", [])),
          "the new player is on it", str(len(j.get("players", []))))

    print("\n" + "=" * 60)
    print(f"{'ALL GREEN' if failed == 0 else f'{failed} FAILED'} - {passed + failed} checks live")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
