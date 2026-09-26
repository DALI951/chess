# STATUS — handoff

**Project:** bilingual chess site (Arabic + English, full RTL) — `DALI951/chess`
**Live code:** https://github.com/DALI951/chess
**Local working copy:** `C:\Users\dali\chess` (branch `main`, remote `origin`)
**Last commit:** `307880c` — *Playable chess SPA, PHP engine mirror, UI test suites, brand options*
**Written:** 2026-09-26

Read this first on any other machine. It is the state of play, what is actually
finished, what is not, and the traps that already cost time.

---

## 1. Where it stands

| Area | State |
|---|---|
| Rules engine (JS) | **Done and proven.** Perft-exact, differentially tested. |
| Rules engine (PHP) | **Done.** Mirrors the JS engine, shared 508-move corpus. |
| Playable UI | **Done for phase 1.** Board, clocks, promotion, undo, flip, FEN, PGN, themes, sounds, AR/EN RTL. |
| Engine opponent | **Placeholder.** Local alpha-beta in a worker, not Stockfish. |
| Brand / name | **Waiting on Dali.** Three options built, see §4. |
| Accounts | Not started. |
| Online multiplayer | Not started. |
| Database | Not started. No schema exists yet. |
| Deployment | Not started. Nothing on the web host. |

## 2. Run it

```bash
npm run serve:php        # -> http://127.0.0.1:8080
```

PHP is auto-detected (env `PHP_BIN`, then `tools/php/php.exe`, then standard
install paths). There is **no build step** — the app is plain ES modules, so it
also runs straight from `file://`.

## 3. Tests — all four suites are green

```bash
npm run test:everything
```

| Command | Count | Proves |
|---|---|---|
| `npm test` | 102 | Engine: perft, SAN, PGN, differential vs an independent engine |
| `npm run test:php` | 380 assertions | PHP engine does the same, and replays the shared corpus |
| `npm run test:ui` | 62 | Real browser: clicks, drag, promotion, undo, flip, mate, themes, AR/EN, 390px phone, increment, no console errors |
| `npm run test:visual` | 12 | Piece contrast per theme, one-colour rule, tap targets, clipped labels |

`npm run test:ui:shots` writes screenshots to `tools/shots/` (gitignored).
`node tools/brand-shots.mjs` regenerates the brand shots in `brand/shots/`.

## 4. Blocked on a decision: the name

Three options are built as one reviewable page: **`brand/index.html`**
(served at `http://127.0.0.1:8080/brand/`, shots in `brand/shots/`).

- **KERSAT / كُرسات** — Arabic for "lessons". Best *lesson* name, worst *app* name.
- **SHATRANGI / شطرنجي** — heritage, eight-pointed star mark. **Recommended**, but Dali's call.
- **DUBES / دوباس** — invented, punchy, meaningless.

**Do not pick for him.** `config.example.php` currently has `'name' => 'kersat'`
as a placeholder — change it once he decides.

## 5. Real bugs this project has already hit

Kept because each one is a trap that will still be there next time.

**Engine**
- The FEN parser inferred piece **colour from the row index** instead of the letter
  case, so every non-back-rank position loaded with its colours — and its kings —
  swapped. Worst bug of the project.
- `perftDivide` listed *pseudo-legal* moves, so illegal replies showed as zero-count
  rows and the row count lied about the position.
- PGN emitted a stale `[FEN]` for standard starts, and the unfinished-game regex
  `\b*\b` can never match a bare `*` (`*` is not a word character).
- `moveSan()` rejected valid SAN that omitted the optional `+`/`#` suffix.

**UI** — none of these are visible to a unit test, all were found by a real browser
- `[hidden]` was overridden by a later `display:grid`, so an **invisible overlay ate
  every board click**.
- `isWhite === turn` compared a boolean to `0/1`, so the turn labels and the
  is-turn glow were permanently dead.
- Passing `legal[0].promotion` into the move call **forced every promotion to
  queen** and made the picker unreachable. Pass a promotion only when the target
  is unambiguous.
