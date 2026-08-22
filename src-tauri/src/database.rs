use std::{fs, path::Path};

use chrono::Utc;
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

use crate::models::{
    AppSettings, HistoryEntry, HistoryInput, HostCapabilities, SavedConnection,
    SavedConnectionInput,
};

const LATEST_SCHEMA_VERSION: i64 = 1;
const MAX_DISPLAY_NAME_CHARS: usize = 80;
const MAX_DESTINATION_CHARS: usize = 255;
const MAX_USERNAME_CHARS: usize = 64;
const MAX_IDENTITY_PATH_CHARS: usize = 32_767;
const MAX_HISTORY_COMMAND_BYTES: usize = 1024 * 1024;

pub struct Database {
    connection: Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut connection = Connection::open(path).map_err(|error| error.to_string())?;
        connection
            .execute_batch(
                r#"
                PRAGMA foreign_keys = ON;
                PRAGMA journal_mode = WAL;
                "#,
            )
            .map_err(|error| error.to_string())?;
        migrate(&mut connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn list_connections(&self) -> Result<Vec<SavedConnection>, String> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare(
                "SELECT id, display_name, destination, username, port, identity_file, history_enabled, created_at, updated_at, last_connected_at FROM saved_connections ORDER BY display_name COLLATE NOCASE",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], map_connection)
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn get_connection(&self, id: &str) -> Result<SavedConnection, String> {
        self.connection
            .lock()
            .query_row(
                "SELECT id, display_name, destination, username, port, identity_file, history_enabled, created_at, updated_at, last_connected_at FROM saved_connections WHERE id = ?1",
                [id],
                map_connection,
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Saved Connection not found".into())
    }

    pub fn create_connection(
        &self,
        input: SavedConnectionInput,
    ) -> Result<SavedConnection, String> {
        validate_connection_input(&input)?;
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        self.connection
            .lock()
            .execute(
                "INSERT INTO saved_connections (id, display_name, destination, username, port, identity_file, history_enabled, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
                params![
                    id,
                    input.display_name.trim(),
                    input.destination.trim(),
                    normalize_optional(input.username),
                    input.port,
                    normalize_optional(input.identity_file),
                    input.history_enabled,
                    now,
                ],
            )
            .map_err(|error| error.to_string())?;
        self.get_connection(&id)
    }

    pub fn update_connection(
        &self,
        id: &str,
        input: SavedConnectionInput,
    ) -> Result<SavedConnection, String> {
        validate_connection_input(&input)?;
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE saved_connections SET display_name = ?2, destination = ?3, username = ?4, port = ?5, identity_file = ?6, history_enabled = ?7, updated_at = ?8 WHERE id = ?1",
                params![
                    id,
                    input.display_name.trim(),
                    input.destination.trim(),
                    normalize_optional(input.username),
                    input.port,
                    normalize_optional(input.identity_file),
                    input.history_enabled,
                    Utc::now().to_rfc3339(),
                ],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("Saved Connection not found".into());
        }
        self.get_connection(id)
    }

