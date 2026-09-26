<?php
declare(strict_types=1);

/**
 * The rules of an online game, tested without a database, an HTTP request or a
 * browser. Every assertion here is about a decision that used to be buried in
 * SQL, which is the only reason it is testable at all.
 *
 *   php tests/php/GameStateTest.php
 *
 * @author DALI951
 */

require_once __DIR__ . '/../../api/includes/Engine.php';
require_once __DIR__ . '/../../api/includes/GameState.php';

// Engine.php declares one global class, Chess. GameState.php sits beside it in
// the global namespace for the same reason: a second namespace here would mean
// two ways to name the same engine, and the mirrored JS copy has no namespaces
// at all. Keeping the shape identical across the two is the point.

const ALICE = 1;
const BOB   = 2;

function group(string $name): void { echo "\n-- {$name} " . str_repeat('-', max(0, 58 - strlen($name))) . "\n"; }

$passed = 0;
$failed = 0;
function check(bool $ok, string $what, string $extra = ''): void
{
    global $passed, $failed;
    if ($ok) { $passed++; echo "  ok   {$what}\n"; }
    else { $failed++; echo "  FAIL {$what}" . ($extra !== '' ? "  -> {$extra}" : '') . "\n"; }
}
// A game whose clock is not running, so a test can hand applyMove() an exact
// nowMs and have the arithmetic be exactly what the test means it to be.
function timedGame(int $baseMs, int $incrMs, int $nowMs = 1_000_000): array
{
    return GameState::create([
        'white_user' => ALICE, 'black_user' => BOB,
        'tc_base_ms' => $baseMs, 'tc_increment_ms' => $incrMs,
        'now_ms' => $nowMs,
    ]);
}

// -- who may move -------------------------------------------------------------
group('turn order');
$g = timedGame(600_000, 0);
check($g['status'] === GameState::ACTIVE, 'a game with both seats filled is active', $g['status']);
$r = GameState::applyMove($g, ['from' => 'e2', 'to' => 'e4', 'sans' => []], ALICE, 1_000_000);
check($r['ok'] && $r['move']['san'] === 'e4', 'white can open', json_encode($r['move'] ?? $r['error']));
check($r['error'] === null, 'a legal move reports no error', (string)$r['error']);

$g2 = $r['game'];
$r2 = GameState::applyMove($g2, ['from' => 'e7', 'to' => 'e5', 'sans' => ['e4']], ALICE, 1_001_000);
check(!$r2['ok'] && $r2['error'] === 'not_your_turn', 'white cannot move twice', (string)$r2['error']);

$r3 = GameState::applyMove($g2, ['from' => 'e7', 'to' => 'e5', 'sans' => ['e4']], BOB, 1_001_000);
check($r3['ok'], 'black answers', (string)$r3['error']);

$r4 = GameState::applyMove($g2, ['from' => 'd7', 'to' => 'd5', 'sans' => ['e4']], 99, 1_001_000);
check(!$r4['ok'] && $r4['error'] === 'not_a_player', 'a stranger cannot move', (string)$r4['error']);

$bad = GameState::applyMove($g2, ['from' => 'e7', 'to' => 'e4', 'sans' => ['e4']], BOB, 1_001_000);
check(!$bad['ok'] && $bad['error'] === 'illegal_move', 'an illegal move is refused', (string)$bad['error']);

$waiting = GameState::create(['white_user' => ALICE, 'now_ms' => 1_000_000]);
check($waiting['status'] === GameState::WAITING, 'a game with one seat is waiting', $waiting['status']);
$w = GameState::applyMove($waiting, ['from' => 'e2', 'to' => 'e4', 'sans' => []], ALICE, 1_000_000);
check(!$w['ok'] && $w['error'] === 'not_playing', 'a waiting game refuses moves', (string)$w['error']);

// -- the clock ---------------------------------------------------------------
group('the clock');
$g = timedGame(60_000, 0);
$r = GameState::applyMove($g, ['from' => 'e2', 'to' => 'e4', 'sans' => []], ALICE, 1_010_000); // 10s on the clock
check($r['game']['white_ms'] === 50_000, 'ten seconds came off the mover', (string)$r['game']['white_ms']);
check($r['game']['black_ms'] === 60_000, 'and not off the opponent', (string)$r['game']['black_ms']);

$g = timedGame(60_000, 2_000);
$r = GameState::applyMove($g, ['from' => 'e2', 'to' => 'e4', 'sans' => []], ALICE, 1_005_000);
check($r['game']['white_ms'] === 57_000, 'the increment goes to the MOVER (55s + 2s)', (string)$r['game']['white_ms']);
check($r['game']['black_ms'] === 60_000, 'the increment does not go to the opponent', (string)$r['game']['black_ms']);
check($r['game']['turn_started_ms'] === 60_000, 'the next clock starts at the opponent full time', (string)$r['game']['turn_started_ms']);