- The promotion box hung off the top row and `overflow:hidden` clipped it, putting
  the button centres outside the board where nothing could click them.
- Coordinate labels were anchored to the a-file, so they jumped to the other side
  of the board on flip. Anchor them to the viewer's left/bottom edge.
- **White pieces had no rim**: 1.12:1 contrast on the high-contrast theme and
  1.57:1 on wood, i.e. effectively invisible on half the board. Every piece now
  carries a stroke in the opposite direction.

## 6. Known open issues

- **`untimed` is broken.** Choosing it sets both clocks to `0`; the first tick
  subtracts a fraction and immediately ends the game as checkmate. Needs an
  `unlimited` flag. **This was being fixed when the session was stopped.**
- **Flag fall reports the wrong reason** — it shows checkmate instead of a
  time-up result.
- **Clocks ignore board flip.** `paintClocks()` hardcodes white to the top clock,
  so after flipping, each player's time sits under the other player's name.
- Arabic `resultStalemate` is an untranslated English leftover, and
  `resultCheckmate` uses the wrong word (`خطأ الملك` instead of `كش ملك`).
- Pieces are Unicode glyphs inside inline SVG `<text>`, not real piece art.
  Swap point: `assets/js/pieces.js`.
- `assets/js/worker-ai.js` is alpha-beta, not Stockfish WASM.
- No custom time control.
- Dead nav links to `#puzzles` and `#leaderboard` (phase-2 destinations).

## 7. Traps on this machine

- **No heredocs in PowerShell 5.1.** `git commit -F - <<MSG` is a parse error.
  Write the message to a file, then `git commit -F <file>`.
- **Pipe `node --test` through `Out-File -Encoding utf8` first.** Its summary lines
  vanish when piped straight into `Select-String`.
- **The console cannot print Arabic** — it renders as `?????`. Never conclude a
  file is corrupted from console output; check the bytes:
  `[System.IO.File]::ReadAllText($p, [Text.Encoding]::UTF8)`.
- `node --test tests/js/` (directory) fails on this box. Use the glob:
  `node --test "tests/js/*.test.mjs"`.
- **No image review is possible on this setup.** The model reads no images and the
  vision agent is broken (`Model not found: google/gemma-4-26b-a4b-it`).
  Automated visual review is therefore limited to measurement
  (`tools/visual-check.mjs`). Dali's eyes on a phone are the only real review.
- The memory corpus under `~/.config/opencode/memory/` is **mixed-encoding**:
  ~1112 double-encoded dashes vs 74 correct em-dashes. Pre-existing. A blind
  re-encode would break the correct ones, so it needs a selective verified pass.
  Match edits on ASCII-only substrings until then.

## 8. Next actions, in order

1. Dali picks the brand → update `config.example.php` and the wordmarks.
2. Fix the four open issues in §6 (they are all small and all are in shipped UI).
3. Replace the glyph pieces with real SVG art.
4. Swap the alpha-beta worker for Stockfish WASM.
5. Add the custom time control.
6. Create the `DALI951/chess` remote and push — **already done, the repo is
   public and `main` tracks `origin/main`.**
7. Accounts → database schema → multiplayer. The schema must be created by a
   token-guarded PHP installer **on the server**, because MySQL's external port
   is firewalled on that host.
8. Deploy to `https://modali.powerpme.com/chess`.

## 9. Deployment facts

- Host: `212.227.215.235`, user `CHESS_SFTP_USER`, remote root `/public_html`.
  **SFTP only** — the shell is disabled, so `exec_command` is useless.
- The webroot is shared with ~25 other projects: scope every deploy to
  `chess/` and never touch a sibling directory.
- `config.local.php` lives **outside** the web root and is gitignored. Only ever
  commit `config.example.php`, which carries variable *names*, never values.
- Rotate deploy credentials after go-live.

---

**Author:** DALI951 · MIT licensed
