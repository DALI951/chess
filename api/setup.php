<?php
declare(strict_types=1);

/**
 * The installer. Run it once, by hand, over HTTPS, with the token in a header.
 *
 *   curl -X POST https://your-host/api/setup.php -H "X-Setup-Token: <token>"
 *
 * It refuses to run twice: after the first run it sets installed=1, and a second
 * run says so instead of dropping and recreating tables. That single flag is why
 * it is safe to leave this file on the server at all - though .htaccess denies it
 * from the web, and the token is the second lock on the same door.
 *
 * Every statement is CREATE TABLE IF NOT EXISTS, so an interrupted run can be
 * repeated. Nothing is dropped, and no existing row is touched.
 *
 * @author DALI951
 */

require_once __DIR__ . '/includes/bootstrap.php';
require_once __DIR__ . '/includes/Schema.php';

$token = (string)($_SERVER['HTTP_X_SETUP_TOKEN'] ?? '');

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
        http_response_code(405);
        echo json_encode(['ok' => false, 'error' => 'use_post', 'message' => 'POST the setup token in X-Setup-Token.']);
        exit;
    }

    $expected = Config::setupToken();
    if ($expected === null) {
        // No token configured is NOT "skip the check". It is refuse to run.
        http_response_code(503);
        echo json_encode([
            'ok'      => false,
            'error'   => 'no_token',
            'message' => 'No setup token is configured. Set setup_token in config.local.php (not in the '
                       . 'repository) or the CHESS_SETUP_TOKEN environment variable, then try again.',
        ]);
        exit;
    }
    if (!hash_equals($expected, $token)) {
        http_response_code(403);
        echo json_encode(['ok' => false, 'error' => 'forbidden', 'message' => 'Wrong or missing setup token.']);
        exit;
    }

    $pdo = Db::conn();
} catch (Throwable $e) {
    error_log('chess setup preflight: ' . $e->getMessage());
    http_response_code(503);
    echo json_encode([
        'ok' => false, 'error' => 'db_unavailable',
        'message' => 'Could not reach the database. Check db.host / db.user / db.pass in config.local.php.',
    ]);
    exit;
}

// -- already installed? ------------------------------------------------------
$installed = (int)($pdo->query("SELECT value FROM app_meta WHERE name = 'installed' LIMIT 1")->fetchColumn() ?: 0);
if ($installed === 1) {
    echo json_encode([
        'ok' => true, 'already_installed' => true,
        'message' => 'SHATRANGI is already installed. Nothing was changed. Delete api/setup.php from the server.',
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

$created = [];

$schema = Schema::tables();

$pdo->beginTransaction();
try {
    foreach ($schema as $name => $sql) {
        $pdo->exec($sql);
        $created[] = $name;
    }
    // Mark it installed in the same transaction as the tables, so a failure
    // halfway leaves installed=0 and the run can simply be repeated
    $st = $pdo->prepare(
        "INSERT INTO app_meta (name, value, updated_ms) VALUES ('installed', '0', :now)
         ON DUPLICATE KEY UPDATE value = value"
    );
    $st->execute(['now' => Db::nowMs()]);
    $st = $pdo->prepare(
        "UPDATE app_meta SET value = '1', updated_ms = :now WHERE name = 'installed'"
    );
    $st->execute(['now' => Db::nowMs()]);
    $pdo->commit();
} catch (Throwable $e) {
    $pdo->rollBack();
    error_log('chess setup failed: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode([
        'ok' => false, 'error' => 'schema_failed',
        'message' => 'The schema could not be created, so nothing was changed. The server error log has the reason.',
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

$have = Db::all(
    "SELECT table_name AS t FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name IN (" . implode(',', array_fill(0, count($schema), '?')) . ')',
    array_keys($schema)
);

echo json_encode([
    'ok'      => true,
    'tables'  => array_map(static fn(array $r): string => (string)$r['t'], $have),
    'expected' => array_keys($schema),
    'message' => 'SHATRANGI is installed. Delete api/setup.php from the server now.',
], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
