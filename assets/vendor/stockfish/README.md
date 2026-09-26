# Stockfish, vendored

`stockfish.wasm.js` and `stockfish.wasm` are **Stockfish compiled to
WebAssembly**, taken verbatim from the npm package `stockfish.js` 10.0.2
(which is Stockfish 17 with the multi-variant patches from Daniel Dugovic).
They are not edited. `LICENSE-GPL-3.0.txt` is the GPLv3 text they ship with.

## Why it is vendored and not loaded from a CDN

The app is meant to work on a phone with a bad connection, and a chess engine
that stops existing when a CDN is down is not a chess engine. The whole pair is
640KB, which is smaller than the piece art was before it was replaced.

## Why it sits in its own directory

Stockfish is **GPLv3**. The rest of this project is MIT. Those are not
compatible, and pretending otherwise is how a hobby site turns into a legal
problem for its owner.

The separation is deliberate and it is the same separation every site that ships
Stockfish in a browser makes: the engine is a **separate work**, an unmodified
GPL binary, and it is the only thing in the process. It is handed a FEN over the
standard UCI text protocol — `position fen ...`, `go movetime ...` — and it hands
back `bestmove e7e5`. It is never linked into the app's code, never imported,
and never given a reference to the game's board.

If that boundary is ever crossed (importing the engine's internals, or shipping
a modified build inside the app's own bundle), this project stops being MIT and
becomes GPLv3 as a combined work. That is a fine outcome — it only costs the
owner the ability to license it permissively — but it should be a decision
rather than an accident.

## Version and provenance

    npm package   stockfish.js 10.0.2
    engine        Stockfish 17 (multi-variant fork, ddugovic)
    compiled by   Niklas Fiekas, Emscripten
    threads       1  (web workers are single-threaded; this build says so)
    tables        Syzygy tablebases disabled, 32MB memory limit

To upgrade:

    npm install stockfish.js@latest
    copy node_modules/stockfish.js/stockfish.wasm.js   -> here
    copy node_modules/stockfish.js/stockfish.wasm      -> here
    copy node_modules/stockfish.js/Copying.txt         -> LICENSE-GPL-3.0.txt
    npm run test:ui      # includes the mate-in-one-at-level-400 check
