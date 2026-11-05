//! Bounded journald reads that reconstruct one boot's retained evidence as
//! replayable events. Everything here is read-only: the host is never asked
//! to reboot, toggle services, or write anything. The reader asks for two
//! capped streams — systemd's own manager messages (milestones and unit
//! lifecycle) and the warning-and-above filter — plus two one-entry reads
//! that bound the boot's journal coverage. Pages continue through journal
//! cursors, and every output is bounded before it leaves the remote shell.

use chrono::Utc;
use parking_lot::Mutex;
use serde_json::Value;
use std::{
    borrow::Cow,
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use crate::{
    models::{BootReplayEntry, BootReplayPage, SavedConnection},
    remote::{Elevation, RemoteCommandExecutor, shell_single_quote, validate_boot_id},
};

/// Entries retained per stream per page. One extra entry is peeked so a page
/// that stopped exactly at the cap reports truncation without costing another
/// round trip.
const PAGE_EVENT_LIMIT: usize = 250;
const MANAGER_STREAM_LIMIT: usize = PAGE_EVENT_LIMIT + 1;
const ALERT_STREAM_LIMIT: usize = PAGE_EVENT_LIMIT + 1;
const MAX_MESSAGE_CHARS: usize = 500;
const MAX_UNIT_CHARS: usize = 160;
const MAX_SOURCE_CHARS: usize = 128;
const MAX_CURSOR_CHARS: usize = 512;
const STREAM_BYTE_LIMIT: usize = 1024 * 1024;

#[derive(Default)]
pub struct ReplayRequests {
    requests: Mutex<HashMap<String, ReplayRequestState>>,
}

struct ReplayRequestState {
    cancelled: Arc<AtomicBool>,
    started: bool,
    created: Instant,
}

pub struct ReplayRequest<'a> {
    registry: &'a ReplayRequests,
    id: String,
    pub cancelled: Arc<AtomicBool>,
}

impl ReplayRequests {
    fn entry<'a>(
        requests: &'a mut HashMap<String, ReplayRequestState>,
        id: &str,
    ) -> Result<&'a mut ReplayRequestState, String> {
        uuid::Uuid::parse_str(id).map_err(|_| "Invalid boot replay request id".to_string())?;
        requests
            .retain(|_, state| state.started || state.created.elapsed() < Duration::from_secs(60));
        if requests.len() >= 128 && !requests.contains_key(id) {
            return Err("Too many boot replay requests".into());
        }
        Ok(requests
            .entry(id.to_string())
            .or_insert_with(|| ReplayRequestState {
                cancelled: Arc::new(AtomicBool::new(false)),
                started: false,
                created: Instant::now(),
            }))
    }

    pub fn begin(&self, id: &str) -> Result<ReplayRequest<'_>, String> {
        let mut requests = self.requests.lock();
        let state = Self::entry(&mut requests, id)?;
        if state.started {
            return Err("Boot replay request is already running".into());
        }
        state.started = true;
        Ok(ReplayRequest {
            registry: self,
            id: id.to_string(),
            cancelled: Arc::clone(&state.cancelled),
        })
    }

    pub fn cancel(&self, id: &str) -> Result<(), String> {
        // A bounded tombstone handles cancellation arriving before the async
        // collector has started, including while it is queued for a permit.
        Self::entry(&mut self.requests.lock(), id)?
            .cancelled
            .store(true, Ordering::SeqCst);
        Ok(())
    }
}

impl Drop for ReplayRequest<'_> {
    fn drop(&mut self) {
        self.registry.requests.lock().remove(&self.id);
    }
}

pub fn collect_boot_replay(
    connection: &SavedConnection,
    boot_id: &str,
    manager_cursor: Option<&str>,
    alert_cursor: Option<&str>,
    elevation: &Elevation,
    cancelled: &AtomicBool,
) -> Result<BootReplayPage, String> {
    let boot_id = boot_id.to_ascii_lowercase();
    validate_boot_id(&boot_id)?;
    let manager_cursor = normalized_cursor(manager_cursor)?;
    let alert_cursor = normalized_cursor(alert_cursor)?;
    let command = boot_replay_command(&boot_id, manager_cursor, alert_cursor);
    let output = RemoteCommandExecutor::execute_elevated_cancellable(
        connection,
        "collect_boot_replay",
        &command,
        elevation,
        cancelled,
    )?;
    let text = output.success_text()?;
    parse_boot_replay_page(&text, &boot_id)
}

