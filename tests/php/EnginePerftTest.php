<?php
declare(strict_types=1);

/**
 * PERFT — the correctness proof, run against the PHP engine.
 *
 * Same published vectors as tests/js/perft.test.mjs. The PHP engine does not
 * need to re-prove the JS engine, it needs to prove IT is the same engine.
 *
 *   php tests/php/EnginePerftTest.php
 *
 * @author DALI951
 */

require_once __DIR__ . '/T.php';
require_once __DIR__ . '/../../api/includes/Engine.php';

$quick = in_array('--quick', $argv, true);

$SUITE = [
    [
        'name' => 'startpos',
        'fen' => 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        'quick' => 3,
        'deep' => 4,
        'expect' => [1 => 20, 2 => 400, 3 => 8902, 4 => 197281],
    ],
    [
        'name' => 'kiwipete',
        'fen' => 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1',
        'quick' => 2,
        'deep' => 3,
        'expect' => [1 => 48, 2 => 2039, 3 => 97862],
    ],
    [
        'name' => 'position-3 (ep + pins)',
        'fen' => '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1',
        'quick' => 3,
        'deep' => 4,
        'expect' => [1 => 14, 2 => 191, 3 => 2812, 4 => 43238],
    ],
    [
        'name' => 'position-4 (promotions)',
        'fen' => 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1',
        'quick' => 3,
        'deep' => 4,
        'expect' => [1 => 6, 2 => 264, 3 => 9467, 4 => 422333],
    ],
    [
        'name' => 'position-5',
        'fen' => 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8',
        'quick' => 2,
        'deep' => 3,
        'expect' => [1 => 44, 2 => 1486, 3 => 62379],
    ],
    [
        'name' => 'position-6',
        'fen' => 'r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10',
        'quick' => 3,
        'deep' => 3,
        'expect' => [1 => 46, 2 => 2079, 3 => 89890],
    ],
];

foreach ($SUITE as $pos) {
    T::group('perft ' . $pos['name']);
    $max = $quick ? $pos['quick'] : $pos['deep'];
    for ($d = 1; $d <= $max; $d++) {
        $chess = new Chess($pos['fen']);
        $t0 = microtime(true);
        $nodes = $chess->perftFast($d);
        $ms = (microtime(true) - $t0) * 1000;
        $nps = $ms > 0 ? (int) round($nodes / ($ms / 1000)) : 0;
        if (T::same($pos['expect'][$d], $nodes, "{$pos['name']} perft d{$d}")) {
            printf(
                "      %-24s d%d %12s nodes %7.0fms %10s nps\n",
                $pos['name'],
                $d,
                number_format($nodes),
                $ms,
                number_format($nps)
            );
        }
    }
}

// -- the properties a server-authoritative engine must hold -------------------

T::group('engine properties');

$chess = new Chess();
T::same(20, count($chess->moves()), 'startpos has 20 legal moves');
T::same(false, $chess->inCheck(), 'startpos is not check');
T::same(false, $chess->isGameOver(), 'startpos is not over');

// history() and pgn() must be READ-ONLY on the position
T::same(0, count($chess->history()), 'history() on a fresh game is empty');
T::ok(str_contains($chess->pgn(), '[Result "*"]'), 'pgn() of a fresh game has a Result header');
T::same(Chess::START_FEN, $chess->fen(), 'reading history/pgn did not disturb the position');

// fools mate: 1.f3 e5 2.g4 Qh4#
$scholar = [
    ['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4'],
];
foreach ($scholar as [$from, $to]) {
    $mv = $chess->move(['from' => $from, 'to' => $to]);
    T::ok($mv !== null, "move {$from}{$to} is legal");
}
T::same(true, $chess->isCheckmate(), 'scholar\'s mate is checkmate');
T::same('checkmate', $chess->endReason(), 'endReason is checkmate');
T::same(-1, $chess->outcome(), 'black wins (outcome -1)');
T::ok(str_contains($chess->pgn(), '1. f3 e5 2. g4 Qh4# 0-1'), 'PGN prints legal SAN and the 0-1 result');
T::same(true, $chess->isCheckmate(), 'pgn() left the finished game intact');

// undo steps back one ply at a time and stops at the start
T::same(4, count($chess->history()), 'history() reports 4 plies');
$chess->undo();
T::same('rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2', $chess->fen(), 'one undo steps back one ply');
T::same(false, $chess->isCheckmate(), 'the position is no longer mate');
$chess->undo();
$chess->undo();
$chess->undo();
T::same(Chess::START_FEN, $chess->fen(), 'four undos return to the start position');
T::same(null, $chess->undo(), 'a fifth undo returns null instead of crashing');

// castling both sides
$castle = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
$castle->move(['from' => 'e1', 'to' => 'g1']);
T::same('r3k2r/8/8/8/8/8/8/R4RK1 b kq - 1 1', $castle->fen(), 'O-O puts the rook on f1 and clears white rights');
$castle->move(['from' => 'e8', 'to' => 'c8']);
T::same('2kr3r/8/8/8/8/8/8/R4RK1 w - - 2 2', $castle->fen(), 'O-O-O for black');

