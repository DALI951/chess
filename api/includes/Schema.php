<?php
declare(strict_types=1);

/**
 * The DDL, in one array, so a test can read it.
 *
 * This used to live inline in api/setup.php, which meant the only way to check
 * that a column in GameRepo's SELECT list actually existed was to install the
 * schema on a server and find out. Moving the statements here costs nothing and
 * lets SchemaTest.php compare the two lists directly - the check that catches a
 * renamed column before it reaches production instead of after.
 *
 * @author DALI951
 */
final class Schema
{
    /** @return array<string,string> table name => CREATE TABLE statement */
    public static function tables(): array
    {
        static $t = null;
        if ($t !== null) return $t;

        $t = [
            // One row, one flag. "Is this site installed" is a single value
            // rather than a survey of which tables happen to exist, so a partial
            // install is a state we can detect and finish rather than guess at.
            'app_meta' => "
                CREATE TABLE IF NOT EXISTS app_meta (
                    name        VARCHAR(64)  NOT NULL,
                    value       TEXT         NOT NULL,
                    updated_ms  BIGINT       NOT NULL,
                    PRIMARY KEY (name)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

            'users' => "
                CREATE TABLE IF NOT EXISTS users (
                    id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
                    username      VARCHAR(20)  NOT NULL,
                    display_name  VARCHAR(32)  NOT NULL,
                    pass_hash     VARCHAR(255) NOT NULL,
                    rating        INT          NOT NULL DEFAULT 1500,
                    games_played  INT UNSIGNED NOT NULL DEFAULT 0,
                    wins          INT UNSIGNED NOT NULL DEFAULT 0,
                    draws         INT UNSIGNED NOT NULL DEFAULT 0,
                    losses        INT UNSIGNED NOT NULL DEFAULT 0,
                    created_ms    BIGINT       NOT NULL,
                    last_seen_ms  BIGINT       NOT NULL,
                    PRIMARY KEY (id),
                    UNIQUE KEY uq_username (username),
                    KEY ix_rating (rating),
                    KEY ix_seen (last_seen_ms)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

            'remember_tokens' => "
                CREATE TABLE IF NOT EXISTS remember_tokens (
                    id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                    user_id     INT UNSIGNED NOT NULL,
                    token_hash  CHAR(64)     NOT NULL,
                    expires_ms  BIGINT       NOT NULL,
                    created_ms  BIGINT       NOT NULL,
                    PRIMARY KEY (id),
                    UNIQUE KEY uq_token (token_hash),
                    KEY ix_expires (expires_ms),
                    CONSTRAINT fk_rt_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

            'games' => "
                CREATE TABLE IF NOT EXISTS games (
                    id                  INT UNSIGNED NOT NULL AUTO_INCREMENT,
                    code                CHAR(6)      NOT NULL,
                    status              ENUM('waiting','active','ended') NOT NULL DEFAULT 'waiting',
                    white_user          INT UNSIGNED NULL,
                    black_user          INT UNSIGNED NULL,
                    fen                 VARCHAR(120) NOT NULL,
                    ply                 SMALLINT UNSIGNED NOT NULL DEFAULT 0,
                    sans                TEXT         NOT NULL,
                    pgn                 MEDIUMTEXT   NOT NULL,
                    tc_base_ms          INT UNSIGNED NOT NULL DEFAULT 0,
                    tc_increment_ms     INT UNSIGNED NOT NULL DEFAULT 0,
                    white_ms            INT UNSIGNED NOT NULL DEFAULT 0,
                    black_ms            INT UNSIGNED NOT NULL DEFAULT 0,
                    -- BIGINT, not INT: an unsigned INT millisecond stamp is gone in
                    -- 2038, and a chess server outlives its author's plans.
                    turn_started_at_ms  BIGINT       NULL,
                    turn_started_ms     INT UNSIGNED NULL,
                    result              TINYINT      NULL,
                    reason              VARCHAR(16)  NULL,
                    winner_user         INT UNSIGNED NULL,
                    ended_at_ms         BIGINT       NULL,
                    created_ms          BIGINT       NOT NULL,
                    updated_ms          BIGINT       NOT NULL,
                    PRIMARY KEY (id),
                    UNIQUE KEY uq_code (code),
                    KEY ix_lobby (updated_ms),
                    KEY ix_white (white_user, updated_ms),
                    KEY ix_black (black_user, updated_ms),
                    CONSTRAINT fk_g_white FOREIGN KEY (white_user) REFERENCES users (id) ON DELETE SET NULL,
                    CONSTRAINT fk_g_black FOREIGN KEY (black_user) REFERENCES users (id) ON DELETE SET NULL,
                    CONSTRAINT fk_g_win   FOREIGN KEY (winner_user) REFERENCES users (id) ON DELETE SET NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

            'game_moves' => "
                CREATE TABLE IF NOT EXISTS game_moves (
                    id        BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                    game_id   INT UNSIGNED NOT NULL,
                    ply       SMALLINT UNSIGNED NOT NULL,
                    san       VARCHAR(12)  NOT NULL,
                    uci       VARCHAR(5)   NOT NULL,
                    fen_after VARCHAR(120) NOT NULL,
                    white_ms  INT UNSIGNED NOT NULL,
                    black_ms  INT UNSIGNED NOT NULL,
                    made_ms   BIGINT NOT NULL,
                    PRIMARY KEY (id),
                    UNIQUE KEY uq_ply (game_id, ply),
                    CONSTRAINT fk_m_game FOREIGN KEY (game_id) REFERENCES games (id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

            'game_draw_offers' => "
                CREATE TABLE IF NOT EXISTS game_draw_offers (
                    game_id    INT UNSIGNED NOT NULL,
                    user_id    INT UNSIGNED NOT NULL,
                    created_ms BIGINT NOT NULL,
                    PRIMARY KEY (game_id),
                    CONSTRAINT fk_do_game FOREIGN KEY (game_id) REFERENCES games (id) ON DELETE CASCADE,
                    CONSTRAINT fk_do_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

            'chat_messages' => "
                CREATE TABLE IF NOT EXISTS chat_messages (
                    id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                    game_id    INT UNSIGNED NOT NULL,
                    user_id    INT UNSIGNED NOT NULL,
                    body       VARCHAR(500) NOT NULL,
                    created_ms BIGINT NOT NULL,
                    PRIMARY KEY (id),
                    KEY ix_game (game_id, id),
                    CONSTRAINT fk_c_game FOREIGN KEY (game_id) REFERENCES games (id) ON DELETE CASCADE,
                    CONSTRAINT fk_c_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

            'rate_limits' => "
                CREATE TABLE IF NOT EXISTS rate_limits (
                    k                VARCHAR(160) NOT NULL,
                    hits             INT UNSIGNED NOT NULL DEFAULT 0,
                    window_start_ms  BIGINT NOT NULL,
                    updated_ms       BIGINT NOT NULL,
                    PRIMARY KEY (k),
                    KEY ix_updated (updated_ms)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

            'friends' => "
                CREATE TABLE IF NOT EXISTS friends (
                    user_id    INT UNSIGNED NOT NULL,
                    friend_id  INT UNSIGNED NOT NULL,
                    created_ms BIGINT NOT NULL,
                    PRIMARY KEY (user_id, friend_id),
                    CONSTRAINT fk_f_user   FOREIGN KEY (user_id)   REFERENCES users (id) ON DELETE CASCADE,
                    CONSTRAINT fk_f_friend FOREIGN KEY (friend_id) REFERENCES users (id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",
        ];
        return $t;
    }

    /**
     * The column names of one table, parsed out of its DDL.
     *
     * Parsing SQL with a regex is normally a bad idea. Here it is the smallest
     * thing that works, because the DDL is ours: it is written in one style above,
     * and the thing being tested is exactly whether the names match.
     *
     * @return array<int,string>
     */
    public static function columns(string $table): array
    {
        $sql = self::tables()[$table] ?? null;
        if ($sql === null) return [];
        // between the outer parentheses
        $body = (string)preg_replace('/^\s*CREATE\s+TABLE.*?\((.*)\)[^)]*$/is', '$1', $sql);
        $body = (string)preg_replace('/--[^\n]*/', '', $body);   // strip the inline comments
        $out = [];
        foreach (explode(',', $body) as $part) {
            $part = trim($part);
            if (preg_match('/^`?([a-z_][a-z0-9_]*)`?\s+[A-Z]/i', $part, $m)) {
                $out[] = strtolower($m[1]);
            }
        }
        return $out;
    }
}