$g = timedGame(60_000, 2_000);
$g['turn_started_at_ms'] = 1_000_000; $g['turn_started_ms'] = 60_000;
$c = GameState::clock($g, 1_005_000);
check($c['white'] === 55_000, 'a live clock only drains the side to move (60s - 5s)', (string)$c['white']);
check($c['black'] === 60_000, 'the waiting side stays frozen', (string)$c['black']);
check($c['turn'] === 'white', 'and the turn is reported', (string)$c['turn']);

// untimed
$g = timedGame(0, 0);
$r = GameState::applyMove($g, ['from' => 'e2', 'to' => 'e4', 'sans' => []], ALICE, 1_999_999);
check($r['ok'], 'an untimed game accepts a move an age later', (string)$r['error']);
$c = GameState::clock($r['game'], 9_999_999);
check($c['timed'] === false && $c['white'] === 0, 'and never reports a clock', json_encode($c));

// -- the flag ----------------------------------------------------------------
group('running out of time');
$g = timedGame(60_000, 0);
$g['turn_started_at_ms'] = 1_000_000; $g['turn_started_ms'] = 500; $g['white_ms'] = 500;
$r = GameState::applyMove($g, ['from' => 'e2', 'to' => 'e4', 'sans' => []], ALICE, 1_000_600);
check($r['error'] === 'flag', 'a move after the flag is a flag fall, not a move', (string)$r['error']);
check($r['move'] === null, 'and the move does not count', json_encode($r['move']));
check($r['game']['ply'] === 0, 'the ply did not advance', (string)$r['game']['ply']);
check($r['game']['result'] === -1, 'the side that ran out of time lost', (string)$r['game']['result']);
check($r['game']['reason'] === 'flag', 'the reason is the flag', (string)$r['game']['reason']);
check($r['game']['status'] === GameState::ENDED, 'and the game is over', $r['game']['status']);
check($r['game']['winner_user'] === BOB, 'the opponent won', (string)$r['game']['winner_user']);
check($r['game']['white_ms'] === 0, 'the clock reads zero', (string)$r['game']['white_ms']);

$g = timedGame(60_000, 0);
$g['turn_started_at_ms'] = 1_000_000; $g['turn_started_ms'] = 200; $g['black_ms'] = 200;
$r = GameState::applyMove($g, ['from' => 'e7', 'to' => 'e5', 'sans' => ['e4']], BOB, 1_000_400);
check($r['error'] === 'flag' && $r['game']['result'] === 1, 'black flagging loses', (string)$r['game']['result']);

// exactly zero is still a flag: a player with 0ms left is a player who has lost
$g = timedGame(60_000, 0);
$g['turn_started_at_ms'] = 1_000_000; $g['white_ms'] = 0; $g['turn_started_ms'] = 0;
$r = GameState::applyMove($g, ['from' => 'e2', 'to' => 'e4', 'sans' => []], ALICE, 1_000_000);
check($r['error'] === 'flag', 'moving with exactly 0ms left is still a flag fall', (string)$r['error']);

// -- endings -----------------------------------------------------------------
group('endings');
// fool's mate. The mating move is Black's QUEEN reaching h4 - g4 on its own is
// not mate, which is a good reminder that a mate-in-N test written from memory
// usually tests the wrong position.
$g = timedGame(600_000, 0);
$sans = ['f3', 'e5', 'g4', 'Qh4#'];
$game = $g;
foreach ($sans as $i => $s) {
    $res = GameState::applyMove($game, [
        'san' => $s, 'sans' => array_slice($sans, 0, $i),
    ], $i % 2 === 0 ? ALICE : BOB, 1_000_000 + $i);
    $game = $res['game'];
}
check($game['status'] === GameState::ENDED, "1.f3 e5 2.g4 Qh4# is checkmate", $game['status']);
check($game['reason'] === 'checkmate', 'reason checkmate', (string)$game['reason']);
check($game['result'] === -1, 'black won', (string)$game['result']);
check($game['winner_user'] === BOB, 'the winner is the user, not a colour', (string)$game['winner_user']);
check($game['turn_started_at_ms'] === null, 'the clock stopped', json_encode($game['turn_started_at_ms']));
check(str_contains($game['pgn'], '1-0') === false && str_contains($game['pgn'], '0-1'), 'the PGN carries the result', $game['pgn']);
$after = GameState::applyMove($game, ['from' => 'd8', 'to' => 'd7', 'sans' => $sans], BOB, 1_001_000);
check(!$after['ok'] && $after['error'] === 'not_playing', 'a finished game refuses moves', (string)$after['error']);

