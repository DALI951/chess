<?php
declare(strict_types=1);

/**
 * api/auth.php - register, log in, log out, remember me, "who am I".
 *
 * One endpoint with an "action" field rather than five files, because they all
 * need the same three things: the session, the rate limiter, and a password.
 *
 * @author DALI951
 */

require_once __DIR__ . '/includes/bootstrap.php';

Http::endpoint(static function (): void {
    $action = Http::str('action', 20) ?: 'me';
    $now = Db::nowMs();

    switch ($action) {
        case 'me':
            $user = Auth::user();
            Http::done([
                'user'    => $user === null ? null : Auth::publicUser($user, $now),
                'now_ms'  => $now,
                'site'    => (string)Config::get('site.name', 'SHATRANGI'),
            ]);
            // no break: done() exits

        case 'register':
            Http::throttle('register', 5, 3);
            $user = Auth::register(Http::str('username', 20), Http::str('password', 200), Http::str('display_name', 32));
            if (Http::bool('remember')) Auth::issueRememberToken((int)$user['id']);
            GameRepo::expireStale($now);
            Http::done(['user' => Auth::publicUser($user, $now), 'now_ms' => $now]);
            // no break

        case 'login':
            Http::throttle('login', 10, 5);
            $user = Auth::login(Http::str('username', 40), Http::str('password', 200));
            if (Http::bool('remember')) Auth::issueRememberToken((int)$user['id']);
            Http::done(['user' => Auth::publicUser($user, $now), 'now_ms' => $now]);
            // no break

        case 'logout':
            Http::throttle('logout', 30);
            Auth::logout(Http::bool('remember'));
            Http::done(['now_ms' => $now]);
            // no break

        default:
            throw new HttpError('bad_action', 'Unknown action: ' . $action, 400);
    }
});
