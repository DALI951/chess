<?php
declare(strict_types=1);

/**
 * Run every PHP test.
 *
 *   php tests/php/run.php             # all suites
 *   php tests/php/run.php --quick     # perft at the quick depths
 *
 * @author DALI951
 */

$quick = in_array('--quick', $argv, true);
$here = __DIR__;
$suites = ['EnginePerftTest.php', 'SanTest.php', 'ParityTest.php', 'GameStateTest.php'];

$failed = 0;
foreach ($suites as $suite) {
    echo "\n=== {$suite} " . str_repeat('=', max(0, 60 - strlen($suite))) . "\n";
    $args = $quick ? ['--quick'] : [];
    $cmd = escapeshellarg(PHP_BINARY) . ' ' . escapeshellarg($here . '/' . $suite);
    foreach ($args as $a) $cmd .= ' ' . escapeshellarg($a);
    passthru($cmd, $code);
    if ($code !== 0) $failed++;
}

echo "\n" . str_repeat('=', 64) . "\n";
if ($failed === 0) {
    echo "PHP SUITES: ALL GREEN\n";
    exit(0);
}
echo "PHP SUITES: {$failed} FAILED\n";
exit(1);