/// Journal cursors are opaque host values, so the accepted character set is
/// narrow on purpose: everything `journalctl --cursor`/`--after-cursor` emit
/// and nothing that could reinterpret the surrounding shell.
fn normalized_cursor(cursor: Option<&str>) -> Result<Option<&str>, String> {
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    let cursor = cursor.trim();
    if cursor.is_empty() {
        return Ok(None);
    }
    if cursor.len() > MAX_CURSOR_CHARS
        || !cursor.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, ';' | ':' | '=' | '+' | '/' | '.' | '-' | '_')
        })
    {
        return Err("Invalid journal cursor".into());
    }
    Ok(Some(cursor))
}

fn boot_replay_script(
    boot_id: &str,
    manager_cursor: Option<&str>,
    alert_cursor: Option<&str>,
) -> String {
    let manager_cursor = manager_cursor.unwrap_or("");
    let alert_cursor = alert_cursor.unwrap_or("");
    format!(
        r#"boot_selector='{boot_id}'
manager_cursor='{manager_cursor}'
alert_cursor='{alert_cursor}'
printf '__CR_PROBE__\n'
if ! command -v journalctl >/dev/null 2>&1; then
  printf '__CR_ERROR__\tjournalctl is not installed\n__CR_END__\n'; exit 0
fi
printf '__CR_OK__\n__CR_END__\n'
# Keep exit status and diagnostics in the bounded response. A missing status
# means the byte cap interrupted the read, never a successful empty stream.
read_journal() {{
  (
    journalctl --system --boot "$boot_selector" --no-pager --output=json --output-fields=__CURSOR,__MONOTONIC_TIMESTAMP,__REALTIME_TIMESTAMP,PRIORITY,_COMM,SYSLOG_IDENTIFIER,UNIT,_SYSTEMD_UNIT,MESSAGE "$@" 2>&1
    printf '\n__CR_STATUS__\t%s\n' "$?"
  ) | head -c {STREAM_BYTE_LIMIT}
  printf '\n'
}}
printf '__CR_COVERAGE__\n'
read_journal -n +1 | sed 's/^/E /'
read_journal -n 1 | sed 's/^/L /'
printf '__CR_END__\n'
printf '__CR_MANAGER__\n'
if test -n "$manager_cursor"; then read_journal --after-cursor "$manager_cursor" _PID=1 -n +{MANAGER_STREAM_LIMIT}
else read_journal _PID=1 -n +{MANAGER_STREAM_LIMIT}; fi
printf '__CR_END__\n'
printf '__CR_ALERT__\n'
if test -n "$alert_cursor"; then read_journal --after-cursor "$alert_cursor" --priority=warning -n +{ALERT_STREAM_LIMIT}
else read_journal --priority=warning -n +{ALERT_STREAM_LIMIT}; fi
printf '__CR_END__\n'"#
    )
}

fn boot_replay_command(
    boot_id: &str,
    manager_cursor: Option<&str>,
    alert_cursor: Option<&str>,
) -> String {
    format!(
        "env LC_ALL=C sh -c {}",
        shell_single_quote(&boot_replay_script(boot_id, manager_cursor, alert_cursor))
    )
}

/// Lines of one section, or `None` when the remote script never printed the
/// marker (a truncated or foreign response, never a normal host state).
fn section_lines<'a>(text: &'a str, marker: &str) -> Option<Vec<&'a str>> {
    let start = text.lines().position(|line| line == marker)?;
    Some(
        text.lines()
            .skip(start + 1)
            .take_while(|line| *line != "__CR_END__")
            .collect(),
    )
}

