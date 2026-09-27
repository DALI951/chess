# STATUS — handoff

**Project:** bilingual chess site (Arabic + English, full RTL) — `DALI951/chess`
**Live code:** https://github.com/DALI951/chess
**Live site:** https://modali.powerpme.com/chess/
**Local working copy:** `C:\Users\dali\chess` (branch `main`, remote `origin`)
**Written:** 2026-09-27

Read this first on any other machine. It is the state of play, what is actually
finished, what is not, and the traps that already cost time.

---

## 1. Where it stands

| Area | State |
|---|---|
| Rules engine (JS) | **Done and proven.** Perft-exact, differentially tested. |
| Rules engine (PHP) | **Done.** Mirrors the JS engine, shared 508-move corpus. |
| Playable UI | **Done.** Board, clocks, promotion, undo, flip, FEN, PGN, themes, sounds, AR/EN RTL. |
| Engine opponent | **Done.** Stockfish 17 WASM, correct MIME types on the server. |
| Accounts | **Live.** Register, login, sessions, remembered tokens, 1500 start. |
| Online multiplayer | **Live and verified end to end.** Create, join by code, moves, illegal-move refusal, resign, draw, flag, Elo settlement. |
| Chat | **Live,** seated players only. |
| Social | **Live.** Friends, friend requests, leaderboard. |
| Front door | **Live.** The account card is the first screen, with its own language switch, and one click through to playing without an account. |
| Database | **Live.** 9 tables installed on `modalidb`. |
| Deployment | **Live** at https://modali.powerpme.com/chess/ |

All seven suites are green: 595 PHP assertions, 102 JS assertions, UI smoke,
visual checks, a 43-assertion design audit, and the gate-flash suite.
`scripts/live-smoke.py` runs 30 checks against the real server and
`scripts/live-match.py` runs 22 more.

## 2. Deploying

```bash
python scripts/deploy.py            # needs CHESS_SFTP_PASS or scripts/credentials.local.json
python scripts/deploy.py --dry-run  # list what would go up, touch nothing
```

Wipes and re-uploads **only** `/public_html/chess`. The other ~25 sites sharing
`public_html` are not touched. Credentials come from the environment or the
gitignored `scripts/credentials.local.json`; there is no password in the repo.

`.env` holds the database password and is re-uploaded after the wipe, to
`/public_html/chess/.env` only. The app's `.htaccess` denies that filename — and
`.env.example` with it — so the request is refused before PHP ever runs.
`config.local.php` is the previous mechanism: `Config.php` still reads it if it
exists, and the deploy deletes it from the server.

## 3. Traps that already cost time

- **Connect to `modali.powerpme.com`, never the bare IP.** The IP
  `212.227.215.235` rejects the same credentials that work on the hostname, and
  that looks exactly like a wrong password.
- **`public_html` IS the web root.** A config file "one directory above the
  project" is still inside the document root and answers a public URL. The SFTP
  account is chrooted to `public_html`, so the app directory plus its
  `.htaccess` is the only safe spot that can be written to.
- **PDO has emulated prepares off.** Every repeated named placeholder in one
  statement must be unique (`:now` and `:now2`), or MySQL answers HY093.
  `tests/php/PrepareTest.php` fails the build if one ever slips back in.
- **Do not test a deployed `.php` with a GET.** It executes and returns an
  empty body. A 200 with 0 bytes proves only that the file parsed.
- **Never commit `.env` or `scripts/credentials.local.json`.** The deploy selects
  what to upload from `git ls-files`, so a gitignored file cannot reach the
  server even by accident, and it refuses to run if one shows up in the plan
  anyway. `python scripts/live-secrets.py` checks the deployed site answers 403
  or 404 for thirteen secret paths. **The SFTP password was published once by
  this bug and has been removed, but it still needs rotating in the hosting
  panel.**

## 4. The three bugs that broke online play

All three were the same shape: a value was written, and nothing checked that it
came back out of the database.

1. **`GameRepo::save()` did not write `white_user` or `black_user`.** `seat()`
   set the black seat and flipped the status to active, then called `save()`,
   which updated every column except the two recording *who is playing*. The
   join looked successful, the lobby showed an active game, and then the second
   player's own moves came back `not_a_player` and their resignation threw
   "only a player can resign". The game was on, in the database, with nobody in
   it. `tests/php/GameContractTest.php` now asserts `save()` mentions every
   column the rest of the code mutates.

2. **`GameRepo::play()` fetched the move history and never passed it on.**
   `GameState::engine()` was handed an empty SAN list, so it rebuilt the
   position from `Chess::START_FEN` on every single move and always reported
   white to move. Black's first move came back `not_your_turn`, and white's
   second was rejected as `illegal_move` because the engine still thought it was
   black's move. One player could play one move and the game was stuck forever.
   `engine()` now loads the stored FEN, which is the position the next move is
   played from, and the SAN replay is only the fallback for a game with no FEN.

3. **`settleRatings()` bailed on `!empty($game['rated'])`, and `rated` is not a
   column on `games`.** `create()` set the key, `insert()` did not persist it,
   so on any row read back from the table the key was simply absent, `!empty()`
   was false, and the function returned before writing anything. Every game on
   the site ended correctly and moved nobody's rating, and nothing said so. An
   absent `rated` now means rated.

`games.sans` was stale for the same reason as (1) — `save()` writes the column
and `applyMove()` now maintains it — so a row read on its own reports the moves
that were actually played.
