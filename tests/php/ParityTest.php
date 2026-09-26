<?php
declare(strict_types=1);

/**
 * PARITY TEST — the PHP server engine must be byte-identical to the JS one.
 *
 * The browser and the server are two implementations of the same chess rules.
 * The only honest way to keep them honest is a fixture NEITHER produced:
 * tests/fixtures/moves.json is written by tools/gen-move-fixtures.mjs from the
 * JavaScript engine, and this file asserts PHP reproduces every single value.
 *
 * If this test fails, the site is broken in the worst possible way: the player
 * sees a legal move highlighted, plays it, and the server rejects it.
 *
 * @author DALI951
 */

require_once __DIR__ . '/T.php';
require_once __DIR__ . '/../../api/includes/Engine.php';

$fixturePath = __DIR__ . '/../fixtures/moves.json';
T::group('parity');

if (!is_file($fixturePath)) {
    fwrite(STDERR, "MISSING FIXTURE: {$fixturePath}\n  run: node tools/gen-move-fixtures.mjs\n");
    exit(1);
}
$fixture = json_decode((string) file_get_contents($fixturePath), true, 512, JSON_THROW_ON_ERROR);

/** Move identity for PHP: O-O / O-O-O, else from+to(+promotion), sorted. */
function phpMoveKeys(Chess $chess): array
{
    $out = [];
    foreach ($chess->moves(['verbose' => true]) as $mv) {
        if (preg_match('/^O-O(-O)?[+#]?$/', $mv['san'])) {
            $out[] = preg_replace('/[+#]$/', '', $mv['san']);
        } else {
            $out[] = $mv['from'] . $mv['to'] . ($mv['promotion'] ? '=' . strtolower($mv['promotion']) : '');
        }
    }
    sort($out);
    return $out;
}

foreach ($fixture['positions'] as $i => $p) {
    $fen = $p['fen'];
    $label = explode(' ', $fen)[0] . " (#{$i})";
    $chess = new Chess($fen);

    T::same($p['fenRoundTrip'], $chess->fen(), "{$label} FEN round trip");
    T::same($p['inCheck'], $chess->inCheck(), "{$label} inCheck");
    T::same($p['isCheckmate'], $chess->isCheckmate(), "{$label} isCheckmate");
    T::same($p['isStalemate'], $chess->isStalemate(), "{$label} isStalemate");
    T::same($p['endReason'], $chess->endReason(), "{$label} endReason");

    // move identity, both flavours
    T::same($p['moves'], phpMoveKeys($chess), "{$label} move list");

    $san = array_map(static fn(array $m): string => $m['san'], $chess->moves());
    sort($san);
    T::same($p['san'], $san, "{$label} SAN list");

    foreach ($p['perft'] as $depth => $expected) {
        $depth = (int) $depth;
        $t0 = microtime(true);
        $nodes = (new Chess($fen))->perftFast($depth);
        $ms = (microtime(true) - $t0) * 1000;
        if (T::same($expected, $nodes, "{$label} perft d{$depth}")) {
            printf(
                "      %-46s d%d %12s nodes %7.0fms\n",
                $label,
                $depth,
                number_format($nodes),
                $ms
            );
        }
    }
}

exit(T::summary());
