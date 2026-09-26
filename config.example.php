<?php
/**
 * Chess — example config.
 *
 * Copy to config.local.php and fill in real values.
 * config.local.php is gitignored and MUST never be committed.
 * On the server it lives OUTSIDE the web root: ../config.local.php
 * (api/includes/bootstrap.php looks in both places).
 */

return [
    'db' => [
        'host'    => '127.0.0.1',   // on the server MySQL is local; 3306 is firewalled from outside
        'port'    => 3306,
        'name'    => 'chess',
        'user'    => 'CHANGE_ME',
        'pass'    => 'CHANGE_ME',
        'charset' => 'utf8mb4',
    ],

    // Site identity
    'site' => [
        'name'       => 'kersat',
        'origin'     => 'https://modali.powerpme.com/chess',  // used for cookie + CSRF checks
        'timezone'   => 'Africa/Tunis',
    ],

    'session' => [
        'cookie_name' => 'chess_sid',
        'lifetime'    => 60 * 60 * 24 * 30, // 30 days
        'secure'      => true,              // false only for local http://127.0.0.1 testing
    ],

    'game' => [
        // A game with no move for this long is auto-resigned (7 days, per spec)
        'abandon_after_days' => 7,
        // Finished games older than this are deleted by the cleanup job (30 days)
        'cleanup_after_days'  => 30,
        // Poll interval hint the client uses (ms)
        'poll_ms'             => 700,
    ],

    'rate_limit' => [
        'signup_per_hour'   => 5,     // per IP
        'games_per_minute'  => 12,    // per user
        'chat_per_10s'      => 4,     // per user
        'api_per_minute'    => 240,   // per user — polling needs headroom
    ],

    // One-shot installer guard. Change this, visit /api/setup.php?token=...,
    // then DELETE api/setup.php from the server.
    'setup_token' => 'CHANGE_ME_RANDOM_STRING',

    // Admin allowlist (usernames, lowercase). Only these can open /admin.
    'admins' => ['dali951'],
];
