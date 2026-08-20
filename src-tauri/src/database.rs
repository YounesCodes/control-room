use std::{fs, path::Path};

use chrono::Utc;
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

use crate::models::{
    AppSettings, HistoryEntry, HistoryInput, HostCapabilities, SavedConnection,
    SavedConnectionInput,
};

pub struct Database {
    connection: Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        connection
            .execute_batch(
                r#"
                PRAGMA foreign_keys = ON;
                PRAGMA journal_mode = WAL;

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
            .map_err(|error| error.to_string())?;
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
        let payload: Option<String> = self
            .connection
            .lock()
            .query_row(
                "SELECT payload FROM host_capabilities WHERE connection_id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        payload
            .map(|value| serde_json::from_str(&value).map_err(|error| error.to_string()))
            .transpose()
    }

    pub fn add_history(&self, input: HistoryInput) -> Result<HistoryEntry, String> {
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
        let search_pattern = format!("%{}%", search.unwrap_or_default());
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
        payload
            .map(|value| serde_json::from_str(&value).map_err(|error| error.to_string()))
            .transpose()
            .map(|value| value.unwrap_or_default())
    }

    pub fn save_settings(&self, settings: &AppSettings) -> Result<(), String> {
        if !(9..=32).contains(&settings.terminal_font_size) {
            return Err("Terminal font size must be between 9 and 32".into());
        }
        if !(100..=100_000).contains(&settings.terminal_scrollback) {
            return Err("Terminal scrollback must be between 100 and 100000".into());
        }
        if ![50, 100, 200, 500, 1000].contains(&settings.default_log_tail) {
            return Err("Unsupported default log tail count".into());
        }
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

fn validate_connection_input(input: &SavedConnectionInput) -> Result<(), String> {
    if input.display_name.trim().is_empty() {
        return Err("Display name is required".into());
    }
    let destination = input.destination.trim();
    if destination.is_empty()
        || destination.starts_with('-')
        || destination.chars().any(char::is_whitespace)
    {
        return Err("SSH destination must be one host, address, or OpenSSH alias".into());
    }
    if input
        .username
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .is_some_and(|username| {
            !username
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "._-".contains(character))
        })
    {
        return Err("Username contains unsupported characters".into());
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
            username: None,
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
                cwd: Some("/home/younes".into()),
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
    fn open_ssh_aliases_do_not_receive_fake_defaults() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("control-room.db")).unwrap();
        let saved = database.create_connection(input("Laptop")).unwrap();
        assert_eq!(saved.destination, "debian-laptop");
        assert_eq!(saved.port, None);
        assert_eq!(saved.username, None);
    }
}
