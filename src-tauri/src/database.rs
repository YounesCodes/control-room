use std::{fs, path::Path};

use chrono::Utc;
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

use crate::models::{
    AppSettings, ConnectionGroup, ConnectionTag, HistoryEntry, HistoryInput, HostCapabilities,
    LOG_TAIL_OPTIONS, LocalShellKind, PersistedTerminalGroup, PersistedTerminalLayout,
    PersistedWorkspaceState, SavedConnection, SavedConnectionInput, ScratchpadNote,
    ScratchpadNoteInput,
};

mod migrations;

const MAX_DISPLAY_NAME_CHARS: usize = 80;
const MAX_DESTINATION_CHARS: usize = 255;
const MAX_USERNAME_CHARS: usize = 64;
const MAX_IDENTITY_PATH_CHARS: usize = 32_767;
const MAX_GROUP_NAME_CHARS: usize = 60;
const MAX_TAG_NAME_CHARS: usize = 32;
const MAX_TAGS_PER_CONNECTION: usize = 5;
const MAX_HIDDEN_LOCAL_SHELLS: usize = 64;
pub(crate) const MAX_HISTORY_COMMAND_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_HISTORY_CWD_BYTES: usize = 32_767;
pub(crate) const MAX_SCRATCHPAD_CHARS: usize = 16_384;
pub(crate) const SCRATCHPAD_SCOPES: [&str; 3] = ["connection", "global", "local"];
pub(crate) const PERSISTED_WORKSPACE_VIEWS: [&str; 8] = [
    "terminal",
    "files",
    "services",
    "ports",
    "docker",
    "logs",
    "history",
    "scratchpad",
];
const REMOVED_WORKSPACE_VIEWS: [&str; 3] = ["overview", "boot", "baselines"];
const MAX_PERSISTED_WORKSPACES: usize = 100;
const MAX_SPLIT_DEPTH_FOR_UNIQUE_WORKSPACES: usize = MAX_PERSISTED_WORKSPACES - 1;

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
        migrations::migrate(&mut connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn list_connections(&self) -> Result<Vec<SavedConnection>, String> {
        let connection = self.connection.lock();
        let mut connections = {
            let mut statement = connection
                .prepare(
                    "SELECT id, display_name, destination, username, port, identity_file, history_enabled, group_id, created_at, updated_at, last_connected_at, sudo_enabled FROM saved_connections ORDER BY display_name COLLATE NOCASE",
                )
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map([], map_connection)
                .map_err(|error| error.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?
        };
        for saved in &mut connections {
            saved.tags = load_connection_tags(&connection, &saved.id)?;
        }
        Ok(connections)
    }

    pub fn get_connection(&self, id: &str) -> Result<SavedConnection, String> {
        let connection = self.connection.lock();
        let mut saved = connection
            .query_row(
                "SELECT id, display_name, destination, username, port, identity_file, history_enabled, group_id, created_at, updated_at, last_connected_at, sudo_enabled FROM saved_connections WHERE id = ?1",
                [id], map_connection,
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Saved Connection not found".to_string())?;
        saved.tags = load_connection_tags(&connection, id)?;
        Ok(saved)
    }

    pub fn create_connection(
        &self,
        input: SavedConnectionInput,
    ) -> Result<SavedConnection, String> {
        validate_connection_input(&input)?;
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        validate_group_reference(&transaction, input.group_id.as_deref())?;
        transaction
            .execute(
                "INSERT INTO saved_connections (id, display_name, destination, username, port, identity_file, history_enabled, group_id, created_at, updated_at, sudo_enabled) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10)",
                params![
                    id,
                    input.display_name.trim(),
                    input.destination.trim(),
                    normalize_optional(input.username),
                    input.port,
                    normalize_optional(input.identity_file),
                    input.history_enabled,
                    input.group_id,
                    now,
                    input.sudo_enabled,
                ],
            )
            .map_err(|error| error.to_string())?;
        sync_connection_tags(&transaction, &id, &input.tag_names)?;
        transaction.commit().map_err(|error| error.to_string())?;
        drop(connection);
        self.get_connection(&id)
    }

    pub fn update_connection(
        &self,
        id: &str,
        input: SavedConnectionInput,
    ) -> Result<SavedConnection, String> {
        validate_connection_input(&input)?;
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        validate_group_reference(&transaction, input.group_id.as_deref())?;
        let username = normalize_optional(input.username);
        let identity_file = normalize_optional(input.identity_file);
        let target_changed: bool = transaction.query_row(
            "SELECT destination != ?2 OR username IS NOT ?3 OR port IS NOT ?4 OR identity_file IS NOT ?5 FROM saved_connections WHERE id = ?1",
            params![id, input.destination.trim(), username, input.port, identity_file],
            |row| row.get(0),
        ).optional().map_err(|error| error.to_string())?
            .ok_or_else(|| "Saved Connection not found".to_string())?;
        if target_changed {
            transaction
                .execute(
                    "DELETE FROM host_capabilities WHERE connection_id = ?1",
                    [id],
                )
                .map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "UPDATE saved_connections SET last_connected_at = NULL WHERE id = ?1",
                    [id],
                )
                .map_err(|error| error.to_string())?;
        }
        let changed = transaction
            .execute(
                "UPDATE saved_connections SET display_name = ?2, destination = ?3, username = ?4, port = ?5, identity_file = ?6, history_enabled = ?7, group_id = ?8, updated_at = ?9, sudo_enabled = ?10 WHERE id = ?1",
                params![
                    id,
                    input.display_name.trim(),
                    input.destination.trim(),
                    username,
                    input.port,
                    identity_file,
                    input.history_enabled,
                    input.group_id,
                    Utc::now().to_rfc3339(),
                    input.sudo_enabled,
                ],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("Saved Connection not found".into());
        }
        sync_connection_tags(&transaction, id, &input.tag_names)?;
        transaction.commit().map_err(|error| error.to_string())?;
        drop(connection);
        self.get_connection(id)
    }

    pub fn list_connection_groups(&self) -> Result<Vec<ConnectionGroup>, String> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare("SELECT id, name, position, collapsed FROM connection_groups ORDER BY position, name COLLATE NOCASE")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(ConnectionGroup {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    position: row.get(2)?,
                    collapsed: row.get(3)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn list_connection_tags(&self) -> Result<Vec<ConnectionTag>, String> {
        let connection = self.connection.lock();
        let mut statement = connection
            .prepare("SELECT id, name, color FROM connection_tags ORDER BY normalized_name")
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok(ConnectionTag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn create_connection_tag(&self, name: &str, color: &str) -> Result<ConnectionTag, String> {
        let (name, normalized) = validate_organization_name(name, MAX_TAG_NAME_CHARS, "Tag")?;
        let color = normalize_tag_color(color)?;
        let tag = ConnectionTag {
            id: Uuid::new_v4().to_string(),
            name,
            color,
        };
        self.connection
            .lock()
            .execute(
                "INSERT INTO connection_tags (id, name, normalized_name, color) VALUES (?1, ?2, ?3, ?4)",
                params![tag.id, tag.name, normalized, tag.color],
            )
            .map_err(|error| map_organization_error(error, "tag"))?;
        Ok(tag)
    }

    pub fn rename_connection_tag(&self, id: &str, name: &str) -> Result<ConnectionTag, String> {
        validate_uuid(id, "Tag")?;
        let (name, normalized) = validate_organization_name(name, MAX_TAG_NAME_CHARS, "Tag")?;
        let connection = self.connection.lock();
        let changed = connection
            .execute(
                "UPDATE connection_tags SET name = ?2, normalized_name = ?3 WHERE id = ?1",
                params![id, name, normalized],
            )
            .map_err(|error| map_organization_error(error, "tag"))?;
        if changed == 0 {
            return Err("Tag not found".into());
        }
        connection
            .query_row(
                "SELECT id, name, color FROM connection_tags WHERE id = ?1",
                [id],
                |row| {
                    Ok(ConnectionTag {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        color: row.get(2)?,
                    })
                },
            )
            .map_err(|error| error.to_string())
    }

    pub fn delete_connection_tag(&self, id: &str) -> Result<(), String> {
        validate_uuid(id, "Tag")?;
        let changed = self
            .connection
            .lock()
            .execute("DELETE FROM connection_tags WHERE id = ?1", [id])
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("Tag not found".into());
        }
        Ok(())
    }

    pub fn set_connection_tag_color(&self, id: &str, color: &str) -> Result<ConnectionTag, String> {
        validate_uuid(id, "Tag")?;
        let color = normalize_tag_color(color)?;
        let connection = self.connection.lock();
        let changed = connection
            .execute(
                "UPDATE connection_tags SET color = ?2 WHERE id = ?1",
                params![id, color],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("Tag not found".into());
        }
        connection
            .query_row(
                "SELECT id, name, color FROM connection_tags WHERE id = ?1",
                [id],
                |row| {
                    Ok(ConnectionTag {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        color: row.get(2)?,
                    })
                },
            )
            .map_err(|error| error.to_string())
    }

    pub fn create_connection_group(&self, name: &str) -> Result<ConnectionGroup, String> {
        let (name, normalized) = validate_organization_name(name, MAX_GROUP_NAME_CHARS, "Group")?;
        let id = Uuid::new_v4().to_string();
        let connection = self.connection.lock();
        let position: i64 = connection
            .query_row(
                "SELECT COALESCE(MAX(position), -1) + 1 FROM connection_groups",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "INSERT INTO connection_groups (id, name, normalized_name, position, collapsed) VALUES (?1, ?2, ?3, ?4, 0)",
                params![id, name, normalized, position],
            )
            .map_err(|error| map_organization_error(error, "group"))?;
        Ok(ConnectionGroup {
            id,
            name,
            position,
            collapsed: false,
        })
    }

    pub fn rename_connection_group(&self, id: &str, name: &str) -> Result<ConnectionGroup, String> {
        validate_uuid(id, "Group")?;
        let (name, normalized) = validate_organization_name(name, MAX_GROUP_NAME_CHARS, "Group")?;
        let connection = self.connection.lock();
        let changed = connection
            .execute(
                "UPDATE connection_groups SET name = ?2, normalized_name = ?3 WHERE id = ?1",
                params![id, name, normalized],
            )
            .map_err(|error| map_organization_error(error, "group"))?;
        if changed == 0 {
            return Err("Group not found".into());
        }
        connection
            .query_row(
                "SELECT id, name, position, collapsed FROM connection_groups WHERE id = ?1",
                [id],
                |row| {
                    Ok(ConnectionGroup {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        position: row.get(2)?,
                        collapsed: row.get(3)?,
                    })
                },
            )
            .map_err(|error| error.to_string())
    }

    pub fn delete_connection_group(&self, id: &str) -> Result<(), String> {
        validate_uuid(id, "Group")?;
        let changed = self
            .connection
            .lock()
            .execute("DELETE FROM connection_groups WHERE id = ?1", [id])
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("Group not found".into());
        }
        Ok(())
    }

    pub fn set_connection_group_collapsed(&self, id: &str, collapsed: bool) -> Result<(), String> {
        validate_uuid(id, "Group")?;
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE connection_groups SET collapsed = ?2 WHERE id = ?1",
                params![id, collapsed],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err("Group not found".into());
        }
        Ok(())
    }

    pub fn move_connection_group(
        &self,
        id: &str,
        direction: &str,
    ) -> Result<Vec<ConnectionGroup>, String> {
        validate_uuid(id, "Group")?;
        if direction != "up" && direction != "down" {
            return Err("Group move direction is invalid".into());
        }
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let position: i64 = transaction
            .query_row(
                "SELECT position FROM connection_groups WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Group not found".to_string())?;
        let comparison = if direction == "up" { "<" } else { ">" };
        let order = if direction == "up" { "DESC" } else { "ASC" };
        let query = format!(
            "SELECT id, position FROM connection_groups WHERE position {comparison} ?1 ORDER BY position {order} LIMIT 1"
        );
        let neighbor: Option<(String, i64)> = transaction
            .query_row(&query, [position], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some((neighbor_id, neighbor_position)) = neighbor {
            transaction
                .execute(
                    "UPDATE connection_groups SET position = ?2 WHERE id = ?1",
                    params![id, neighbor_position],
                )
                .map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "UPDATE connection_groups SET position = ?2 WHERE id = ?1",
                    params![neighbor_id, position],
                )
                .map_err(|error| error.to_string())?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
        drop(connection);
        self.list_connection_groups()
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

    pub fn save_capabilities(
        &self,
        target: &SavedConnection,
        capabilities: &HostCapabilities,
    ) -> Result<(), String> {
        if target.id != capabilities.connection_id {
            return Err("Host capabilities do not belong to this Saved Connection".into());
        }
        let payload = serde_json::to_string(capabilities).map_err(|error| error.to_string())?;
        let changed = self.connection
            .lock()
            .execute(
                "INSERT INTO host_capabilities (connection_id, payload, detected_at) SELECT ?1, ?2, ?3 FROM saved_connections WHERE id = ?1 AND destination = ?4 AND username IS ?5 AND port IS ?6 AND identity_file IS ?7 ON CONFLICT(connection_id) DO UPDATE SET payload = excluded.payload, detected_at = excluded.detected_at, shell_catalog = CASE WHEN json_valid(host_capabilities.payload) AND json_extract(host_capabilities.payload, '$.osId') IS json_extract(excluded.payload, '$.osId') THEN host_capabilities.shell_catalog END",
                params![capabilities.connection_id, payload, capabilities.detected_at, target.destination, target.username, target.port, target.identity_file],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err(
                "Saved Connection changed while host capabilities were being read. Retry.".into(),
            );
        }
        Ok(())
    }

    /// Stores the remote shell catalog last read from this target, next to its
    /// capabilities. It is dropped with them when the target or its OS changes.
    pub fn save_shell_catalog(
        &self,
        target: &SavedConnection,
        catalog: &str,
    ) -> Result<(), String> {
        let changed = self
            .connection
            .lock()
            .execute(
                "UPDATE host_capabilities SET shell_catalog = ?2 WHERE connection_id = ?1 AND EXISTS (SELECT 1 FROM saved_connections WHERE id = ?1 AND destination = ?3 AND username IS ?4 AND port IS ?5 AND identity_file IS ?6)",
                params![target.id, catalog, target.destination, target.username, target.port, target.identity_file],
            )
            .map_err(|error| error.to_string())?;
        if changed == 0 {
            return Err(
                "Saved Connection changed while its remote shells were being read. Retry.".into(),
            );
        }
        Ok(())
    }

    pub fn get_shell_catalog(&self, id: &str) -> Result<Option<String>, String> {
        self.connection
            .lock()
            .query_row(
                "SELECT shell_catalog FROM host_capabilities WHERE connection_id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map(Option::flatten)
            .map_err(|error| error.to_string())
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
        if let Ok(mut settings) = serde_json::from_str::<AppSettings>(&payload) {
            if settings
                .default_local_shell_id
                .as_deref()
                .is_some_and(|id| LocalShellKind::from_profile_id(id).is_none())
            {
                settings.default_local_shell_id = None;
            }
            if validate_settings(&settings).is_ok() {
                return Ok(settings);
            }
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

    /// Small application metadata, stored in the same key/value table Settings
    /// and Workspace state already use.
    ///
    /// The updater's one-time "What's new" notice is the only user of this so
    /// far. It is a version string and its release notes, nothing else: no
    /// installer bytes, no download URL, and no release history. Reusing this
    /// table is deliberate, because a dedicated `app_metadata` table would have
    /// meant a schema migration for a mechanism the database already has.
    pub fn get_app_metadata(&self, key: &str) -> Result<Option<String>, String> {
        self.connection
            .lock()
            .query_row(
                "SELECT value FROM application_settings WHERE key = ?1",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn set_app_metadata(&self, key: &str, value: &str) -> Result<(), String> {
        self.connection
            .lock()
            .execute(
                "INSERT INTO application_settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [key, value],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn delete_app_metadata(&self, key: &str) -> Result<(), String> {
        self.connection
            .lock()
            .execute("DELETE FROM application_settings WHERE key = ?1", [key])
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn get_workspace_state(&self) -> Result<PersistedWorkspaceState, String> {
        let payload: Option<String> = self
            .connection
            .lock()
            .query_row(
                "SELECT value FROM application_settings WHERE key = 'workspace_state'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some(payload) = payload else {
            return Ok(PersistedWorkspaceState::default());
        };
        let is_legacy_terminal_layout = serde_json::from_str::<serde_json::Value>(&payload)
            .ok()
            .and_then(|value| {
                value
                    .as_object()
                    .map(|object| !object.contains_key("terminalGroups"))
            })
            .unwrap_or(false);
        let restored = serde_json::from_str::<serde_json::Value>(&payload)
            .ok()
            .and_then(|mut value| {
                if let Some(object) = value.as_object_mut() {
                    if let Some(workspaces) = object
                        .get_mut("workspaces")
                        .and_then(serde_json::Value::as_array_mut)
                    {
                        for workspace in workspaces {
                            if let Some(view) = workspace.get_mut("view")
                                && view
                                    .as_str()
                                    .is_some_and(|view| REMOVED_WORKSPACE_VIEWS.contains(&view))
                            {
                                *view = "terminal".into();
                            }
                        }
                    }
                    let mut sizes = serde_json::Map::new();
                    if let Some(entries) = object
                        .get("panelSizes")
                        .and_then(serde_json::Value::as_object)
                    {
                        for (key, value) in entries {
                            let bounds = panel_size_bounds(key);
                            let removed_page = key
                                .strip_prefix("content:")
                                .is_some_and(|view| REMOVED_WORKSPACE_VIEWS.contains(&view));
                            if !removed_page
                                && sizes.len() < 32
                                && let Some((min, max)) = bounds
                                && let Some(size) = value.as_f64()
                                && size.is_finite()
                            {
                                sizes.insert(
                                    key.clone(),
                                    serde_json::json!(
                                        size.round().clamp(min as f64, max as f64) as u32
                                    ),
                                );
                            }
                        }
                    }
                    object.insert("panelSizes".into(), serde_json::Value::Object(sizes));
                }
                serde_json::from_value::<PersistedWorkspaceState>(value).ok()
            });
        if let Some(mut state) = restored {
            if is_legacy_terminal_layout
                && state.terminal_groups.is_empty()
                && let Some(layout) = state.terminal_layout.clone()
            {
                state.terminal_groups.push(PersistedTerminalGroup {
                    id: "00000000-0000-4000-8000-000000000001".into(),
                    name: "Terminal group".into(),
                    layout,
                });
            }
            if validate_workspace_state(&state).is_ok() {
                return Ok(state);
            }
        }
        self.connection
            .lock()
            .execute(
                "DELETE FROM application_settings WHERE key = 'workspace_state'",
                [],
            )
            .map_err(|error| error.to_string())?;
        Ok(PersistedWorkspaceState::default())
    }

    pub fn save_workspace_state(&self, state: &PersistedWorkspaceState) -> Result<(), String> {
        validate_workspace_state(state)?;
        let payload = serde_json::to_string(state).map_err(|error| error.to_string())?;
        self.connection
            .lock()
            .execute(
                "INSERT INTO application_settings (key, value) VALUES ('workspace_state', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [payload],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn get_scratchpad_note(
        &self,
        scope: &str,
        owner_id: &str,
        connection_id: Option<&str>,
    ) -> Result<Option<ScratchpadNote>, String> {
        validate_scratchpad_owner(scope, owner_id, connection_id)?;
        self.connection
            .lock()
            .query_row(
                "SELECT id, scope, owner_id, connection_id, text, created_at, updated_at FROM scratchpad_notes WHERE scope = ?1 AND owner_id = ?2",
                params![scope, owner_id],
                map_scratchpad_note,
            )
            .optional()
            .map_err(|error| error.to_string())
    }

    pub fn save_scratchpad_note(
        &self,
        input: ScratchpadNoteInput,
    ) -> Result<ScratchpadNote, String> {
        validate_scratchpad_input(&input)?;
        let mut connection = self.connection.lock();
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        if let Some(connection_id) = input.connection_id.as_deref() {
            let connection_exists: bool = transaction
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM saved_connections WHERE id = ?1)",
                    [connection_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            if !connection_exists {
                return Err("Saved Connection not found".into());
            }
        }
        let now = Utc::now().to_rfc3339();
        let id = Uuid::new_v4().to_string();
        transaction
            .execute(
                "INSERT INTO scratchpad_notes (id, scope, owner_id, connection_id, text, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) ON CONFLICT(scope, owner_id) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at",
                params![id, input.scope, input.owner_id, input.connection_id, input.text, now],
            )
            .map_err(|error| error.to_string())?;
        let note = transaction
            .query_row(
                "SELECT id, scope, owner_id, connection_id, text, created_at, updated_at FROM scratchpad_notes WHERE scope = ?1 AND owner_id = ?2",
                params![input.scope, input.owner_id],
                map_scratchpad_note,
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(note)
    }

    pub fn delete_scratchpad_note(
        &self,
        scope: &str,
        owner_id: &str,
        connection_id: Option<&str>,
    ) -> Result<(), String> {
        validate_scratchpad_owner(scope, owner_id, connection_id)?;
        self.connection
            .lock()
            .execute(
                "DELETE FROM scratchpad_notes WHERE scope = ?1 AND owner_id = ?2",
                params![scope, owner_id],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

fn map_scratchpad_note(row: &rusqlite::Row<'_>) -> rusqlite::Result<ScratchpadNote> {
    Ok(ScratchpadNote {
        id: row.get(0)?,
        scope: row.get(1)?,
        owner_id: row.get(2)?,
        connection_id: row.get(3)?,
        text: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

fn validate_scratchpad_owner(
    scope: &str,
    owner_id: &str,
    connection_id: Option<&str>,
) -> Result<(), String> {
    if !SCRATCHPAD_SCOPES.contains(&scope) {
        return Err("Scratchpad scope is invalid".into());
    }
    if scope == "global" {
        if owner_id != "global" || connection_id.is_some() {
            return Err("Global scratchpad ownership is invalid".into());
        }
    } else if scope == "local" {
        if connection_id.is_some() || owner_id == "global" || Uuid::parse_str(owner_id).is_err() {
            return Err("Local terminal scratchpad ownership is invalid".into());
        }
    } else {
        let Some(connection_id) = connection_id else {
            return Err("Connection scratchpad ownership is invalid".into());
        };
        if Uuid::parse_str(owner_id).is_err()
            || Uuid::parse_str(connection_id).is_err()
            || owner_id != connection_id
        {
            return Err("Connection scratchpad owner must match its Saved Connection".into());
        }
    }
    Ok(())
}

fn validate_scratchpad_input(input: &ScratchpadNoteInput) -> Result<(), String> {
    validate_scratchpad_owner(
        &input.scope,
        &input.owner_id,
        input.connection_id.as_deref(),
    )?;
    if input.text.chars().count() > MAX_SCRATCHPAD_CHARS
        || input
            .text
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(format!(
            "Scratchpad text must be at most {MAX_SCRATCHPAD_CHARS} characters"
        ));
    }
    Ok(())
}

fn panel_size_bounds(key: &str) -> Option<(u32, u32)> {
    if key.len() > 64 {
        return None;
    }
    if key == "connections" {
        Some((200, 480))
    } else if key == "sidebar:hosts" {
        Some((96, 800))
    } else if key.starts_with("content:") {
        Some((360, 1600))
    } else if key.starts_with("split:") {
        Some((240, 900))
    } else {
        None
    }
}

fn validate_workspace_state(state: &PersistedWorkspaceState) -> Result<(), String> {
    if state.panel_sizes.len() > 32
        || state.panel_sizes.iter().any(|(key, size)| {
            let bounds = panel_size_bounds(key);
            bounds.is_none_or(|(min, max)| *size < min || *size > max)
        })
    {
        return Err("Workspace state contains invalid panel sizes".into());
    }
    if state.workspaces.len() > MAX_PERSISTED_WORKSPACES {
        return Err(format!(
            "Workspace state cannot contain more than {MAX_PERSISTED_WORKSPACES} Workspaces"
        ));
    }
    let mut ids = std::collections::HashSet::new();
    for workspace in &state.workspaces {
        if let Some(shell) = &workspace.remote_shell
            && (workspace.connection_id.is_none()
                || shell.id.is_empty()
                || shell.id.len() > 256
                || shell.label.is_empty()
                || shell.label.len() > 256
                || shell.id.chars().any(char::is_control)
                || shell.label.chars().any(char::is_control))
        {
            return Err("Workspace state contains an invalid remote shell".into());
        }
        if let Some(container) = &workspace.container
            && (workspace.connection_id.is_none()
                || workspace.remote_shell.is_some()
                || container.id.len() > 128
                || crate::ssh::validate_container_id(&container.id).is_err()
                || [&container.name, &container.image].into_iter().any(|text| {
                    text.is_empty() || text.len() > 512 || text.chars().any(char::is_control)
                }))
        {
            return Err("Workspace state contains an invalid container terminal".into());
        }
        if Uuid::parse_str(&workspace.id).is_err() || !ids.insert(workspace.id.as_str()) {
            return Err("Workspace state contains invalid identifiers".into());
        }
        match (&workspace.connection_id, &workspace.local_shell_id) {
            (Some(connection_id), None) => {
                if Uuid::parse_str(connection_id).is_err() {
                    return Err("Workspace state contains invalid identifiers".into());
                }
            }
            (None, Some(shell_id)) => {
                if LocalShellKind::from_profile_id(shell_id).is_none() {
                    return Err("Workspace state names an unknown local shell".into());
                }
            }
            _ => return Err("Workspace state must name one target per Workspace".into()),
        }
        if workspace
            .label
            .as_ref()
            .is_some_and(|label| label.chars().count() > 80 || label.chars().any(char::is_control))
        {
            return Err("Workspace label is invalid".into());
        }
        if !PERSISTED_WORKSPACE_VIEWS.contains(&workspace.view.as_str()) {
            return Err("Workspace view is invalid".into());
        }
    }
    if state
        .active_workspace_id
        .as_ref()
        .is_some_and(|id| !ids.contains(id.as_str()))
    {
        return Err("Active Workspace is missing from Workspace state".into());
    }
    if let Some(layout) = &state.terminal_layout {
        validate_persisted_layout(layout, &ids, 0)?;
    }
    if state.terminal_groups.len() > 100 {
        return Err("Workspace state cannot contain more than 100 terminal groups".into());
    }
    let mut group_ids = std::collections::HashSet::new();
    let mut grouped_workspaces = std::collections::HashSet::new();
    for group in &state.terminal_groups {
        if Uuid::parse_str(&group.id).is_err() || !group_ids.insert(group.id.as_str()) {
            return Err("Terminal group contains an invalid identifier".into());
        }
        let name = group.name.trim();
        if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
            return Err("Terminal group name is invalid".into());
        }
        validate_persisted_layout(&group.layout, &ids, 0)?;
        let mut members = Vec::new();
        collect_persisted_layout_ids(&group.layout, &mut members);
        for member in members {
            if !grouped_workspaces.insert(member) {
                return Err("A Workspace cannot belong to more than one terminal group".into());
            }
        }
    }
    Ok(())
}

fn collect_persisted_layout_ids<'a>(layout: &'a PersistedTerminalLayout, ids: &mut Vec<&'a str>) {
    match layout {
        PersistedTerminalLayout::Leaf { workspace_id } => ids.push(workspace_id),
        PersistedTerminalLayout::Split { first, second, .. } => {
            collect_persisted_layout_ids(first, ids);
            collect_persisted_layout_ids(second, ids);
        }
    }
}

fn validate_persisted_layout(
    layout: &PersistedTerminalLayout,
    workspace_ids: &std::collections::HashSet<&str>,
    depth: usize,
) -> Result<(), String> {
    if depth > MAX_SPLIT_DEPTH_FOR_UNIQUE_WORKSPACES {
        return Err("Terminal split layout is too deeply nested".into());
    }
    match layout {
        PersistedTerminalLayout::Leaf { workspace_id } => {
            if workspace_ids.contains(workspace_id.as_str()) {
                Ok(())
            } else {
                Err("Terminal split layout refers to a missing Workspace".into())
            }
        }
        PersistedTerminalLayout::Split {
            direction,
            ratio,
            first,
            second,
        } => {
            if direction != "vertical" && direction != "horizontal" {
                return Err("Terminal split direction is invalid".into());
            }
            if ratio.is_some_and(|ratio| !ratio.is_finite() || !(0.05..=0.95).contains(&ratio)) {
                return Err("Terminal split ratio is invalid".into());
            }
            validate_persisted_layout(first, workspace_ids, depth + 1)?;
            validate_persisted_layout(second, workspace_ids, depth + 1)
        }
    }
}

fn validate_settings(settings: &AppSettings) -> Result<(), String> {
    if ![2, 5, 10, 30].contains(&settings.host_metrics_interval_seconds) {
        return Err("Unsupported host metrics refresh interval".into());
    }
    if settings.host_metrics.len() > 6
        || settings
            .host_metrics
            .iter()
            .enumerate()
            .any(|(index, metric)| settings.host_metrics[..index].contains(metric))
    {
        return Err("Host metrics must be unique".into());
    }
    if !(9..=32).contains(&settings.terminal_font_size) {
        return Err("Terminal font size must be between 9 and 32".into());
    }
    if !(100..=100_000).contains(&settings.terminal_scrollback) {
        return Err("Terminal scrollback must be between 100 and 100000".into());
    }
    if !LOG_TAIL_OPTIONS.contains(&settings.default_log_tail) {
        return Err("Unsupported default log tail count".into());
    }
    if settings.hidden_local_shells.len() > MAX_HIDDEN_LOCAL_SHELLS {
        return Err("Too many hidden local terminals".into());
    }
    for shell_id in &settings.hidden_local_shells {
        if LocalShellKind::from_profile_id(shell_id).is_none() {
            return Err(format!("Unknown local terminal profile: {shell_id}"));
        }
    }
    if let Some(shell_id) = &settings.default_local_shell_id
        && LocalShellKind::from_profile_id(shell_id).is_none()
    {
        return Err(format!(
            "Unknown default local terminal profile: {shell_id}"
        ));
    }
    let font_family = settings.terminal_font_family.trim();
    if font_family.is_empty()
        || font_family.chars().count() > 500
        || font_family.chars().any(char::is_control)
    {
        return Err("Terminal font family is invalid".into());
    }
    for color in [
        &settings.terminal_foreground,
        &settings.terminal_red,
        &settings.terminal_green,
        &settings.terminal_yellow,
        &settings.terminal_blue,
        &settings.terminal_magenta,
        &settings.terminal_cyan,
    ] {
        if color.len() != 7
            || !color.starts_with('#')
            || !color[1..]
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        {
            return Err("Terminal colors must use #RRGGBB format".into());
        }
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
        sudo_enabled: row.get(11)?,
        group_id: row.get(7)?,
        tags: Vec::new(),
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
        last_connected_at: row.get(10)?,
    })
}

fn load_connection_tags(
    connection: &Connection,
    connection_id: &str,
) -> Result<Vec<ConnectionTag>, String> {
    let mut statement = connection
        .prepare(
            "SELECT tags.id, tags.name, tags.color FROM connection_tags tags JOIN saved_connection_tags links ON links.tag_id = tags.id WHERE links.connection_id = ?1 ORDER BY tags.normalized_name",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([connection_id], |row| {
            Ok(ConnectionTag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn validate_group_reference(
    transaction: &rusqlite::Transaction<'_>,
    group_id: Option<&str>,
) -> Result<(), String> {
    let Some(group_id) = group_id else {
        return Ok(());
    };
    validate_uuid(group_id, "Group")?;
    let exists: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM connection_groups WHERE id = ?1)",
            [group_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if exists {
        Ok(())
    } else {
        Err("Group not found".into())
    }
}

fn sync_connection_tags(
    transaction: &rusqlite::Transaction<'_>,
    connection_id: &str,
    tag_names: &[String],
) -> Result<(), String> {
    let normalized = normalize_tag_names(tag_names)?;
    transaction
        .execute(
            "DELETE FROM saved_connection_tags WHERE connection_id = ?1",
            [connection_id],
        )
        .map_err(|error| error.to_string())?;
    for (name, normalized_name) in normalized {
        let tag_id: Option<String> = transaction
            .query_row(
                "SELECT id FROM connection_tags WHERE normalized_name = ?1",
                [&normalized_name],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let tag_id = tag_id.ok_or_else(|| format!("Tag '{name}' does not exist"))?;
        transaction
            .execute(
                "INSERT INTO saved_connection_tags (connection_id, tag_id) VALUES (?1, ?2)",
                params![connection_id, tag_id],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn normalize_tag_names(tag_names: &[String]) -> Result<Vec<(String, String)>, String> {
    let mut values = std::collections::BTreeMap::new();
    for tag_name in tag_names {
        let (name, normalized) = validate_organization_name(tag_name, MAX_TAG_NAME_CHARS, "Tag")?;
        values.entry(normalized).or_insert(name);
    }
    if values.len() > MAX_TAGS_PER_CONNECTION {
        return Err(format!(
            "A Saved Connection can have at most {MAX_TAGS_PER_CONNECTION} tags"
        ));
    }
    Ok(values
        .into_iter()
        .map(|(normalized, name)| (name, normalized))
        .collect())
}

fn validate_organization_name(
    value: &str,
    maximum_chars: usize,
    kind: &str,
) -> Result<(String, String), String> {
    let name = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() || name.chars().count() > maximum_chars || name.chars().any(char::is_control)
    {
        return Err(format!(
            "{kind} name must be between 1 and {maximum_chars} characters"
        ));
    }
    let normalized = name.to_lowercase();
    Ok((name, normalized))
}

fn normalize_tag_color(value: &str) -> Result<String, String> {
    if value.len() != 7
        || !value.starts_with('#')
        || !value[1..]
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("Tag colors must use #RRGGBB format".into());
    }
    Ok(value.to_ascii_lowercase())
}

fn validate_uuid(value: &str, kind: &str) -> Result<(), String> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| format!("{kind} ID is invalid"))
}

fn map_organization_error(error: rusqlite::Error, kind: &str) -> String {
    if error.to_string().contains("UNIQUE constraint failed") {
        format!("A {kind} with that name already exists")
    } else {
        error.to_string()
    }
}

/// Trims an optional field and treats an all-whitespace value as absent. Saving
/// a connection and testing an unsaved one both go through this, so the
/// destination the user tested is the one that gets stored.
pub(crate) fn normalize_optional(value: Option<String>) -> Option<String> {
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
    normalize_tag_names(&input.tag_names)?;
    if let Some(group_id) = input.group_id.as_deref() {
        validate_uuid(group_id, "Group")?;
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
    if input
        .cwd
        .as_ref()
        .is_some_and(|cwd| cwd.len() > MAX_HISTORY_CWD_BYTES)
    {
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
mod tests;

#[cfg(test)]
mod layout_properties;