fn parse_boot_replay_page(text: &str, boot_id: &str) -> Result<BootReplayPage, String> {
    let probe = section_lines(text, "__CR_PROBE__")
        .ok_or_else(|| "Boot journal probe was not returned by the host".to_string())?;
    if probe.contains(&"__CR_OK__") {
        // The probe read one entry to prove the journal is both present and
        // readable; the sections below carry the actual evidence.
    } else if let Some(message) = tagged_lines(&probe, "__CR_PERMISSION__").first() {
        return Ok(BootReplayPage {
            collected_at: Utc::now().to_rfc3339(),
            boot_id: boot_id.to_string(),
            manager_events: Vec::new(),
            alert_events: Vec::new(),
            manager_next_cursor: None,
            alert_next_cursor: None,
            manager_truncated: false,
            alert_truncated: false,
            earliest_monotonic_us: None,
            latest_monotonic_us: None,
            permission_required: true,
            errors: vec![bounded_replay_text(message, 160)],
        });
    } else if let Some(message) = tagged_lines(&probe, "__CR_ERROR__").first() {
        return Err(bounded_replay_text(message, 160));
    } else {
        return Err("Boot journal probe was not returned by the host".into());
    }

    let mut errors = Vec::new();
    let mut permission_required = false;
    // Coverage prints one tagged line per bound read, so a host where only
    // one of the two reads worked never has its newest entry mistaken for
    // the oldest.
    let mut earliest = None;
    let mut latest = None;
    match section_lines(text, "__CR_COVERAGE__") {
        Some(lines) => {
            for (tag, destination) in [("E ", &mut earliest), ("L ", &mut latest)] {
                let bound: Vec<&str> = lines
                    .iter()
                    .filter_map(|line| line.strip_prefix(tag))
                    .filter(|line| !line.is_empty())
                    .collect();
                inspect_read(
                    &bound,
                    "Journal coverage",
                    &mut errors,
                    &mut permission_required,
                );
                *destination = bound.iter().find_map(|line| coverage_monotonic(line));
            }
        }
        None => {
            errors.push("Boot journal coverage was not returned by the host".into());
        }
    }
    let manager = stream_section(text, "__CR_MANAGER__", PAGE_EVENT_LIMIT);
    inspect_read(
        &manager.lines,
        "Systemd manager events",
        &mut errors,
        &mut permission_required,
    );
    if manager.missing {
        errors.push("Systemd manager events were not returned by the host".into());
    }
    let alert = stream_section(text, "__CR_ALERT__", PAGE_EVENT_LIMIT);
    inspect_read(
        &alert.lines,
        "Warning events",
        &mut errors,
        &mut permission_required,
    );
    if alert.missing {
        errors.push("Warning events were not returned by the host".into());
    }
    for (label, stream) in [("Systemd manager", &manager), ("Warning", &alert)] {
        if stream
            .lines
            .iter()
            .filter(|line| line.starts_with('{'))
            .take(PAGE_EVENT_LIMIT)
            .any(|line| {
                serde_json::from_str::<Value>(line)
                    .ok()
                    .and_then(|value| replay_entry_from_json(&value))
                    .is_none()
            })
        {
            errors.push(format!(
                "{label} records were skipped because their journal fields could not be decoded."
            ));
        }
        if stream.truncated && stream.next_cursor.is_none() {
            errors.push(format!(
                "{label} records reached the page limit without a resumable journal cursor."
            ));
        }
    }

    Ok(BootReplayPage {
        collected_at: Utc::now().to_rfc3339(),
        boot_id: boot_id.to_string(),
        manager_events: manager.events,
        alert_events: alert.events,
        manager_next_cursor: manager.next_cursor,
        alert_next_cursor: alert.next_cursor,
        manager_truncated: manager.truncated,
        alert_truncated: alert.truncated,
        earliest_monotonic_us: earliest,
        latest_monotonic_us: latest,
        permission_required,
        errors,
    })
}

