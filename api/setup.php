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
// "Is it installed?" is asked BEFORE the tables exist, because on a fresh server
// they do not. SELECTing app_meta here used to be a fatal error on the very
// first run - the only run that mattered - and the answer came back as a blank
// 500 with a stack trace in the log. A missing table means "not installed yet",
// which is the question actually being asked.
$installed = 0;
try {
    $installed = (int)($pdo->query("SELECT value FROM app_meta WHERE name = 'installed' LIMIT 1")->fetchColumn() ?: 0);
} catch (Throwable $e) {
    $installed = 0;                       // no app_meta table yet: first run
}
if ($installed === 1) {
    echo json_encode([
        'ok' => true, 'already_installed' => true,
        'message' => 'SHATRANGI is already installed. Nothing was changed. Delete api/setup.php from the server.',
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

$created = [];
$schema = Schema::tables();

// MySQL commits DDL implicitly: there is no transaction to roll back a CREATE
// TABLE, and pretending otherwise is worse than not pretending, because the
// error message below then promises a rollback that cannot happen.
//
// What actually makes this safe is two things, and only two:
//   - every statement is CREATE TABLE IF NOT EXISTS, so a run that died on the
//     fifth table is resumed by running it again, and the first four are no-ops;
//   - installed=1 is written LAST, so "installed" always means "every table
//     exists", never "some of them do".
try {
    foreach ($schema as $name => $sql) {
        $pdo->exec($sql);
        $created[] = $name;
    }
    $st = $pdo->prepare(
        "INSERT INTO app_meta (name, value, updated_ms) VALUES ('installed', '1', :now)
         ON DUPLICATE KEY UPDATE value = '1', updated_ms = VALUES(updated_ms)"
    );
    $st->execute(['now' => Db::nowMs()]);
} catch (Throwable $e) {
    error_log('chess setup failed after creating: ' . implode(', ', $created) . ' :: ' . $e->getMessage());
    http_response_code(500);
    echo json_encode([
        'ok'      => false,
        'error'   => 'schema_failed',
        'created' => $created,
        'message' => 'The schema was not created completely, so SHATRANGI is NOT installed and installed=0. '
                   . 'Tables already created are listed under "created" and are left in place - fix the cause in '
                   . 'the server error log and run this again; the statements are IF NOT EXISTS, so a repeat is safe.',
    ], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
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