// en passant removes the victim from ITS square, not the destination
$ep = new Chess('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 2');
$epMove = $ep->move(['from' => 'e5', 'to' => 'd6']);
T::ok($epMove !== null, 'exd6 en passant is generated');
T::same(Chess::EMPTY, $ep->get('d5'), 'the captured pawn is removed from d5');
T::ok($ep->get('d6') === Chess::pieceOf(Chess::PAWN, Chess::WHITE), 'the capturing pawn stands on d6');

// promotion needs an explicit piece, and all four are available
$promo = new Chess('8/P6k/8/8/8/8/8/K7 w - - 0 1');
foreach (['Q', 'R', 'B', 'N'] as $piece) {
    $p = new Chess('8/P6k/8/8/8/8/8/K7 w - - 0 1');
    $mv = $p->move(['from' => 'a7', 'to' => 'a8', 'promotion' => $piece]);
    T::ok($mv !== null && $mv['promotion'] === $piece, "a8={$piece} promotion is playable");
}

// you cannot walk into check, you cannot castle through check, and you cannot
// capture a piece that is still defended
$inCheck = new Chess('4k3/8/8/8/2b5/8/4r3/4K3 w - - 0 1');
T::same(true, $inCheck->inCheck(), 'the white king is in check from the e2 rook');
$keys = [];
foreach ($inCheck->moves() as $m) $keys[] = $m['from'] . $m['to'];
sort($keys);
// Kxe2 is illegal (Bc4 defends e2), d2/f2 are covered by the rook, and f1 is
// NOT covered because the rook on e2 blocks the bishop's c4-d3-e2-f1 ray.
T::same(['e1d1', 'e1f1'], $keys, 'only d1 and f1 are legal replies');

$notInCheck = new Chess('3rk3/8/8/8/8/8/8/4K3 w - - 0 1');
T::same(false, $notInCheck->inCheck(), 'the king is not currently in check');
$keys = [];
foreach ($notInCheck->moves() as $m) $keys[] = $m['from'] . $m['to'];
T::ok(!in_array('e1d1', $keys, true), 'the king cannot step onto the attacked d-file');
T::ok(in_array('e1e2', $keys, true), 'the king can still step to e2');

// stalemate
$stale = new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
T::same(true, $stale->isStalemate(), 'Kf7/Qg6 vs Kh8 is stalemate');
T::same('stalemate', $stale->endReason(), 'endReason is stalemate');
T::same(2, $stale->outcome(), 'stalemate is a draw (outcome 2)');

// insufficient material
T::same(true, (new Chess('8/8/4k3/8/8/4K3/8/8 w - - 0 1'))->isInsufficientMaterial(), 'K vs K is a draw');
T::same(true, (new Chess('8/8/4k3/8/8/4KB2/8/8 w - - 0 1'))->isInsufficientMaterial(), 'K+B vs K is a draw');
T::same(false, (new Chess('8/8/4k3/8/8/4KR2/8/8 w - - 0 1'))->isInsufficientMaterial(), 'K+R vs K is NOT a draw');

// threefold repetition
$rep = new Chess();
for ($i = 0; $i < 2; $i++) {
    $rep->move(['from' => 'g1', 'to' => 'f3']);
    $rep->move(['from' => 'g8', 'to' => 'f6']);
    $rep->move(['from' => 'f3', 'to' => 'g1']);
    $rep->move(['from' => 'f6', 'to' => 'g8']);
}
T::same(true, $rep->isThreefoldRepetition(), 'knight shuffling four times is threefold repetition');
T::same('repetition', $rep->endReason(), 'endReason is repetition');

// FEN round trip on every position of the fixture set
$fixture = json_decode((string) file_get_contents(__DIR__ . '/../fixtures/moves.json'), true, 512, JSON_THROW_ON_ERROR);
foreach ($fixture['positions'] as $p) {
    $round = new Chess($p['fen']);
    T::same($p['fen'], $round->fen(), 'FEN round trip: ' . explode(' ', $p['fen'])[0]);
}

// PGN import/export
$pgn = new Chess();
$pgn->loadPgn('1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 1/2-1/2');
// four plies were played (3...a6 is the fourth), so it is white to move on move 4
T::same('r1bqkbnr/1ppp1ppp/p1n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4', $pgn->fen(), 'PGN import replays the Ruy Lopez opening');
T::ok(str_contains($pgn->pgn(), '[Result "*"]'), 'PGN export writes the live result, not the one the file claimed');
T::ok(!str_contains($pgn->pgn(), '[FEN '), 'a standard-start game carries no FEN tag');
$reloaded = new Chess();
$reloaded->loadPgn($pgn->pgn());
T::same($pgn->fen(), $reloaded->fen(), 'a PGN survives its own export/import round trip');
$unfinished = new Chess();
$unfinished->loadPgn('1. e4 e5 2. Nf3 Nc6 *');
T::same('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3', $unfinished->fen(), 'an unfinished game (result *) imports');

exit(T::summary());