    pub fn delete_connection(&self, id: &str) -> Result<(), String> {
        let changed = self
            .connection
            .lock()
            .execute("DELETE FROM saved_connections WHERE id = ?1", [id])
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("Saved Connection not found".into());
        }
        Ok(())
    }

    pub fn mark_connected(&self, id: &str) -> Result<(), String> {
        self.connection
            .lock()
            .execute(
                "UPDATE saved_connections SET last_connected_at = ?2 WHERE id = ?1",
                params![id, Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn set_history_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE saved_connections SET history_enabled = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, enabled, Utc::now().to_rfc3339()],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("Saved Connection not found".into());
        }
        Ok(())
    }

    pub fn save_capabilities(&self, capabilities: &HostCapabilities) -> Result<(), String> {
        let payload = serde_json::to_string(capabilities).map_err(|error| error.to_string())?;
        self.connection
            .lock()
            .execute(
                "INSERT INTO host_capabilities (connection_id, payload, detected_at) VALUES (?1, ?2, ?3) ON CONFLICT(connection_id) DO UPDATE SET payload = excluded.payload, detected_at = excluded.detected_at",
                params![capabilities.connection_id, payload, capabilities.detected_at],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn get_capabilities(&self, id: &str) -> Result<Option<HostCapabilities>, String> {
        let cached: Option<(String, String)> = self
            .connection
            .lock()
            .query_row(
                "SELECT payload, detected_at FROM host_capabilities WHERE connection_id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some((payload, detected_at)) = cached else {
            return Ok(None);
        };
        match serde_json::from_str::<HostCapabilities>(&payload) {
            Ok(mut capabilities) => {
                if capabilities.connection_id.is_empty() {
                    capabilities.connection_id = id.into();
                }
                if capabilities.detected_at.is_empty() {
                    capabilities.detected_at = detected_at;
                }
                Ok(Some(capabilities))
            }
            Err(_) => {
                self.connection
                    .lock()
                    .execute(
                        "DELETE FROM host_capabilities WHERE connection_id = ?1",
                        [id],
                    )
                    .map_err(|error| error.to_string())?;
                Ok(None)
            }
        }
    }

    pub fn add_history(&self, input: HistoryInput) -> Result<HistoryEntry, String> {
        validate_history_input(&input)?;
        let command = input.command.trim_end().to_string();
        if command.trim().is_empty() {
            return Err("Cannot save an empty command".into());
        }
        let entry = HistoryEntry {
            id: Uuid::new_v4().to_string(),
            connection_id: input.connection_id,
            session_id: input.session_id,
            command,
            cwd: input.cwd,
            started_at: input.started_at,
            finished_at: input.finished_at,
            exit_code: input.exit_code,
            shell: input.shell,
        };
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO command_history (id, connection_id, session_id, command, cwd, started_at, finished_at, exit_code, shell) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![entry.id, entry.connection_id, entry.session_id, entry.command, entry.cwd, entry.started_at, entry.finished_at, entry.exit_code, entry.shell],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM command_history WHERE connection_id = ?1 AND id NOT IN (SELECT id FROM command_history WHERE connection_id = ?1 ORDER BY started_at DESC LIMIT 50000)",
                [&entry.connection_id],
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(entry)
    }

    pub fn list_history(
        &self,
        connection_id: &str,
        search: Option<&str>,
        limit: u32,
    ) -> Result<Vec<HistoryEntry>, String> {
        let connection = self.connection.lock();
        let search_pattern = format!("%{}%", escape_like(search.unwrap_or_default()));
        let mut statement = connection
            .prepare(
                "SELECT id, connection_id, session_id, command, cwd, started_at, finished_at, exit_code, shell FROM command_history WHERE connection_id = ?1 AND command LIKE ?2 ESCAPE '\\' ORDER BY started_at DESC LIMIT ?3",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(
                params![connection_id, search_pattern, limit.min(2_000)],
                |row| {
                    Ok(HistoryEntry {
                        id: row.get(0)?,
                        connection_id: row.get(1)?,
                        session_id: row.get(2)?,
                        command: row.get(3)?,
                        cwd: row.get(4)?,
                        started_at: row.get(5)?,
                        finished_at: row.get(6)?,
                        exit_code: row.get(7)?,
                        shell: row.get(8)?,
                    })
                },
            )
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn delete_history(&self, id: &str) -> Result<(), String> {
        self.connection
            .lock()
            .execute("DELETE FROM command_history WHERE id = ?1", [id])
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn clear_history(&self, connection_id: &str) -> Result<(), String> {
        self.connection
            .lock()
            .execute(
                "DELETE FROM command_history WHERE connection_id = ?1",
                [connection_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn get_settings(&self) -> Result<AppSettings, String> {
        let payload: Option<String> = self
            .connection
            .lock()
            .query_row(
                "SELECT value FROM application_settings WHERE key = 'settings'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some(payload) = payload else {
            return Ok(AppSettings::default());
        };
        if let Ok(settings) = serde_json::from_str::<AppSettings>(&payload)
            && validate_settings(&settings).is_ok()
        {
            return Ok(settings);
        }
        self.connection
            .lock()
            .execute(
                "DELETE FROM application_settings WHERE key = 'settings'",
                [],
            )
            .map_err(|error| error.to_string())?;
        Ok(AppSettings::default())
    }

    pub fn save_settings(&self, settings: &AppSettings) -> Result<(), String> {
        validate_settings(settings)?;
        let payload = serde_json::to_string(settings).map_err(|error| error.to_string())?;
        self.connection
            .lock()
            .execute(
                "INSERT INTO application_settings (key, value) VALUES ('settings', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [payload],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

fn validate_settings(settings: &AppSettings) -> Result<(), String> {
    if !(9..=32).contains(&settings.terminal_font_size) {
        return Err("Terminal font size must be between 9 and 32".into());
    }
    if !(100..=100_000).contains(&settings.terminal_scrollback) {
        return Err("Terminal scrollback must be between 100 and 100000".into());
    }
    if ![50, 100, 200, 500, 1000].contains(&settings.default_log_tail) {
        return Err("Unsupported default log tail count".into());
    }
    let font_family = settings.terminal_font_family.trim();
    if font_family.is_empty()
        || font_family.chars().count() > 500
        || font_family.chars().any(char::is_control)
    {
        return Err("Terminal font family is invalid".into());
    }
    Ok(())
}

fn migrate(connection: &mut Connection) -> Result<(), String> {
    let version: i64 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if version > LATEST_SCHEMA_VERSION {
        return Err(format!(
            "Database schema version {version} is newer than this app supports"
        ));
    }
    if version < 1 {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
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

                PRAGMA user_version = 1;
                "#,
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn map_connection(row: &rusqlite::Row<'_>) -> rusqlite::Result<SavedConnection> {
    Ok(SavedConnection {
        id: row.get(0)?,
        display_name: row.get(1)?,
        destination: row.get(2)?,
        username: row.get(3)?,
        port: row.get(4)?,
        identity_file: row.get(5)?,
        history_enabled: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
        last_connected_at: row.get(9)?,
    })
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

pub(crate) fn validate_connection_input(input: &SavedConnectionInput) -> Result<(), String> {
    let display_name = input.display_name.trim();
    if display_name.is_empty() {
        return Err("Display name is required".into());
    }
    if display_name.chars().count() > MAX_DISPLAY_NAME_CHARS
        || display_name.chars().any(char::is_control)
    {
        return Err(format!(
            "Display name must be at most {MAX_DISPLAY_NAME_CHARS} characters"
        ));
    }
    let destination = input.destination.trim();
    if destination.is_empty()
        || destination.chars().count() > MAX_DESTINATION_CHARS
        || destination.starts_with('-')
        || destination
            .chars()
            .any(|character| character.is_whitespace() || character.is_control())
    {
        return Err("SSH destination must be one host, address, or OpenSSH alias".into());
    }
    let username = input.username.as_deref().map(str::trim).unwrap_or_default();
    if username.is_empty() {
        return Err("Username is required".into());
    }
    if username.chars().count() > MAX_USERNAME_CHARS
        || !username
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
    {
        return Err("Username contains unsupported characters".into());
    }
    if input.port == Some(0) {
        return Err("Port must be between 1 and 65535".into());
    }
    if let Some(identity_file) = input
        .identity_file
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if identity_file.chars().count() > MAX_IDENTITY_PATH_CHARS
            || identity_file.chars().any(char::is_control)
        {
            return Err("Identity-file path is invalid".into());
        }
        if !Path::new(identity_file).is_file() {
            return Err("Identity file does not exist or is not a file".into());
        }
    }
    Ok(())
}

fn validate_history_input(input: &HistoryInput) -> Result<(), String> {
    if input.connection_id.is_empty() || input.session_id.is_empty() || input.session_id.len() > 128
    {
        return Err("History session identifiers are invalid".into());
    }
    if input.command.len() > MAX_HISTORY_COMMAND_BYTES {
        return Err("History command exceeds the 1 MiB limit".into());
    }
    if input.cwd.as_ref().is_some_and(|cwd| cwd.len() > 32_767) {
        return Err("History working directory is too long".into());
    }
    let started = chrono::DateTime::parse_from_rfc3339(&input.started_at)
        .map_err(|_| "History start time is invalid".to_string())?;
    if let Some(finished_at) = &input.finished_at {
        let finished = chrono::DateTime::parse_from_rfc3339(finished_at)
            .map_err(|_| "History finish time is invalid".to_string())?;
        if finished < started {
            return Err("History finish time precedes its start time".into());
        }
    }
    if input.shell != "bash" {
        return Err("Only Bash Enhanced History is supported".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(name: &str) -> SavedConnectionInput {
        SavedConnectionInput {
            display_name: name.into(),
            destination: "debian-laptop".into(),
            username: Some("test-user".into()),
            port: None,
            identity_file: None,
            history_enabled: true,
        }
    }

    #[test]
    fn connections_and_history_round_trip() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("control-room.db")).unwrap();
        let saved = database.create_connection(input("Laptop")).unwrap();
        assert_eq!(database.list_connections().unwrap(), vec![saved.clone()]);

        let history = database
            .add_history(HistoryInput {
                connection_id: saved.id.clone(),
                session_id: "session-a".into(),
                command: "docker ps".into(),
                cwd: Some("/home/test-user".into()),
                started_at: Utc::now().to_rfc3339(),
                finished_at: None,
                exit_code: Some(0),
                shell: "bash".into(),
            })
            .unwrap();
        assert_eq!(
            database
                .list_history(&saved.id, Some("docker"), 100)
                .unwrap()[0]
                .id,
            history.id
        );
        database.delete_connection(&saved.id).unwrap();
        assert!(
            database
                .list_history(&saved.id, None, 100)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn open_ssh_aliases_keep_explicit_username_and_default_port() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("control-room.db")).unwrap();
        let saved = database.create_connection(input("Laptop")).unwrap();
        assert_eq!(saved.destination, "debian-laptop");
        assert_eq!(saved.port, None);
        assert_eq!(saved.username.as_deref(), Some("test-user"));
    }

    #[test]
    fn unversioned_database_is_migrated_without_losing_connections() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("control-room.db");
        let connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(
                r#"
                CREATE TABLE saved_connections (
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
                INSERT INTO saved_connections
                    (id, display_name, destination, history_enabled, created_at, updated_at)
                VALUES ('legacy', 'Legacy host', 'legacy-host', 0, 'now', 'now');
                "#,
            )
            .unwrap();
        drop(connection);

        let database = Database::open(&path).unwrap();
        assert_eq!(database.list_connections().unwrap()[0].id, "legacy");
        let version: i64 = database
            .connection
            .lock()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, LATEST_SCHEMA_VERSION);
        drop(database);
        Database::open(&path).unwrap();
    }

    #[test]
    fn stale_capability_json_is_tolerated_and_repaired() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("control-room.db")).unwrap();
        let saved = database.create_connection(input("Laptop")).unwrap();
        database
            .connection
            .lock()
            .execute(
                "INSERT INTO host_capabilities (connection_id, payload, detected_at) VALUES (?1, ?2, ?3)",
                params![saved.id, r#"{"hostname":"laptop"}"#, "detected"],
            )
            .unwrap();
        let capabilities = database.get_capabilities(&saved.id).unwrap().unwrap();
        assert_eq!(capabilities.connection_id, saved.id);
        assert_eq!(capabilities.hostname.as_deref(), Some("laptop"));
        assert_eq!(capabilities.detected_at, "detected");

        database
            .connection
            .lock()
            .execute(
                "UPDATE host_capabilities SET payload = 'not-json' WHERE connection_id = ?1",
                [&saved.id],
            )
            .unwrap();
        assert!(database.get_capabilities(&saved.id).unwrap().is_none());
        assert!(database.get_capabilities(&saved.id).unwrap().is_none());
    }

    #[test]
    fn invalid_settings_are_discarded_before_the_frontend_uses_them() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("control-room.db")).unwrap();
        database
            .connection
            .lock()
            .execute(
                "INSERT INTO application_settings (key, value) VALUES ('settings', ?1)",
                [r#"{"terminalFontSize":0,"terminalScrollback":4294967295}"#],
            )
            .unwrap();

        let settings = database.get_settings().unwrap();
        assert_eq!(
            settings.terminal_font_size,
            AppSettings::default().terminal_font_size
        );
        let stored: i64 = database
            .connection
            .lock()
            .query_row(
                "SELECT COUNT(*) FROM application_settings WHERE key = 'settings'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(stored, 0);
    }

    #[test]
    fn history_search_treats_like_metacharacters_literally() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("control-room.db")).unwrap();
        let saved = database.create_connection(input("Laptop")).unwrap();
        for command in ["echo 100%", "echo 100x", "show_a", "showXa"] {
            database
                .add_history(HistoryInput {
                    connection_id: saved.id.clone(),
                    session_id: "session-a".into(),
                    command: command.into(),
                    cwd: None,
                    started_at: Utc::now().to_rfc3339(),
                    finished_at: None,
                    exit_code: Some(0),
                    shell: "bash".into(),
                })
                .unwrap();
        }
        assert_eq!(
            database.list_history(&saved.id, Some("%"), 100).unwrap()[0].command,
            "echo 100%"
        );
        assert_eq!(
            database.list_history(&saved.id, Some("_"), 100).unwrap()[0].command,
            "show_a"
        );
    }

    #[test]
    fn invalid_connection_and_history_inputs_are_rejected() {
        let mut connection_input = input("Laptop");
        connection_input.username = None;
        assert_eq!(
            validate_connection_input(&connection_input).unwrap_err(),
            "Username is required"
        );
        connection_input.username = Some("test-user".into());
        connection_input.port = Some(0);
        assert_eq!(
            validate_connection_input(&connection_input).unwrap_err(),
            "Port must be between 1 and 65535"
        );
        connection_input.port = None;
        connection_input.identity_file = Some("missing-private-key".into());
        assert_eq!(
            validate_connection_input(&connection_input).unwrap_err(),
            "Identity file does not exist or is not a file"
        );

        let mut history = HistoryInput {
            connection_id: "connection".into(),
            session_id: "session".into(),
            command: "pwd".into(),
            cwd: None,
            started_at: "not-a-time".into(),
            finished_at: None,
            exit_code: Some(0),
            shell: "bash".into(),
        };
        assert_eq!(
            validate_history_input(&history).unwrap_err(),
            "History start time is invalid"
        );
        history.started_at = Utc::now().to_rfc3339();
        history.shell = "zsh".into();
        assert_eq!(
            validate_history_input(&history).unwrap_err(),
            "Only Bash Enhanced History is supported"
        );
    }
}