fn tagged_lines<'a>(lines: &[&'a str], tag: &str) -> Vec<&'a str> {
    lines
        .iter()
        .filter_map(|line| {
            line.strip_prefix(tag)
                .and_then(|rest| rest.strip_prefix('\t'))
        })
        .collect()
}

fn coverage_monotonic(payload: &str) -> Option<u64> {
    serde_json::from_str::<Value>(payload)
        .ok()
        .and_then(|value| json_number(&value, "__MONOTONIC_TIMESTAMP"))
}

fn inspect_read(lines: &[&str], label: &str, errors: &mut Vec<String>, permission: &mut bool) {
    let mut status = None;
    for line in lines {
        if let Some(code) = line.strip_prefix("__CR_STATUS__\t") {
            status = code.parse::<u32>().ok();
            continue;
        }
        if line.is_empty() {
            continue;
        }
        if line.starts_with('{') && serde_json::from_str::<Value>(line).is_ok() {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if lower.contains("permission denied")
            || lower.contains("not permitted")
            || lower.contains("not seeing messages")
            || lower.contains("insufficient permissions")
        {
            *permission = true;
            errors.push(format!("{label} requires permission; retry with sudo."));
        } else if !lower.contains("no entries")
            && !lower.contains("no journal files were found")
            && !lower.contains("users in groups")
            && !lower.contains("turn off this notice")
        {
            errors.push(format!(
                "{label}: some records or diagnostics could not be decoded."
            ));
        }
    }
    if status != Some(0) {
        errors.push(format!(
            "{label}: the read failed or reached its byte limit."
        ));
    }
    errors.sort();
    errors.dedup();
}

struct ReplayStream<'a> {
    events: Vec<BootReplayEntry>,
    next_cursor: Option<String>,
    truncated: bool,
    missing: bool,
    lines: Vec<&'a str>,
}

fn stream_section<'a>(text: &'a str, marker: &str, page_limit: usize) -> ReplayStream<'a> {
    let Some(lines) = section_lines(text, marker) else {
        return ReplayStream {
            events: Vec::new(),
            next_cursor: None,
            truncated: false,
            missing: true,
            lines: Vec::new(),
        };
    };
    let records: Vec<&str> = lines
        .iter()
        .copied()
        .filter(|line| line.starts_with('{'))
        .collect();
    if records.len() > page_limit {
        let mut events = Vec::with_capacity(page_limit);
        for line in records.iter().take(page_limit) {
            push_entry(&mut events, line);
        }
        let next_cursor = records
            .iter()
            .take(page_limit)
            .next_back()
            .and_then(|line| serde_json::from_str::<Value>(line).ok())
            .and_then(|value| {
                value
                    .get("__CURSOR")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .filter(|cursor| normalized_cursor(Some(cursor)).ok().flatten().is_some());
        return ReplayStream {
            events,
            next_cursor,
            truncated: true,
            missing: false,
            lines,
        };
    }
    let mut events = Vec::with_capacity(lines.len());
    for line in &records {
        push_entry(&mut events, line);
    }
    ReplayStream {
        events,
        next_cursor: None,
        truncated: false,
        missing: false,
        lines,
    }
}

fn push_entry(events: &mut Vec<BootReplayEntry>, line: &str) {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return;
    };
    if let Some(entry) = replay_entry_from_json(&value) {
        events.push(entry);
    }
}

