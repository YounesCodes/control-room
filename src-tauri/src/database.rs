use std::{fs, path::Path};

use chrono::Utc;
use parking_lot::Mutex;
use rusqlite::{Connection, OptionalExtension, params};
use uuid::Uuid;

use crate::models::{
    AppSettings, ConnectionGroup, ConnectionTag, HistoryEntry, HistoryInput, HostCapabilities,
    LOG_TAIL_OPTIONS, PersistedTerminalLayout, PersistedWorkspaceState, SavedConnection,
    SavedConnectionInput, ScratchpadNote, ScratchpadNoteInput,
};

const LATEST_SCHEMA_VERSION: i64 = 4;
const MAX_DISPLAY_NAME_CHARS: usize = 80;
const MAX_DESTINATION_CHARS: usize = 255;
const MAX_USERNAME_CHARS: usize = 64;
const MAX_IDENTITY_PATH_CHARS: usize = 32_767;
const MAX_GROUP_NAME_CHARS: usize = 60;
const MAX_TAG_NAME_CHARS: usize = 32;
const MAX_TAGS_PER_CONNECTION: usize = 12;
const MAX_HISTORY_COMMAND_BYTES: usize = 1024 * 1024;
const MAX_SCRATCHPAD_CHARS: usize = 16_384;

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
        let mut connections = {
            let mut statement = connection
                .prepare(
                    "SELECT id, display_name, destination, username, port, identity_file, history_enabled, group_id, created_at, updated_at, last_connected_at FROM saved_connections ORDER BY display_name COLLATE NOCASE",
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
                "SELECT id, display_name, destination, username, port, identity_file, history_enabled, group_id, created_at, updated_at, last_connected_at FROM saved_connections WHERE id = ?1",
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
                "INSERT INTO saved_connections (id, display_name, destination, username, port, identity_file, history_enabled, group_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
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
        let changed = transaction
            .execute(
                "UPDATE saved_connections SET display_name = ?2, destination = ?3, username = ?4, port = ?5, identity_file = ?6, history_enabled = ?7, group_id = ?8, updated_at = ?9 WHERE id = ?1",
                params![
                    id,
                    input.display_name.trim(),
                    input.destination.trim(),
                    normalize_optional(input.username),
                    input.port,
                    normalize_optional(input.identity_file),
                    input.history_enabled,
                    input.group_id,
                    Utc::now().to_rfc3339(),
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
        if let Ok(state) = serde_json::from_str::<PersistedWorkspaceState>(&payload)
            && validate_workspace_state(&state).is_ok()
        {
            return Ok(state);
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
        connection_id: &str,
    ) -> Result<Option<ScratchpadNote>, String> {
        validate_scratchpad_owner(scope, owner_id, connection_id)?;
        self.connection
            .lock()
            .query_row(
                "SELECT id, scope, owner_id, connection_id, text, created_at, updated_at FROM scratchpad_notes WHERE scope = ?1 AND owner_id = ?2 AND connection_id = ?3",
                params![scope, owner_id, connection_id],
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
        let connection_exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM saved_connections WHERE id = ?1)",
                [&input.connection_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !connection_exists {
            return Err("Saved Connection not found".into());
        }
        let existing_connection: Option<String> = transaction
            .query_row(
                "SELECT connection_id FROM scratchpad_notes WHERE scope = ?1 AND owner_id = ?2",
                params![input.scope, input.owner_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if existing_connection
            .as_deref()
            .is_some_and(|existing| existing != input.connection_id)
        {
            return Err("Scratchpad owner belongs to another Saved Connection".into());
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
        connection_id: &str,
    ) -> Result<(), String> {
        validate_scratchpad_owner(scope, owner_id, connection_id)?;
        self.connection
            .lock()
            .execute(
                "DELETE FROM scratchpad_notes WHERE scope = ?1 AND owner_id = ?2 AND connection_id = ?3",
                params![scope, owner_id, connection_id],
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
    connection_id: &str,
) -> Result<(), String> {
    if scope != "connection" && scope != "workspace" {
        return Err("Scratchpad scope is invalid".into());
    }
    if Uuid::parse_str(owner_id).is_err() || Uuid::parse_str(connection_id).is_err() {
        return Err("Scratchpad owner identifiers are invalid".into());
    }
    if scope == "connection" && owner_id != connection_id {
        return Err("Connection scratchpad owner must match its Saved Connection".into());
    }
    Ok(())
}

fn validate_scratchpad_input(input: &ScratchpadNoteInput) -> Result<(), String> {
    validate_scratchpad_owner(&input.scope, &input.owner_id, &input.connection_id)?;
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

fn validate_workspace_state(state: &PersistedWorkspaceState) -> Result<(), String> {
    if state.workspaces.len() > 100 {
        return Err("Workspace state cannot contain more than 100 Workspaces".into());
    }
    let mut ids = std::collections::HashSet::new();
    for workspace in &state.workspaces {
        if Uuid::parse_str(&workspace.id).is_err()
            || Uuid::parse_str(&workspace.connection_id).is_err()
            || !ids.insert(workspace.id.as_str())
        {
            return Err("Workspace state contains invalid identifiers".into());
        }
        if workspace
            .label
            .as_ref()
            .is_some_and(|label| label.chars().count() > 80 || label.chars().any(char::is_control))
        {
            return Err("Workspace label is invalid".into());
        }
        if ![
            "overview",
            "terminal",
            "services",
            "ports",
            "docker",
            "logs",
            "history",
            "scratchpad",
        ]
        .contains(&workspace.view.as_str())
        {
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
    Ok(())
}

fn validate_persisted_layout(
    layout: &PersistedTerminalLayout,
    workspace_ids: &std::collections::HashSet<&str>,
    depth: usize,
) -> Result<(), String> {
    if depth > 16 {
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
            first,
            second,
        } => {
            if direction != "vertical" && direction != "horizontal" {
                return Err("Terminal split direction is invalid".into());
            }
            validate_persisted_layout(first, workspace_ids, depth + 1)?;
            validate_persisted_layout(second, workspace_ids, depth + 1)
        }
    }
}

fn validate_settings(settings: &AppSettings) -> Result<(), String> {
    if !(9..=32).contains(&settings.terminal_font_size) {
        return Err("Terminal font size must be between 9 and 32".into());
    }
    if !(100..=100_000).contains(&settings.terminal_scrollback) {
        return Err("Terminal scrollback must be between 100 and 100000".into());
    }
    if !LOG_TAIL_OPTIONS.contains(&settings.default_log_tail) {
        return Err("Unsupported default log tail count".into());
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
    if version < 2 {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
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
                PRAGMA user_version = 2;
                "#,
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    if version < 3 {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        transaction
            .execute_batch(
                r#"
                ALTER TABLE connection_tags
                ADD COLUMN color TEXT NOT NULL DEFAULT '#3a3a3a';
                PRAGMA user_version = 3;
                "#,
            )
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }
    if version < 4 {
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
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

                PRAGMA user_version = 4;
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
            group_id: None,
            tag_names: Vec::new(),
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
    fn connection_organization_persists_and_group_deletion_preserves_connections() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("control-room.db");
        let database = Database::open(&path).unwrap();
        let homelab = database.create_connection_group("Homelab").unwrap();
        let production = database.create_connection_group("Production").unwrap();
        database
            .set_connection_group_collapsed(&homelab.id, true)
            .unwrap();
        let groups = database
            .move_connection_group(&production.id, "up")
            .unwrap();
        assert_eq!(groups[0].id, production.id);
        assert!(groups[1].collapsed);

        let mut organized = input("Database");
        organized.group_id = Some(production.id.clone());
        database.create_connection_tag("Docker", "#3a3a3a").unwrap();
        database
            .create_connection_tag("Critical", "#8250df")
            .unwrap();
        organized.tag_names = vec![" Docker ".into(), "docker".into(), "Critical".into()];
        let saved = database.create_connection(organized).unwrap();
        assert_eq!(saved.group_id.as_deref(), Some(production.id.as_str()));
        assert_eq!(
            saved
                .tags
                .iter()
                .map(|tag| tag.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Critical", "Docker"]
        );
        assert_eq!(database.list_connection_tags().unwrap(), saved.tags);
        let critical_tag = saved
            .tags
            .iter()
            .find(|tag| tag.name == "Critical")
            .unwrap();
        let recolored = database
            .set_connection_tag_color(&critical_tag.id, "#A371F7")
            .unwrap();
        assert_eq!(recolored.color, "#a371f7");
        assert_eq!(
            database
                .get_connection(&saved.id)
                .unwrap()
                .tags
                .iter()
                .find(|tag| tag.id == critical_tag.id)
                .unwrap()
                .color,
            "#a371f7"
        );
        assert_eq!(
            database
                .set_connection_tag_color(&critical_tag.id, "purple")
                .unwrap_err(),
            "Tag colors must use #RRGGBB format"
        );

        database.delete_connection_group(&production.id).unwrap();
        let returned = database.get_connection(&saved.id).unwrap();
        assert_eq!(returned.group_id, None);
        assert_eq!(returned.tags.len(), 2);
        let renamed = database
            .rename_connection_tag(&critical_tag.id, "Priority")
            .unwrap();
        assert_eq!(renamed.name, "Priority");
        assert_eq!(
            database
                .get_connection(&saved.id)
                .unwrap()
                .tags
                .iter()
                .find(|tag| tag.id == critical_tag.id)
                .unwrap()
                .name,
            "Priority"
        );
        database.delete_connection_tag(&critical_tag.id).unwrap();
        assert_eq!(database.get_connection(&saved.id).unwrap().tags.len(), 1);
        drop(database);

        let reopened = Database::open(&path).unwrap();
        let groups = reopened.list_connection_groups().unwrap();
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].id, homelab.id);
        assert!(groups[0].collapsed);
        assert_eq!(reopened.get_connection(&saved.id).unwrap().group_id, None);
    }

    #[test]
    fn organization_names_and_tag_limits_are_deterministic() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("control-room.db")).unwrap();
        let first = database.create_connection_group(" Production ").unwrap();
        assert_eq!(first.name, "Production");
        assert_eq!(
            database.create_connection_group("production").unwrap_err(),
            "A group with that name already exists"
        );
        let second = database.create_connection_group("Staging").unwrap();
        assert_eq!(
            database
                .rename_connection_group(&second.id, "PRODUCTION")
                .unwrap_err(),
            "A group with that name already exists"
        );

        let mut unknown_tag = input("Unknown tag");
        unknown_tag.tag_names = vec!["missing".into()];
        assert_eq!(
            database.create_connection(unknown_tag).unwrap_err(),
            "Tag 'missing' does not exist"
        );

        database.create_connection_tag("docker", "#3a3a3a").unwrap();
        assert_eq!(
            database
                .create_connection_tag("DOCKER", "#3a3a3a")
                .unwrap_err(),
            "A tag with that name already exists"
        );

        let mut duplicate_tags = input("Duplicates");
        duplicate_tags.tag_names = vec!["docker".into(); MAX_TAGS_PER_CONNECTION + 1];
        assert_eq!(
            database
                .create_connection(duplicate_tags)
                .unwrap()
                .tags
                .len(),
            1
        );

        let mut too_many_tags = input("Too many");
        too_many_tags.tag_names = (0..=MAX_TAGS_PER_CONNECTION)
            .map(|index| format!("tag-{index}"))
            .collect();
        assert_eq!(
            database.create_connection(too_many_tags).unwrap_err(),
            "A Saved Connection can have at most 12 tags"
        );
    }

    #[test]
    fn scratchpad_notes_round_trip_under_both_scopes() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("control-room.db")).unwrap();
        let saved = database.create_connection(input("Laptop")).unwrap();
        let workspace_id = Uuid::new_v4().to_string();

        let connection_note = database
            .save_scratchpad_note(ScratchpadNoteInput {
                scope: "connection".into(),
                owner_id: saved.id.clone(),
                connection_id: saved.id.clone(),
                text: "/srv/api".into(),
            })
            .unwrap();
        let updated = database
            .save_scratchpad_note(ScratchpadNoteInput {
                scope: "connection".into(),
                owner_id: saved.id.clone(),
                connection_id: saved.id.clone(),
                text: "Redis reminder".into(),
            })
            .unwrap();
        assert_eq!(updated.id, connection_note.id);
        assert_eq!(updated.created_at, connection_note.created_at);
        assert_eq!(updated.text, "Redis reminder");

        let workspace_note = database
            .save_scratchpad_note(ScratchpadNoteInput {
                scope: "workspace".into(),
                owner_id: workspace_id.clone(),
                connection_id: saved.id.clone(),
                text: "Investigation only".into(),
            })
            .unwrap();
        assert_ne!(workspace_note.id, connection_note.id);
        assert_eq!(
            database
                .get_scratchpad_note("workspace", &workspace_id, &saved.id)
                .unwrap(),
            Some(workspace_note)
        );

        database
            .delete_scratchpad_note("workspace", &workspace_id, &saved.id)
            .unwrap();
        assert!(
            database
                .get_scratchpad_note("workspace", &workspace_id, &saved.id)
                .unwrap()
                .is_none()
        );
        database.delete_connection(&saved.id).unwrap();
        assert!(
            database
                .get_scratchpad_note("connection", &saved.id, &saved.id)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn scratchpad_validation_rejects_invalid_owners_and_oversized_text() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("control-room.db")).unwrap();
        let saved = database.create_connection(input("Laptop")).unwrap();
        let other_id = Uuid::new_v4().to_string();
        assert_eq!(
            database
                .save_scratchpad_note(ScratchpadNoteInput {
                    scope: "connection".into(),
                    owner_id: other_id,
                    connection_id: saved.id.clone(),
                    text: "wrong owner".into(),
                })
                .unwrap_err(),
            "Connection scratchpad owner must match its Saved Connection"
        );
        assert_eq!(
            database
                .save_scratchpad_note(ScratchpadNoteInput {
                    scope: "workspace".into(),
                    owner_id: Uuid::new_v4().to_string(),
                    connection_id: saved.id,
                    text: "x".repeat(MAX_SCRATCHPAD_CHARS + 1),
                })
                .unwrap_err(),
            "Scratchpad text must be at most 16384 characters"
        );
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
        let legacy = &database.list_connections().unwrap()[0];
        assert_eq!(legacy.id, "legacy");
        assert_eq!(legacy.group_id, None);
        assert!(legacy.tags.is_empty());
        let version: i64 = database
            .connection
            .lock()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, LATEST_SCHEMA_VERSION);
        let scratchpad_table: i64 = database
            .connection
            .lock()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'scratchpad_notes'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(scratchpad_table, 1);
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
    fn legacy_settings_receive_default_terminal_colors() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("control-room.db")).unwrap();
        database
            .connection
            .lock()
            .execute(
                "INSERT INTO application_settings (key, value) VALUES ('settings', ?1)",
                [r#"{"terminalFontFamily":"Consolas","terminalFontSize":14,"terminalScrollback":10000,"defaultLogTail":200,"globalHistoryEnabled":true}"#],
            )
            .unwrap();

        let settings = database.get_settings().unwrap();

        assert_eq!(settings.terminal_blue, AppSettings::default().terminal_blue);
        assert_eq!(
            settings.terminal_green,
            AppSettings::default().terminal_green
        );
    }

    #[test]
    fn invalid_terminal_colors_are_rejected() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("control-room.db")).unwrap();
        let settings = AppSettings {
            terminal_blue: "blue".into(),
            ..AppSettings::default()
        };

        assert_eq!(
            database.save_settings(&settings).unwrap_err(),
            "Terminal colors must use #RRGGBB format"
        );
    }

    #[test]
    fn advertised_log_tail_options_match_settings_validation() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("control-room.db")).unwrap();

        for default_log_tail in LOG_TAIL_OPTIONS {
            database
                .save_settings(&AppSettings {
                    default_log_tail,
                    ..AppSettings::default()
                })
                .unwrap();
        }

        assert_eq!(
            database
                .save_settings(&AppSettings {
                    default_log_tail: 51,
                    ..AppSettings::default()
                })
                .unwrap_err(),
            "Unsupported default log tail count"
        );
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

    #[test]
    fn disconnected_workspace_state_round_trips_without_session_data() {
        let directory = tempfile::tempdir().unwrap();
        let database = Database::open(&directory.path().join("control-room.db")).unwrap();
        let saved = database.create_connection(input("Laptop")).unwrap();
        let workspace_id = Uuid::new_v4().to_string();
        let state = PersistedWorkspaceState {
            workspaces: vec![crate::models::PersistedWorkspace {
                id: workspace_id.clone(),
                label: Some("Deploy".into()),
                connection_id: saved.id,
                view: "ports".into(),
                history_paused: false,
            }],
            active_workspace_id: Some(workspace_id.clone()),
            terminal_layout: Some(PersistedTerminalLayout::Leaf { workspace_id }),
        };

        database.save_workspace_state(&state).unwrap();

        assert_eq!(database.get_workspace_state().unwrap(), state);
    }
}