// a stalemate position with BLACK to move: white Qf7 and Kg6 wall the h8 king in
$game = GameState::create([
    'white_user' => ALICE, 'black_user' => BOB, 'tc_base_ms' => 0,
    'fen' => '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', 'now_ms' => 1_000_000,
]);
check(GameState::engine($game, [])->isStalemate(), 'that FEN really is stalemate', GameState::engine($game, [])->fen());
$res = GameState::applyMove($game, ['from' => 'h8', 'to' => 'h7', 'sans' => []], BOB, 1_000_000);
check(!$res['ok'], 'a position that is already stalemate cannot be moved', json_encode($res['error']));
check($res['error'] === 'already_over', 'and it says the game is over, not that the move was illegal', (string)$res['error']);

// Insufficient material. Reached by starting from a real endgame FEN rather
// than by playing a long stripping sequence: the a-pawn / h-pawn walk used to
// sit in this file and it only ever traded two pieces, so it proved nothing.
// (K+N against K+N is NOT a draw, which is the trap that hides here.)
$game = GameState::create([
    'white_user' => ALICE, 'black_user' => BOB, 'tc_base_ms' => 0,
    'fen' => '4k3/8/8/8/8/8/8/3BK3 w - - 0 1',   // king and bishop against a bare king
    'now_ms' => 1_000_000,
]);
$e = GameState::engine($game, []);
check($e->isInsufficientMaterial(), 'king and bishop against a bare king is detected', $e->fen());
check($e->endReason() === 'material', 'and the reason is insufficient material', $e->endReason());
$both = GameState::create([
    'white_user' => ALICE, 'black_user' => BOB, 'tc_base_ms' => 0,
    'fen' => '4k3/8/8/8/8/8/8/3NK3 w - - 0 1',
    'now_ms' => 1_000_000,
]);
check(GameState::engine($both, [])->isInsufficientMaterial(), 'king and knight against a bare king too');
$twoKnights = GameState::create([
    'white_user' => ALICE, 'black_user' => BOB, 'tc_base_ms' => 0,
    'fen' => '4k3/8/8/8/8/8/8/3NKN2 w - - 0 1',  // mate IS possible with help: not a draw
    'now_ms' => 1_000_000,
]);
check(!GameState::engine($twoKnights, [])->isInsufficientMaterial(),
    'but two knights against a bare king is NOT a draw', 'it was called a draw');
// and the ending itself goes through the same code path a played game uses
$ended = $game;
$ended['result'] = 0; $ended['reason'] = 'material'; $ended['status'] = GameState::ENDED;
check(GameState::clock($ended, 1_000_000)['turn'] === null, 'a finished game has nobody to move');

// resignation and agreement
$g = timedGame(600_000, 0);
$res = GameState::endByResign($g, BOB, 1_500_000);
check($res['result'] === 1 && $res['reason'] === 'resign', 'black resigning gives white the win', $res['reason']);
check($res['winner_user'] === ALICE, 'and names the user', (string)$res['winner_user']);
$threw = false;
try { GameState::endByResign($g, 77, 1_500_000); } catch (InvalidArgumentException) { $threw = true; }
check($threw, 'a stranger cannot resign somebody else\'s game');

// -- promotion ---------------------------------------------------------------
group('promotion and codes');
// Reached by playing real moves rather than by loading a FEN, because
// applyMove() rebuilds the position from the start position and the stored SAN
// list: the fen column is a cache, not the truth. Handing it a doctored FEN
// would test nothing.
$g = timedGame(0, 0);
// 1.a4 h5 2.a5 h4 3.a6 h3 4.axb7 hxg2, then 5.bxa8=Q takes the rook and promotes
$sans = ['a4', 'h5', 'a5', 'h4', 'a6', 'h3', 'axb7', 'hxg2'];
$game = $g;
foreach ($sans as $i => $s) {
    $res = GameState::applyMove($game, [
        'san' => $s, 'sans' => array_slice($sans, 0, $i),
    ], $i % 2 === 0 ? ALICE : BOB, 1_000_000 + $i);
    if (!$res['ok']) { check(false, "the promotion walk played {$s}", (string)$res['error']); break; }
    $game = $res['game'];
}
check($game['ply'] === 8, 'the promotion walk played out', (string)$game['ply']);
// rank 7 reads "pPppppp1": the a-pawn took b7 and is the CAPITAL P now, because
// it is a white pawn standing on a black pawn's square
check(str_starts_with($game['fen'], 'rnbqkbnr/pP'), 'the white pawn has walked to b7', $game['fen']);
check(str_contains(explode(' ', $game['fen'])[1], 'w'), 'and it is white to promote', $game['fen']);
$last = GameState::applyMove($game, ['san' => 'bxa8=Q', 'sans' => $sans], ALICE, 2_000_000);
check($last['ok'] && str_contains((string)$last['move']['san'], '=Q'),
    'a capture-promotion is recorded with its piece', json_encode($last['move'] ?? $last['error']));