/// One journal `--output=json` line. Fields journald did not record stay
/// `None` rather than being invented; an entry without a MESSAGE is dropped
/// because a replay row with nothing to show is not evidence.
fn replay_entry_from_json(value: &Value) -> Option<BootReplayEntry> {
    let raw_message = value.get("MESSAGE")?;
    let message_text = text_value(raw_message);
    let message_truncated = raw_message.is_null()
        || message_text
            .as_ref()
            .is_some_and(|text| text.chars().count() > MAX_MESSAGE_CHARS);
    let message = if raw_message.is_null() {
        "Message omitted by journalctl because it exceeds its field limit.".into()
    } else {
        bounded_text_value(raw_message, MAX_MESSAGE_CHARS)?
    };
    let monotonic_us = json_number(value, "__MONOTONIC_TIMESTAMP");
    let realtime_us = json_number(value, "__REALTIME_TIMESTAMP");
    let priority = json_number(value, "PRIORITY")
        .and_then(|priority| u8::try_from(priority).ok())
        .filter(|priority| *priority <= 7);
    let source = value
        .get("_COMM")
        .or_else(|| value.get("SYSLOG_IDENTIFIER"))
        .and_then(|field| bounded_text_value(field, MAX_SOURCE_CHARS));
    let unit = value
        .get("UNIT")
        .or_else(|| value.get("_SYSTEMD_UNIT"))
        .and_then(|field| bounded_text_value(field, MAX_UNIT_CHARS));
    let id = value
        .get("__CURSOR")
        .and_then(|field| bounded_text_value(field, MAX_CURSOR_CHARS))
        .unwrap_or_else(|| {
            // Without a cursor there is no host-provided identity, so a
            // deterministic digest of the entry's own facts stands in.
            use std::hash::{Hash, Hasher};
            let mut hasher = std::collections::hash_map::DefaultHasher::new();
            monotonic_us.hash(&mut hasher);
            realtime_us.hash(&mut hasher);
            message.hash(&mut hasher);
            format!("derived-{:016x}", hasher.finish())
        });
    Some(BootReplayEntry {
        id,
        monotonic_us,
        realtime_us,
        priority,
        source,
        unit,
        message,
        message_truncated,
    })
}

/// journalctl's `--output=json` writes printable fields as JSON strings and
/// binary fields as numeric arrays; both are read back as text.
fn bounded_text_value(value: &Value, max_chars: usize) -> Option<String> {
    let text = text_value(value)?;
    let bounded = bounded_replay_text(&text, max_chars);
    (!bounded.is_empty()).then_some(bounded)
}

fn text_value(value: &Value) -> Option<Cow<'_, str>> {
    match value {
        Value::String(text) => Some(Cow::Borrowed(text)),
        Value::Array(items) => {
            let bytes: Option<Vec<u8>> = items
                .iter()
                .map(|item| u8::try_from(item.as_u64()?).ok())
                .collect();
            String::from_utf8(bytes?).ok().map(Cow::Owned)
        }
        _ => None,
    }
}

/// journalctl serializes numeric fields as strings; accept both spellings.
fn json_number(value: &Value, key: &str) -> Option<u64> {
    let field = value.get(key)?;
    field
        .as_u64()
        .or_else(|| field.as_str().and_then(|text| text.parse().ok()))
}

