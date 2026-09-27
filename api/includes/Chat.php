<?php
declare(strict_types=1);

/**
 * Chat for a game: the smallest useful thing that is not a websocket.
 *
 * The client polls this. That is a deliberate trade - no server to keep alive,
 * no protocol to get wrong, and a message is never more than a few seconds late,
 * which for "gg" and "your rook is hanging" is fine. The moment somebody wants
 * move-by-move chat during a game, this is the file that grows a socket.
 *
 * Messages are kept forever and moderated on the way IN, not on the way out:
 * deleting rows after somebody has already read them does not un-say them.
 *
 * @author DALI951
 */
final class Chat
{
    private const MAX_LEN = 500;
    private const HISTORY = 200;

    /**
     * @return array<int,array<string,mixed>>
     */
    public static function history(int $gameId, int $afterId = 0, int $limit = 100): array
    {
        $limit = max(1, min(self::HISTORY, $limit));
        $rows = Db::all(
            'SELECT m.id, m.user_id, m.body, m.created_ms, u.username, u.display_name
               FROM chat_messages m
               JOIN users u ON u.id = m.user_id
              WHERE m.game_id = :g AND m.id > :after
              ORDER BY m.id ASC LIMIT ' . $limit,
            ['g' => $gameId, 'after' => $afterId]
        );
        return array_map([self::class, 'shape'], $rows);
    }

    /**
     * @return array<string,mixed> the stored message
     */
    public static function post(int $gameId, int $userId, string $body): array
    {
        $body = self::clean($body);
        if ($body === '') {
            throw new HttpError('empty_message', 'Say something first.', 422);
        }
        // A message can only be sent by somebody sitting in the game. Watching is
        // allowed, talking is not: otherwise chat becomes a stranger's megaphone
        // in a game a stranger was invited to.
        $seated = Db::value(
            'SELECT 1 FROM games WHERE id = :g AND (white_user = :u OR black_user = :u2)',
            ['g' => $gameId, 'u' => $userId, 'u2' => $userId]
        );
        if ($seated === null) {
            throw new HttpError('not_a_player', 'Only the players can talk in this game.', 403);
        }

        Db::run(
            'INSERT INTO chat_messages (game_id, user_id, body, created_ms)
                  VALUES (:g, :u, :b, :now)',
            ['g' => $gameId, 'u' => $userId, 'b' => $body, 'now' => Db::nowMs()]
        );
        $id = (int)Db::conn()->lastInsertId();
        $row = Db::one(
            'SELECT m.id, m.user_id, m.body, m.created_ms, u.username, u.display_name
               FROM chat_messages m JOIN users u ON u.id = m.user_id WHERE m.id = :id',
            ['id' => $id]
        );
        return self::shape($row ?? ['id' => $id, 'user_id' => $userId, 'body' => $body, 'created_ms' => Db::nowMs()]);
    }

    /** @param array<string,mixed> $row */
    private static function shape(array $row): array
    {
        return [
            'id'           => (int)($row['id'] ?? 0),
            'user_id'      => (int)($row['user_id'] ?? 0),
            'username'     => (string)($row['username'] ?? ''),
            'display_name' => (string)($row['display_name'] ?? ''),
            'body'         => (string)($row['body'] ?? ''),
            'created_ms'   => (int)($row['created_ms'] ?? 0),
        ];
    }

    /**
     * Strip control characters, cap the length, collapse whitespace.
     *
     * There is no HTML escaping here on purpose: the client renders messages as
     * textContent, never as HTML, so there is nothing to escape. Escaping at
     * every layer instead of choosing one is how messages end up showing
     * &amp; to the people who typed them.
     */
    public static function clean(string $body): string
    {
        $body = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $body) ?? '';
        $body = trim(preg_replace('/\s+/u', ' ', $body) ?? '');
        return mb_substr($body, 0, self::MAX_LEN);
    }
}
