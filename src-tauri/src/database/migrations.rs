use rusqlite::{Connection, OptionalExtension, Transaction};

use crate::models::AppSettings;

pub(super) struct Migration {
    pub(super) version: i64,
    apply: fn(&Transaction<'_>) -> Result<(), String>,
}

pub(super) const RETIRED_SCHEMA_VERSIONS: [i64; 3] = [7, 8, 9];

pub(super) const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        apply: create_initial_tables,
    },
    Migration {
        version: 2,
        apply: add_connection_groups_and_tags,
    },
    Migration {
        version: 3,
        apply: add_tag_colors,
    },
    Migration {
        version: 4,
        apply: add_scratchpad_notes,
    },
    Migration {
        version: 5,
        apply: scope_scratchpads_to_connection_or_global,
    },
    Migration {
        version: 6,
        apply: add_sudo_enabled,
    },
    Migration {
        version: 10,
        apply: add_local_scratchpad_scope,
    },
    Migration {
        version: 11,
        apply: adopt_campbell_terminal_colors,
    },
    Migration {
        version: 12,
        apply: reset_campbell_preview_terminal_colors,
    },
    Migration {
        version: 13,
        apply: brighten_terminal_foreground_from_aaaaaa,
    },
    Migration {
        version: 14,
        apply: brighten_terminal_foreground_from_bbbbbb,
    },
    Migration {
        version: 15,
        apply: brighten_terminal_foreground_from_cccccc,
    },
];

pub(super) const LATEST_SCHEMA_VERSION: i64 = MIGRATIONS[MIGRATIONS.len() - 1].version;

const _: () = {
    let mut index = 0;
    while index < MIGRATIONS.len() {
        let version = MIGRATIONS[index].version;
        assert!(version > 0, "schema versions start at 1");
        assert!(
            index == 0 || version > MIGRATIONS[index - 1].version,
            "migrations must be listed in strictly increasing version order"
        );
        let mut retired = 0;
        while retired < RETIRED_SCHEMA_VERSIONS.len() {
            assert!(
                version != RETIRED_SCHEMA_VERSIONS[retired],
                "a retired schema version cannot be reused"
            );
            retired += 1;
        }
        index += 1;
    }
};