fn bounded_replay_text(value: &str, max_chars: usize) -> String {
    value
        .chars()
        .filter(|character| !character.is_control() || matches!(*character, '\t' | '\n'))
        .take(max_chars)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_handles_active_and_not_yet_started_requests_and_releases_them() {
        let registry = ReplayRequests::default();
        let id = uuid::Uuid::new_v4().to_string();
        registry.cancel(&id).unwrap();
        let request = registry.begin(&id).unwrap();
        assert!(request.cancelled.load(Ordering::SeqCst));
        assert!(registry.begin(&id).is_err());
        drop(request);
        assert!(registry.requests.lock().is_empty());
        let request = registry.begin(&id).unwrap();
        assert!(!request.cancelled.load(Ordering::SeqCst));
        registry.cancel(&id).unwrap();
        assert!(request.cancelled.load(Ordering::SeqCst));
        assert!(registry.cancel("hostile;id").is_err());
    }

    #[test]
    fn pending_cancellation_storage_is_bounded() {
        let registry = ReplayRequests::default();
        for _ in 0..128 {
            registry.cancel(&uuid::Uuid::new_v4().to_string()).unwrap();
        }
        assert!(registry.cancel(&uuid::Uuid::new_v4().to_string()).is_err());
        assert_eq!(registry.requests.lock().len(), 128);
    }

    #[test]
    fn uses_the_subject_unit_and_marks_shortened_or_omitted_messages() {
        let value = serde_json::json!({"MESSAGE": "x".repeat(700), "UNIT": "nginx.service", "_SYSTEMD_UNIT": "init.scope"});
        let entry = replay_entry_from_json(&value).unwrap();
        assert_eq!(entry.unit.as_deref(), Some("nginx.service"));
        assert_eq!(entry.message.len(), MAX_MESSAGE_CHARS);
        assert!(entry.message_truncated);
        let omitted = replay_entry_from_json(&serde_json::json!({"MESSAGE": null})).unwrap();
        assert!(omitted.message_truncated);
        assert!(omitted.message.contains("omitted"));
        let multiline =
            replay_entry_from_json(&serde_json::json!({"MESSAGE": "line one\nline two"})).unwrap();
        assert_eq!(multiline.message, "line one\nline two");
        assert!(!multiline.message_truncated);
        let bytes: Vec<u8> = "é".repeat(400).into_bytes();
        let binary = replay_entry_from_json(&serde_json::json!({"MESSAGE": bytes})).unwrap();
        assert_eq!(binary.message.chars().count(), 400);
        assert!(!binary.message_truncated);
    }

    #[test]
    #[cfg(windows)]
    fn shell_reports_permission_and_failed_streams_instead_of_empty_success() {
        let bash = crate::local_shell::resolve_installed("git-bash").unwrap();
        let stub = r#"journalctl() {
case "$*" in
  *"_PID=1"*) printf 'Permission denied\n' >&2; return 1 ;;
  *) printf '%s\n' '{"__CURSOR":"s=fixture","__MONOTONIC_TIMESTAMP":"100","MESSAGE":"retained warning","PRIORITY":"4"}' ;;
