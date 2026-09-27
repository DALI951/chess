<?php
declare(strict_types=1);

/**
 * api/social.php - friends, ratings, and the leaderboard.
 *
 * Ratings are a single Elo number updated after a game ends, and nothing more.
 * A full Glicko system with RDs, provisional scores and opponent-weighted
 * pooling is a genuinely hard piece of mathematics, and a wrong one is worse than
 * a simple one: it is the kind of wrong that looks reasonable and never gets
 * noticed. So this is plain Elo, it is legible, and it is a separate function
 * that can be replaced without touching anything else.
 *
 * @author DALI951
 */

require_once __DIR__ . '/includes/bootstrap.php';

Http::endpoint(static function (): void {
    $action = Http::str('action', 20) ?: 'leaderboard';
    $me     = Auth::user();
    $now    = Db::nowMs();

    switch ($action) {
        case 'leaderboard':
            // public, and the most-hit endpoint here by far
            Http::throttle('leaderboard', 60, 30);
            // The tiebreak is the username, not a wins column that does not
            // exist: this ORDER BY used to name wins_ms, and since there is no
            // such column the whole leaderboard was a 500 - the most-visited
            // page on the site, failing on every request.
            $top = Db::all(
                'SELECT id, username, display_name, rating, last_seen_ms
                   FROM users ORDER BY rating DESC, username ASC LIMIT 50'
            );
            Http::done([
                'players' => array_map([Auth::class, 'publicUser'], $top),
                'total'   => (int)Db::value('SELECT COUNT(*) FROM users'),
                'now_ms'  => $now,
            ]);

        case 'me':
            if ($me === null) throw new HttpError('not_logged_in', 'Log in first.', 401);
            // The record comes from the users row, not from re-deriving it out of
            // the games table every time somebody opens a page. It is written once
            // when a game ends, in the same transaction as the result, so a record
            // and a result can never disagree.
            Http::done([
                'user'   => Auth::publicUser($me, $now),
                'record' => [
                    'played' => (int)($me['games_played'] ?? 0),
                    'wins'   => (int)($me['wins'] ?? 0),
                    'draws'  => (int)($me['draws'] ?? 0),
                    'losses' => (int)($me['losses'] ?? 0),
                ],
                'now_ms' => $now,
            ]);

        case 'search':
            if ($me === null) throw new HttpError('not_logged_in', 'Log in first.', 401);
            Http::throttle('search', 30, 15);
            $q = Http::str('q', 20);
            if (mb_strlen($q) < 2) throw new HttpError('bad_query', 'Type at least two characters.', 422);
            // The wildcard is the one thing that has to be escaped by hand, and
            // it is escaped rather than removed: typing "a%b" should find nobody,
            // not find everybody.
            $rows = Db::all(
                'SELECT id, username, display_name, rating, last_seen_ms
                   FROM users
                  WHERE username LIKE :q ESCAPE \'\\\'
                    AND id <> :me
                  ORDER BY rating DESC LIMIT 20',
                ['q' => '%' . selfEscapeLike($q) . '%', 'me' => (int)$me['id']]
            );
            Http::done(['players' => array_map([Auth::class, 'publicUser'], $rows), 'now_ms' => $now]);

        case 'friend':
        case 'unfriend':
            if ($me === null) throw new HttpError('not_logged_in', 'Log in first.', 401);
            Http::throttle('friend', 30, 10);
            $id = Http::int('user');
            if ($id <= 0 || $id === (int)$me['id']) {
                throw new HttpError('bad_user', 'Pick somebody else.', 422);
            }
            $exists = Db::value('SELECT 1 FROM users WHERE id = :id', ['id' => $id]);
            if ($exists === null) throw new HttpError('no_such_user', 'No such player.', 404);

            if ($action === 'friend') {
                Db::run(
                    'INSERT INTO friends (user_id, friend_id, created_ms) VALUES (:a, :b, :now)
                     ON DUPLICATE KEY UPDATE created_ms = created_ms',
                    ['a' => (int)$me['id'], 'b' => $id, 'now' => $now]
                );
            } else {
                // The delete is symmetric - friendship is one row, not two - so
                // each side gets its own placeholder name. :a and :b written
                // twice apiece is SQLSTATE[HY093] under native prepares, which is
                // a 500 on every unfriend click.
                Db::run(
                    'DELETE FROM friends
                      WHERE (user_id = :a AND friend_id = :b)
                         OR (user_id = :b2 AND friend_id = :a2)',
                    ['a' => (int)$me['id'], 'b' => $id, 'b2' => $id, 'a2' => (int)$me['id']]
                );
            }
            Http::done(['friends' => socialFriends((int)$me['id'], $now), 'now_ms' => $now]);

        case 'friends':
            if ($me === null) throw new HttpError('not_logged_in', 'Log in first.', 401);
            Http::throttle('friends', 60, 30);
            Http::done(['friends' => socialFriends((int)$me['id'], $now), 'now_ms' => $now]);

        default:
            throw new HttpError('bad_action', 'Unknown action: ' . $action, 400);
    }
});

/** @return array<int,array<string,mixed>> */
function socialFriends(int $userId, int $now): array
{
    $rows = Db::all(
        'SELECT u.id, u.username, u.display_name, u.rating, u.last_seen_ms
           FROM friends f JOIN users u ON u.id = f.friend_id
          WHERE f.user_id = :u
          ORDER BY u.rating DESC LIMIT 200',
        ['u' => $userId]
    );
    return array_map([Auth::class, 'publicUser'], $rows);
}

function selfEscapeLike(string $q): string
{
    return str_replace(['\\', '%', '_'], ['\\\\', '\\%', '\\_'], $q);
}