pub(super) fn migrate(connection: &mut Connection) -> Result<(), String> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if version > LATEST_SCHEMA_VERSION {
        return Err(format!(
            "Database schema version {version} is newer than this app supports"
        ));
    }
    for migration in MIGRATIONS
        .iter()
        .filter(|migration| version < migration.version)
    {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        (migration.apply)(&transaction)?;
        transaction
            .execute_batch(&format!("PRAGMA user_version = {};", migration.version))
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    connection
        .execute_batch("DROP TABLE IF EXISTS host_baselines;")
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn create_initial_tables(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute_batch(
            r#"
                CREATE TABLE IF NOT EXISTS saved_connections (
                    id TEXT PRIMARY KEY,
                    display_name TEXT NOT NULL,
                    destination TEXT NOT NULL,
                    username TEXT,
                    port INTEGER,
                    identity_file TEXT,
                    history_enabled INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    last_connected_at TEXT
                );

                CREATE TABLE IF NOT EXISTS host_capabilities (
                    connection_id TEXT PRIMARY KEY REFERENCES saved_connections(id) ON DELETE CASCADE,
                    payload TEXT NOT NULL,
                    detected_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS command_history (
                    id TEXT PRIMARY KEY,
                    connection_id TEXT NOT NULL REFERENCES saved_connections(id) ON DELETE CASCADE,
                    session_id TEXT NOT NULL,
                    command TEXT NOT NULL,
                    cwd TEXT,
                    started_at TEXT NOT NULL,
                    finished_at TEXT,
                    exit_code INTEGER,
                    shell TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_history_connection_started
                ON command_history(connection_id, started_at DESC);

                CREATE TABLE IF NOT EXISTS application_settings (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );
            "#,
        )
        .map_err(|error| error.to_string())
}

fn add_connection_groups_and_tags(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute_batch(
            r#"
                CREATE TABLE connection_groups (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    normalized_name TEXT NOT NULL UNIQUE,
                    position INTEGER NOT NULL,
                    collapsed INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE connection_tags (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    normalized_name TEXT NOT NULL UNIQUE
                );

                ALTER TABLE saved_connections
                ADD COLUMN group_id TEXT REFERENCES connection_groups(id) ON DELETE SET NULL;

                CREATE TABLE saved_connection_tags (
                    connection_id TEXT NOT NULL REFERENCES saved_connections(id) ON DELETE CASCADE,
                    tag_id TEXT NOT NULL REFERENCES connection_tags(id) ON DELETE CASCADE,
                    PRIMARY KEY (connection_id, tag_id)
                );

                CREATE INDEX idx_saved_connections_group ON saved_connections(group_id);
                CREATE INDEX idx_saved_connection_tags_tag ON saved_connection_tags(tag_id);
            "#,
        )
        .map_err(|error| error.to_string())
}

fn add_tag_colors(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute_batch(
            r#"
                ALTER TABLE connection_tags
                ADD COLUMN color TEXT NOT NULL DEFAULT '#3a3a3a';
            "#,
        )
        .map_err(|error| error.to_string())
}

fn add_scratchpad_notes(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute_batch(
            r#"
                CREATE TABLE scratchpad_notes (
                    id TEXT PRIMARY KEY,
                    scope TEXT NOT NULL CHECK(scope IN ('connection', 'workspace')),
                    owner_id TEXT NOT NULL,
                    connection_id TEXT NOT NULL REFERENCES saved_connections(id) ON DELETE CASCADE,
                    text TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(scope, owner_id)
                );

                CREATE INDEX idx_scratchpad_notes_connection
                ON scratchpad_notes(connection_id);
            "#,
        )
        .map_err(|error| error.to_string())
}

fn scope_scratchpads_to_connection_or_global(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute_batch(
            r#"
                CREATE TABLE scratchpad_notes_v5 (
                    id TEXT PRIMARY KEY,
                    scope TEXT NOT NULL CHECK(scope IN ('connection', 'global')),
                    owner_id TEXT NOT NULL,
                    connection_id TEXT REFERENCES saved_connections(id) ON DELETE CASCADE,
                    text TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(scope, owner_id),
                    CHECK(
                        (scope = 'connection' AND connection_id IS NOT NULL AND owner_id = connection_id)
                        OR (scope = 'global' AND owner_id = 'global' AND connection_id IS NULL)
                    )
                );

                INSERT INTO scratchpad_notes_v5
                    (id, scope, owner_id, connection_id, text, created_at, updated_at)
                SELECT id, scope, owner_id, connection_id, text, created_at, updated_at
                FROM scratchpad_notes
                WHERE scope = 'connection' AND owner_id = connection_id;

                INSERT INTO scratchpad_notes_v5
                    (id, scope, owner_id, connection_id, text, created_at, updated_at)
                SELECT id, 'global', 'global', NULL, text, created_at, updated_at
                FROM scratchpad_notes
                WHERE scope = 'workspace'
                ORDER BY updated_at DESC
                LIMIT 1;

                DROP TABLE scratchpad_notes;
                ALTER TABLE scratchpad_notes_v5 RENAME TO scratchpad_notes;
                CREATE INDEX idx_scratchpad_notes_connection
                ON scratchpad_notes(connection_id);
            "#,
        )
        .map_err(|error| error.to_string())
}

fn add_sudo_enabled(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute_batch(
            r#"
                ALTER TABLE saved_connections
                ADD COLUMN sudo_enabled INTEGER NOT NULL DEFAULT 0;
            "#,
        )
        .map_err(|error| error.to_string())
}

fn add_local_scratchpad_scope(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute_batch(
            r#"
                CREATE TABLE scratchpad_notes_v10 (
                    id TEXT PRIMARY KEY,
                    scope TEXT NOT NULL CHECK(scope IN ('connection', 'global', 'local')),
                    owner_id TEXT NOT NULL,
                    connection_id TEXT REFERENCES saved_connections(id) ON DELETE CASCADE,
                    text TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(scope, owner_id),
                    CHECK(
                        (scope = 'connection' AND connection_id IS NOT NULL AND owner_id = connection_id)
                        OR (scope = 'global' AND owner_id = 'global' AND connection_id IS NULL)
                        OR (scope = 'local' AND owner_id <> 'global' AND connection_id IS NULL)
                    )
                );

                INSERT INTO scratchpad_notes_v10
                    (id, scope, owner_id, connection_id, text, created_at, updated_at)
                SELECT id, scope, owner_id, connection_id, text, created_at, updated_at
                FROM scratchpad_notes;

                DROP TABLE scratchpad_notes;
                ALTER TABLE scratchpad_notes_v10 RENAME TO scratchpad_notes;
                CREATE INDEX idx_scratchpad_notes_connection
                ON scratchpad_notes(connection_id);
            "#,
        )
        .map_err(|error| error.to_string())
}

fn adopt_campbell_terminal_colors(transaction: &Transaction<'_>) -> Result<(), String> {
    transaction
        .execute_batch("CREATE TABLE IF NOT EXISTS application_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")
        .map_err(|error| error.to_string())?;
    let payload: Option<String> = transaction
        .query_row(
            "SELECT value FROM application_settings WHERE key = 'settings'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(mut value) =
        payload.and_then(|payload| serde_json::from_str::<serde_json::Value>(&payload).ok())
    {
        let old = [
            ("terminalForeground", "#f2f2ee"),
            ("terminalRed", "#ff6f7d"),
            ("terminalGreen", "#52cf91"),
            ("terminalYellow", "#e8c56c"),
            ("terminalBlue", "#55aef2"),
            ("terminalMagenta", "#c793ff"),
            ("terminalCyan", "#65d4d1"),
        ];
        if old
            .iter()
            .all(|(key, color)| value.get(*key).and_then(|v| v.as_str()) == Some(*color))
        {
            value["terminalGreen"] = "#16c60c".into();
            value["terminalBlue"] = "#3b78ff".into();
            value["terminalMagenta"] = "#b4009e".into();
            transaction
                .execute(
                    "UPDATE application_settings SET value = ?1 WHERE key = 'settings'",
                    [serde_json::to_string(&value).map_err(|error| error.to_string())?],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn reset_campbell_preview_terminal_colors(transaction: &Transaction<'_>) -> Result<(), String> {
    let payload: Option<String> = transaction
        .query_row(
            "SELECT value FROM application_settings WHERE key = 'settings'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(mut value) =
        payload.and_then(|payload| serde_json::from_str::<serde_json::Value>(&payload).ok())
    {
        let old = [
            ("terminalForeground", "#f2f2ee"),
            ("terminalRed", "#ff6f7d"),
            ("terminalGreen", "#16c60c"),
            ("terminalYellow", "#e8c56c"),
            ("terminalBlue", "#3b78ff"),
            ("terminalMagenta", "#b4009e"),
            ("terminalCyan", "#65d4d1"),
        ];
        if old
            .iter()
            .all(|(key, color)| value.get(*key).and_then(|v| v.as_str()) == Some(*color))
        {
            let defaults =
                serde_json::to_value(AppSettings::default()).map_err(|error| error.to_string())?;
            for (key, _) in old {
                value[key] = defaults[key].clone();
            }
            transaction
                .execute(
                    "UPDATE application_settings SET value = ?1 WHERE key = 'settings'",
                    [serde_json::to_string(&value).map_err(|error| error.to_string())?],
                )
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn brighten_terminal_foreground_from_aaaaaa(transaction: &Transaction<'_>) -> Result<(), String> {
    replace_default_terminal_foreground(transaction, "#aaaaaa", "#bbbbbb")
}

fn brighten_terminal_foreground_from_bbbbbb(transaction: &Transaction<'_>) -> Result<(), String> {
    replace_default_terminal_foreground(transaction, "#bbbbbb", "#cccccc")
}

fn brighten_terminal_foreground_from_cccccc(transaction: &Transaction<'_>) -> Result<(), String> {
    replace_default_terminal_foreground(transaction, "#cccccc", "#dddddd")
}

fn replace_default_terminal_foreground(
    transaction: &Transaction<'_>,
    previous_default: &str,
    next_default: &str,
) -> Result<(), String> {
    let payload: Option<String> = transaction
        .query_row(
            "SELECT value FROM application_settings WHERE key = 'settings'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(mut value) =
        payload.and_then(|payload| serde_json::from_str::<serde_json::Value>(&payload).ok())
        && value.get("terminalForeground").and_then(|v| v.as_str()) == Some(previous_default)
    {
        value["terminalForeground"] = next_default.into();
        transaction
            .execute(
                "UPDATE application_settings SET value = ?1 WHERE key = 'settings'",
                [serde_json::to_string(&value).map_err(|error| error.to_string())?],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}