esac
}
"#;
        let script = format!(
            "{stub}\n{}",
            boot_replay_script(&"a".repeat(32), None, None)
        );
        let output = crate::ssh::background_command(bash.program())
            .args(["--noprofile", "--norc", "-c", &script])
            .output()
            .unwrap();
        assert!(output.status.success());
        let page =
            parse_boot_replay_page(&String::from_utf8(output.stdout).unwrap(), &"a".repeat(32))
                .unwrap();
        assert!(page.permission_required);
        assert!(page.manager_events.is_empty());
        assert!(!page.alert_events.is_empty());
        assert!(
            page.errors
                .iter()
                .any(|error| error.contains("read failed"))
        );
    }

    #[test]
    #[cfg(windows)]
    fn oversized_shell_output_is_bounded_and_reports_partial_evidence() {
        let bash = crate::local_shell::resolve_installed("git-bash").unwrap();
        let stub = "journalctl() { head -c 2097152 /dev/zero | tr '\\0' 'x'; }";
        let script = format!(
            "{stub}\n{}",
            boot_replay_script(&"a".repeat(32), None, None)
        );
        let output = crate::ssh::background_command(bash.program())
            .args(["--noprofile", "--norc", "-c", &script])
            .output()
            .unwrap();
        assert!(output.stdout.len() <= 4 * (STREAM_BYTE_LIMIT + 128));
        let page =
            parse_boot_replay_page(&String::from_utf8(output.stdout).unwrap(), &"a".repeat(32))
                .unwrap();
        assert!(!page.errors.is_empty());
    }

    #[test]
    fn successful_user_only_journals_still_offer_elevation_and_incomplete_reads_stay_partial() {
        let text = probe_page(
            "__CR_MANAGER__\nHint: You are currently not seeing messages from other users and the system.\n__CR_END__\n__CR_ALERT__\n__CR_END__\n",
        );
        let page = parse_boot_replay_page(&text, &"a".repeat(32)).unwrap();
        assert!(page.permission_required);
        let interrupted = text.replace("__CR_STATUS__\t0", "");
        let page = parse_boot_replay_page(&interrupted, &"a".repeat(32)).unwrap();
        assert!(!page.errors.is_empty());
    }

    fn journal_entry(cursor: &str, message: &str, monotonic: &str) -> String {
        format!(
            r#"{{"__CURSOR":"{cursor}","__REALTIME_TIMESTAMP":"1730000000000000","__MONOTONIC_TIMESTAMP":"{monotonic}","PRIORITY":"6","_COMM":"systemd","MESSAGE":"{message}"}}"#
        )
    }

    fn probe_page(extra_sections: &str) -> String {
        let extra_sections = extra_sections
            .replace(
                "__CR_COVERAGE__\n",
                "__CR_COVERAGE__\nE __CR_STATUS__\t0\nL __CR_STATUS__\t0\n",
            )
            .replace("__CR_END__", "__CR_STATUS__\t0\n__CR_END__");
        format!("__CR_PROBE__\n__CR_OK__\n__CR_END__\n{extra_sections}")
    }

    #[test]
    fn rejects_invalid_boot_ids_but_normalizes_cursors() -> Result<(), String> {
        assert!(validate_boot_id("nothex").is_err());
        assert!(validate_boot_id(&"a".repeat(31)).is_err());
        assert!(normalized_cursor(Some("'; reboot")).is_err());
        assert!(normalized_cursor(Some(&"a".repeat(600))).is_err());
        assert_eq!(normalized_cursor(Some("  "))?, None);
        assert_eq!(
            normalized_cursor(Some("s=abc;i=1;b=def;m=2"))?,
            Some("s=abc;i=1;b=def;m=2")
        );
        Ok::<(), String>(())
    }

    #[test]
    fn command_pages_each_stream_through_validated_cursors() {
        let script = boot_replay_script(&"a".repeat(32), Some("s=abc;i=1"), None);
        assert!(script.contains("boot_selector='aaaaaaa"));
        assert!(script.contains("manager_cursor='s=abc;i=1'"));
        assert!(script.contains(r#"alert_cursor=''"#));
        assert!(script.contains(r#"read_journal --after-cursor "$manager_cursor" _PID=1"#));
        assert!(script.contains(r#"read_journal --priority=warning"#));
        assert!(script.contains(&format!("-n +{}", PAGE_EVENT_LIMIT + 1)));
        assert!(script.contains(&format!("head -c {STREAM_BYTE_LIMIT}")));

        let command = boot_replay_command(&"a".repeat(32), Some("s=abc;i=1"), None);
        // The whole script is one quoted argument. Cursor bytes cannot break
        // out of the sh -c argument, including the semicolons in real cursors.
        assert!(command.starts_with("env LC_ALL=C sh -c '"));
    }

    #[test]
    fn parses_probe_manager_and_alert_streams_with_coverage() {
        let earliest = journal_entry("c1", "earliest", "120");
        let latest = journal_entry("c2", "latest", "98765");
        let manager = journal_entry("m1", "Reached target Basic System.", "40120");
        let alert = journal_entry("a1", "wlan0: link is not ready", "55210");
        let text = probe_page(&format!(
            "__CR_COVERAGE__\nE {earliest}\nL {latest}\n__CR_END__\n__CR_MANAGER__\n{manager}\nnot json\n__CR_END__\n__CR_ALERT__\n{alert}\n__CR_END__\n"
        ));
        let page = parse_boot_replay_page(&text, &"a".repeat(32)).unwrap();
        assert_eq!(page.earliest_monotonic_us, Some(120));
        assert_eq!(page.latest_monotonic_us, Some(98765));
        // A malformed line is skipped without dropping readable evidence.
        assert_eq!(page.manager_events.len(), 1);
        assert_eq!(page.manager_events[0].id, "m1");
        assert_eq!(page.manager_events[0].source.as_deref(), Some("systemd"));
        assert!(
            page.alert_events
                .iter()
                .any(|entry| entry.message.contains("link is not ready"))
        );
        assert!(!page.permission_required);
        assert!(!page.errors.is_empty());
        assert!(!page.manager_truncated);
        assert!(!page.alert_truncated);
        assert_eq!(page.manager_next_cursor, None);
    }

    #[test]
    fn keeps_partial_coverage_bounds_separate() {
        // Only the newest-entry read worked; the boot's start stays unknown
        // instead of borrowing the latest entry as its earliest bound.
        let latest = journal_entry("c2", "latest", "98765");
        let text = probe_page(&format!(
            "__CR_COVERAGE__\nL {latest}\n__CR_END__\n__CR_MANAGER__\n__CR_END__\n__CR_ALERT__\n__CR_END__\n"
        ));
        let page = parse_boot_replay_page(&text, &"c".repeat(32)).unwrap();
        assert_eq!(page.earliest_monotonic_us, None);
        assert_eq!(page.latest_monotonic_us, Some(98765));
    }

    #[test]
    fn decodes_binary_journal_messages_and_missing_fields() {
        let binary = r#"{"__REALTIME_TIMESTAMP":"1730000000000000","__MONOTONIC_TIMESTAMP":"700","PRIORITY":3,"_SYSTEMD_UNIT":"nginx.service","MESSAGE":[104,101,108,108,111]}"#;
        let text = probe_page(&format!(
            "__CR_COVERAGE__\n__CR_END__\n__CR_MANAGER__\n__CR_END__\n__CR_ALERT__\n{binary}\n__CR_END__\n"
        ));
        let page = parse_boot_replay_page(&text, &"b".repeat(32)).unwrap();
        let entry = &page.alert_events[0];
        assert_eq!(entry.message, "hello");
        assert_eq!(entry.unit.as_deref(), Some("nginx.service"));
        assert_eq!(entry.priority, Some(3));
        // No journal cursor: identity falls back to deterministic derivation.
        assert!(entry.id.starts_with("derived-"));
        // Coverage printed nothing, so it is unknown rather than zero.
        assert_eq!(page.earliest_monotonic_us, None);
        assert_eq!(page.latest_monotonic_us, None);
    }

    #[test]
    fn marks_truncation_with_the_cursor_of_the_last_kept_event() {
        let mut alert_lines = String::new();
        for index in 0..=PAGE_EVENT_LIMIT {
            alert_lines.push_str(&journal_entry(
                &format!("a{index}"),
                &format!("warning {index}"),
                &(index * 10).to_string(),
            ));
            alert_lines.push('\n');
        }
        let text = probe_page(&format!(
            "__CR_COVERAGE__\n__CR_END__\n__CR_MANAGER__\n__CR_END__\n__CR_ALERT__\n{alert_lines}__CR_END__\n"
        ));
        let page = parse_boot_replay_page(&text, &"b".repeat(32)).unwrap();
        assert!(page.alert_truncated);
        assert_eq!(page.alert_events.len(), PAGE_EVENT_LIMIT);
        assert_eq!(
            page.alert_next_cursor.as_deref(),
            Some(format!("a{}", PAGE_EVENT_LIMIT - 1).as_str())
        );
        // The manager stream was present but empty: not an error.
        assert!(!page.manager_truncated);
        assert_eq!(page.manager_next_cursor, None);
    }

    #[test]
    fn reports_permission_as_an_empty_page_and_failures_as_errors() {
        let page = parse_boot_replay_page(
            "__CR_PROBE__\n__CR_PERMISSION__\tBoot journal requires permission\n__CR_END__\n",
            &"a".repeat(32),
        )
        .unwrap();
        assert!(page.permission_required);
        assert!(page.manager_events.is_empty());
        assert!(page.errors[0].contains("requires permission"));

        let error = parse_boot_replay_page(
            "__CR_PROBE__\n__CR_ERROR__\tjournalctl is not installed\n__CR_END__\n",
            &"a".repeat(32),
        )
        .unwrap_err();
        assert!(error.contains("journalctl is not installed"));

        let missing = parse_boot_replay_page("unexpected output", &"a".repeat(32)).unwrap_err();
        assert!(missing.contains("probe"));
    }

    #[test]
    fn caps_message_length_and_strips_control_characters() {
        assert_eq!(bounded_replay_text("abc\u{1}def", 100), "abcdef");
        let long = "x".repeat(1000);
        assert_eq!(
            bounded_replay_text(&long, MAX_MESSAGE_CHARS)
                .chars()
                .count(),
            MAX_MESSAGE_CHARS
        );
    }
}