check(str_ends_with((string)($last['move']['uci'] ?? ''), 'q'),
    'and the UCI carries a LOWER-case promotion piece, which is what UCI wants', (string)($last['move']['uci'] ?? ''));
check((string)($last['move']['uci'] ?? '') === 'b7a8q', 'the whole UCI is b7a8q', (string)($last['move']['uci'] ?? ''));
check(str_contains((string)$last['game']['fen'], 'Q'), 'the FEN now holds a white queen', (string)$last['game']['fen']);

// 20000 random codes, and the assertion is DELIBERATELY not "all different".
// With 32^6 possible codes the birthday maths says about one collision in
// 20000 draws is expected, not a bug - so a test demanding zero is a test that
// fails once a month for no reason, and gets deleted. The property that actually
// matters is that the space is huge and the alphabet is readable. The retry that
// handles a real collision lives in GameRepo::insert().
$codes = [];
for ($i = 0; $i < 20000; $i++) $codes[] = GameState::code();
$distinct = count(array_unique($codes));
check($distinct >= 19990, "20000 codes: {$distinct} distinct, so collisions are vanishingly rare", (string)$distinct);
check(strlen(GameState::CODE_ALPHABET) === 23, 'the alphabet is 23 characters', (string)strlen(GameState::CODE_ALPHABET));
check(count(array_unique(str_split(GameState::CODE_ALPHABET))) === 23, 'with no repeats');
// The alphabet is uppercase, which removes the whole l/1 and O/0 class of problem
// from a code somebody is reading out loud: there is no case to get wrong.
check(preg_match('/^[A-Z0-9]+$/', GameState::CODE_ALPHABET) === 1, 'uppercase and digits only');
// every confusable PAIR must be absent entirely - keeping the digit but dropping
// the letter, or the other way round, is the whole point
$confusable = ['0', '1', '2', '5', '6', '8', 'I', 'L', 'O', 'S', 'Z', 'B', 'G'];
$present = array_values(array_intersect(str_split(GameState::CODE_ALPHABET), $confusable));
check($present === [], 'no confusable character survives (0 O 1 I L 2 Z 5 S 6 G 8 B)', implode('', $present));
check(preg_match('/^[' . GameState::CODE_ALPHABET . ']{6}$/', GameState::code()) === 1, 'a code is six characters from it');
check(strlen(GameState::code()) === 6, 'codes are six characters');

// -- what the client is told -------------------------------------------------
group('the public state');
$g = timedGame(300_000, 1_000);
$g['turn_started_at_ms'] = 1_000_000;
$players = [
    ALICE => ['id' => ALICE, 'username' => 'ali', 'display_name' => 'علي', 'rating' => 1500, 'last_seen_ms' => 1_000_000],
    BOB   => ['id' => BOB,   'username' => 'bob', 'display_name' => 'Bob',  'rating' => 1600, 'last_seen_ms' => 1_000_000 - 120_000],
];
$state = GameState::publicState($g, $players, ['e4', 'e5'], 1_003_000);
check($state['white']['display_name'] === 'علي', 'display names survive, Arabic and all', (string)$state['white']['display_name']);
check($state['white']['online'] === true, 'seen 3s ago is online', var_export($state['white']['online'], true));
check($state['black']['online'] === false, 'seen 2 minutes ago is not', var_export($state['black']['online'], true));
check($state['clock']['white'] === 297_000, 'the clock in the state is already discounted', (string)$state['clock']['white']);
check($state['now_ms'] === 1_003_000, 'the server clock rides along so the client can interpolate', (string)$state['now_ms']);
check($state['moves'] === ['e4', 'e5'], 'moves come as SAN only', json_encode($state['moves']));
$flat = json_encode($state);
check(!str_contains($flat, 'pass_hash') && !str_contains($flat, 'password'), 'nothing secret is in the state', $flat);
check(!str_contains($flat, 'turn_started'), 'and no internal clock bookkeeping either', $flat);

$spectator = GameState::publicState($waiting, $players, [], 1_003_000);
check($spectator['black'] === null, 'an empty seat is null, not a guess', json_encode($spectator['black']));

echo "\n" . str_repeat('=', 64) . "\n";
if ($failed === 0) { echo "ALL GREEN - {$passed} assertions\n"; exit(0); }
echo "{$failed} FAILED of " . ($passed + $failed) . "\n";
exit(1);
