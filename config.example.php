<?php
/**
 * SHATRANGI - example config.
 *
 * Copy to config.local.php and fill in real values.
 * config.local.php is gitignored and MUST never be committed.
 * On the server it lives OUTSIDE the web root: ../config.local.php
 * (api/includes/bootstrap.php looks in both places).
 *
 * ---------------------------------------------------------------------------
 * ONLY THE KEYS BELOW ARE READ BY THE CODE. This file used to document a
 * `game` block, a `rate_limit` block, `site.timezone`, `session.cookie_name`,
 * `session.lifetime` and `admins` - and not one of them was read. The rate
 * limits are literals at the Http::throttle() call sites, the abandon window is
 * GameRepo::STALE_MS, and the session cookie is a browser-session cookie
 * (lifetime 0) with a hardcoded name. Config that looks real and does nothing
 * is worse than no config: the next person edits it, sees no behaviour change,
 * and concludes the setting is broken. So the dead keys are gone and the real
 * knobs are listed at the bottom, with the file to edit for each.
 *
 * Every key here has a fallback in api/includes/Config.php, so an incomplete
 * config.local.php is fine - except setup_token, which is deliberately NOT
 * optional: no token means the installer refuses to run rather than skipping
 * its check.
 *
 * Every key can also come from the environment instead, which is how the host
 * is configured today (see the CHESS_* list in Config::load()).
 * ---------------------------------------------------------------------------
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

    'site' => [
        'name'   => 'shatrangi',
        // Compared against the Origin header on every state-changing request.
        // Wrong or missing here means every write is rejected as cross-site.
        'origin' => 'https://modali.powerpme.com/chess',
    ],

    'session' => [
        // true everywhere except local http://127.0.0.1 testing, where a secure
        // cookie is never sent back and every login silently fails.
        'secure' => true,
    ],

    // One-shot installer guard. The installer reads this from the X-Setup-Token
    // header and refuses GET, so it cannot be triggered by a link somebody sends
    // you. .htaccess denies api/setup.php outright, so on a host that honours it
    // you must lift that block (or comment it out) for the one request, then
    // delete api/setup.php from the server.
    //
    //   curl -X POST https://your-host/api/setup.php -H "X-Setup-Token: <token>"
    'setup_token' => 'CHANGE_ME_RANDOM_STRING',
];

/*
 * The settings that are NOT here, and where they actually live:
 *
 *   rate limits           one literal per action at each Http::throttle() call
 *                         site: register 5/3h, login 10/5m, create 12/6m,
 *                         join 20/10m, move 90/30m, resign 6/3m, draw 12/6m,
 *                         chat 40/20m, leaderboard 60/30m (api\*.php)
 *   abandoned games       GameRepo::STALE_MS
 *   client poll interval  assets/js/online.js, not the server
 *   session cookie name   hardcoded 'chess_sid' in Auth.php
 *   session lifetime      0 (a browser-session cookie) in Http.php
 *   admins                no admin area exists; delete this idea
 */
