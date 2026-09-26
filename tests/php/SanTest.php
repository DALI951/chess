<?php
declare(strict_types=1);

/**
 * SAN TEST SUITE (PHP) — the axis perft cannot see.
 *
 * This is the PHP twin of tests/js/san.test.mjs: the same positions and the same
 * expected strings, asserted against the SERVER engine. If the two ever print a
 * game differently, the move list a player sees and the move the server records
 * will drift apart.
 *
 * The JS engine carried three SAN bugs through a fully green perft suite:
 *   1. self-disambiguation ("Ng1f3" instead of "Nf3")
 *   2. doubled pawn-capture separator ("exxd5")
 *   3. pgn() scrambling the board while printing
 * plus two more found here: moveSan() demanding a check suffix it should accept
 * as optional, pgn() always writing a FEN tag so it could not replay its own
 * export, and /\b\*\b/ failing to strip the "*" result of an unfinished game.
 *
 * @author DALI951
 */

require_once __DIR__ . '/T.php';
require_once __DIR__ . '/../../api/includes/Engine.php';

function sans(string $fen, array $opts = []): array
{
    $out = [];
    foreach ((new Chess($fen))->moves($opts) as $m) {
        $out[] = $m['san'];
    }
    return $out;
}

function pick(string $fen, string $regex): array
{
    $out = array_values(array_filter(sans($fen), static fn(string $s): bool => (bool) preg_match($regex, $s)));
    sort($out);
    return $out;
}

T::group('san');

// -- the opening, written plainly ---------------------------------------------
T::same(['Na3', 'Nc3', 'Nf3', 'Nh3'], pick(Chess::START_FEN, '/^N/'), 'the knights have four plain moves');

// -- disambiguation ------------------------------------------------------------
T::same(['Nce2', 'Nge2'], pick('4k3/8/8/8/8/2N5/8/4K1N1 w - - 0 1', '/^N.*e2$/'), 'two knights reaching e2 are disambiguated by file');
T::ok(!in_array('Ne2', sans('4k3/8/8/8/8/2N5/8/4K1N1 w - - 0 1'), true), 'the ambiguous bare form Ne2 is never produced');
T::same(['R1a3', 'R5a3'], pick('4k3/8/8/R7/8/8/8/R3K3 w - - 0 1', '/^R.*a3$/'), 'two rooks on one file are disambiguated by rank');
T::same(['Rd1'], pick('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1', '/^R.*d1$/'), 'a blocked path needs no disambiguation');

// -- pawn captures: origin file and exactly ONE x ------------------------------
T::same(['exd5'], pick('4k3/8/8/3r4/4P3/8/8/4K3 w - - 0 1', '/d5$/'), 'a pawn capture is exd5');
T::same(['exd6'], pick('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2', '/d6$/'), 'en passant is written like any pawn capture');
foreach (sans('4k3/8/8/3r4/4P3/8/8/4K3 w - - 0 1') as $s) {
    T::ok(!str_contains($s, 'xx'), "no move may contain a doubled x: {$s}");
}
$ep = new Chess('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2');
$ep->moveSan('exd6');
T::same('4k3/8/3P4/8/8/8/8/4K3 b - - 0 2', $ep->fen(), 'the captured pawn leaves d5, not d6');

// -- promotion ------------------------------------------------------------------
T::same(['a8=B', 'a8=N', 'a8=Q+', 'a8=R+'], pick('4k3/P7/8/8/8/8/8/4K3 w - - 0 1', '/^a8=/'), 'a8=Q/R give check along the rank, B/N do not');
T::same(['axb8=B', 'axb8=N', 'axb8=Q+', 'axb8=R+'], pick('1n2k3/P7/8/8/8/8/8/4K3 w - - 0 1', '/^axb8=/'), 'promotion by capture carries the same suffixes');

// -- an open queen, every square hand-checked -----------------------------------
T::same([
    'Qa2', 'Qa3+', 'Qa4', 'Qa5', 'Qa6', 'Qa7', 'Qa8',
    'Qb1', 'Qb2', 'Qc1', 'Qc3+', 'Qd1', 'Qd4', 'Qe5+', 'Qf6', 'Qg7+', 'Qh8',
], pick('8/8/8/8/8/6k1/8/Q3K3 w - - 0 1', '/^Q/'), 'lone queen a1 vs king g3: only rank-3, e5 and g7 moves give check');

// -- castling ------------------------------------------------------------------
T::same(['O-O', 'O-O-O'], pick('4k3/8/8/8/8/8/8/R3K2R w KQ - 0 1', '/^O/'), 'castling is written O-O / O-O-O');
T::same(['O-O+', 'O-O-O'], pick('5k2/8/8/8/8/8/8/R3K2R w KQ - 0 1', '/^O/'), 'O-O that opens the f-file onto the king carries +');

// -- check, mate, and an OPTIONAL suffix on input ------------------------------
$scholar = new Chess();
foreach (['f3', 'e5', 'g4'] as $san) {
    $scholar->moveSan($san);
}
T::ok(in_array('Qh4#', sans($scholar->fen()), true), 'Qh4 is written as mate');
T::same('Qh4#', $scholar->moveSan('Qh4')['san'], 'moveSan accepts a mate move without the # suffix');
$ruy = new Chess();
foreach (['e4', 'e5', 'Qh5', 'Nc6'] as $san) {
    T::ok($ruy->moveSan($san) !== null, "{$san} is playable");
}
T::same('Qxe5+', $ruy->moveSan('Qxe5')['san'], 'a capture that checks is written Qxe5+');
T::same(true, $ruy->inCheck(), 'Qxe5+ really is check');

// -- nonsense is rejected ------------------------------------------------------
$junk = new Chess();
foreach (['Nf6', 'e9', 'O-O', 'Kz1', 'xx', 'e4 e5', ''] as $bad) {
    T::same(null, $junk->moveSan($bad), "\"{$bad}\" is not playable");
}

// -- a full game: history, FEN, PGN, round trip --------------------------------
$game = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O', 'Be7', 'Re1', 'b5', 'Bb3', 'd6', 'c3', 'O-O'];
$c = new Chess();
foreach ($game as $san) {
    T::ok($c->moveSan($san) !== null, "{$san} is playable");
}
T::same($game, array_map(static fn(array $m): string => $m['san'], $c->history()), 'history() returns the game');
T::same($game, array_map(static fn(array $m): string => $m['san'], $c->history(['verbose' => false])), 'non-verbose history() returns SAN strings');
T::same('r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N2/PP1P1PPP/RNBQR1K1 w - - 1 9', $c->fen(), 'the Spanish position is reached');

$before = $c->fen();
$pgn = $c->pgn();
T::same($before, $c->fen(), 'pgn() leaves the position untouched');
$body = trim(implode("\n", array_values(array_filter(
    explode("\n", $pgn),
    static fn(string $l): bool => !str_starts_with($l, '[')
))));
T::same('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Ba4 Nf6 5. O-O Be7 6. Re1 b5 7. Bb3 d6 8. c3 O-O *', $body, 'PGN movetext');
T::ok(!str_contains($pgn, '[FEN '), 'a standard-start game carries no FEN tag');

$setup = new Chess('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1');
$setup->moveSan('e4');
$setupPgn = $setup->pgn();
T::ok(str_contains($setupPgn, '[FEN "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1"]'), 'a setup game carries a FEN tag');
$backSetup = new Chess();
$backSetup->loadPgn($setupPgn);
T::same($setup->fen(), $backSetup->fen(), 'a setup game survives its own round trip');

$reloaded = new Chess();
$reloaded->loadPgn($pgn);
T::same($c->fen(), $reloaded->fen(), 'the full game survives its own round trip');
T::same(
    array_map(static fn(array $m): string => $m['san'], $c->history()),
    array_map(static fn(array $m): string => $m['san'], $reloaded->history()),
    'the replayed game has the same move list'
);

$noisy = new Chess();
$noisy->loadPgn('[Event "Test"]' . "\n\n" . '1. e4 {best by test} e5 2. Nf3 $1 Nc6 (2... Nf6 3. Bb5) 3. Bb5 a6 1/2-1/2' . "\n");
T::same('r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4', $noisy->fen(), 'PGN import tolerates comments, NAGs and variations');
T::same('Test', $noisy->getHeaders()['Event'] ?? null, 'PGN headers survive import');

$unfinished = new Chess();
$unfinished->loadPgn('1. e4 e5 2. Nf3 Nc6 *');
T::same('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3', $unfinished->fen(), 'an unfinished game (result *) imports');

// -- every SAN the engine writes must parse back -------------------------------
$fixture = json_decode((string) file_get_contents(__DIR__ . '/../fixtures/moves.json'), true, 512, JSON_THROW_ON_ERROR);
$checked = 0;
$failed = [];
foreach ($fixture['positions'] as $p) {
    foreach (sans($p['fen']) as $san) {
        $probe = new Chess($p['fen']);
        if ($probe->moveSan($san) === null) {
            $failed[] = $san . ' in ' . $p['fen'];
        }
        $checked++;
    }
}
T::same([], $failed, "all {$checked} generated SAN strings parse back");
T::ok($checked > 400, "the whole corpus was checked ({$checked})");

exit(T::summary());
