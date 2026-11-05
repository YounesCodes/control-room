//! Bounded journald reads that reconstruct one boot's retained evidence as
//! replayable events. Everything here is read-only: the host is never asked
//! to reboot, toggle services, or write anything. The reader asks for two
//! capped streams — systemd's own manager messages (milestones and unit
//! lifecycle) and the warning-and-above filter — plus two one-entry reads
//! that bound the boot's journal coverage. Pages continue through journal
//! cursors, and every output is bounded before it leaves the remote shell.

use chrono::Utc;
use serde_json::Value;

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

pub fn collect_boot_replay(
    connection: &SavedConnection,
    boot_id: &str,
    manager_cursor: Option<&str>,
    alert_cursor: Option<&str>,
    elevation: &Elevation,
) -> Result<BootReplayPage, String> {
    let boot_id = boot_id.to_ascii_lowercase();
    validate_boot_id(&boot_id)?;
    let manager_cursor = normalized_cursor(manager_cursor)?;
    let alert_cursor = normalized_cursor(alert_cursor)?;
    let command = boot_replay_command(&boot_id, manager_cursor, alert_cursor);
    let output = RemoteCommandExecutor::execute_elevated(
        connection,
        "collect_boot_replay",
        &command,
        elevation,
    )?;
    let text = output.success_text()?;
    parse_boot_replay_page(&text, &boot_id)
}

/// Journal cursors are opaque host values, so the accepted character set is
/// narrow on purpose: everything `journalctl --cursor`/`--after-cursor` emit
/// and nothing that could reinterpret the surrounding shell.
fn normalized_cursor(cursor: Option<&str>) -> Result<Option<&str>, String> {
    let Some(cursor) = cursor else { return Ok(None) };
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
journal_ok=false
if ! command -v journalctl >/dev/null 2>&1; then printf '__CR_ERROR__\tjournalctl is not installed\n'
elif journalctl --boot "$boot_selector" -n 1 --no-pager --quiet >/dev/null 2>&1; then journal_ok=true; printf '__CR_OK__\n'
else
  journal_error=$(journalctl --boot "$boot_selector" -n 1 --no-pager --quiet 2>&1 >/dev/null)
  if printf '%s' "$journal_error" | grep -Eqi 'permission denied|not permitted'; then printf '__CR_PERMISSION__\tBoot journal requires permission\n'
  else printf '__CR_ERROR__\tBoot journal is unavailable\n'; fi
fi
printf '__CR_END__\n'
if test "$journal_ok" != true; then exit 0; fi
printf '__CR_COVERAGE__\n'
earliest_entry=$(journalctl --boot "$boot_selector" --output=json --no-pager --quiet 2>/dev/null | head -n 1)
if test -n "$earliest_entry"; then printf 'E %s\n' "$earliest_entry"; fi
latest_entry=$(journalctl --boot "$boot_selector" -n 1 --output=json --no-pager --quiet 2>/dev/null)
if test -n "$latest_entry"; then printf 'L %s\n' "$latest_entry"; fi
printf '__CR_END__\n'
printf '__CR_MANAGER__\n'
if test -n "$manager_cursor"; then journalctl --boot "$boot_selector" --after-cursor "$manager_cursor" _PID=1 --output=json --no-pager --quiet 2>/dev/null | head -n {MANAGER_STREAM_LIMIT}
else journalctl --boot "$boot_selector" _PID=1 --output=json --no-pager --quiet 2>/dev/null | head -n {MANAGER_STREAM_LIMIT}; fi
printf '__CR_END__\n'
printf '__CR_ALERT__\n'
if test -n "$alert_cursor"; then journalctl --boot "$boot_selector" --after-cursor "$alert_cursor" --priority=warning --output=json --no-pager --quiet 2>/dev/null | head -n {ALERT_STREAM_LIMIT}
else journalctl --boot "$boot_selector" --priority=warning --output=json --no-pager --quiet 2>/dev/null | head -n {ALERT_STREAM_LIMIT}; fi
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
    if probe.iter().any(|line| *line == "__CR_OK__") {
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
    // Coverage prints one tagged line per bound read, so a host where only
    // one of the two reads worked never has its newest entry mistaken for
    // the oldest.
    let mut earliest = None;
    let mut latest = None;
    match section_lines(text, "__CR_COVERAGE__") {
        Some(lines) => {
            for line in lines {
                let Some((marker, payload)) = line.split_once(' ') else {
                    continue;
                };
                match marker {
                    "E" => earliest = coverage_monotonic(payload),
                    "L" => latest = coverage_monotonic(payload),
                    _ => {}
                }
            }
        }
        None => {
            errors.push("Boot journal coverage was not returned by the host".into());
        }
    }
    let manager = stream_section(text, "__CR_MANAGER__", PAGE_EVENT_LIMIT);
    if manager.missing {
        errors.push("Systemd manager events were not returned by the host".into());
    }
    let alert = stream_section(text, "__CR_ALERT__", PAGE_EVENT_LIMIT);
    if alert.missing {
        errors.push("Warning events were not returned by the host".into());
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
        permission_required: false,
        errors,
    })
}

fn tagged_lines<'a>(lines: &[&'a str], tag: &str) -> Vec<&'a str> {
    lines
        .iter()
        .filter_map(|line| line.strip_prefix(tag).and_then(|rest| rest.strip_prefix('\t')))
        .collect()
}

fn coverage_monotonic(payload: &str) -> Option<u64> {
    serde_json::from_str::<Value>(payload)
        .ok()
        .and_then(|value| json_number(&value, "__MONOTONIC_TIMESTAMP"))
}

struct ReplayStream {
    events: Vec<BootReplayEntry>,
    next_cursor: Option<String>,
    truncated: bool,
    missing: bool,
}

fn stream_section(text: &str, marker: &str, page_limit: usize) -> ReplayStream {
    let Some(lines) = section_lines(text, marker) else {
        return ReplayStream {
            events: Vec::new(),
            next_cursor: None,
            truncated: false,
            missing: true,
        };
    };
    if lines.len() > page_limit {
        let mut events = Vec::with_capacity(page_limit);
        for line in lines.iter().take(page_limit) {
            push_entry(&mut events, line);
        }
        let next_cursor = events.last().map(|entry| entry.id.clone());
        return ReplayStream {
            events,
            next_cursor,
            truncated: true,
            missing: false,
        };
    }
    let mut events = Vec::with_capacity(lines.len());
    for line in &lines {
        push_entry(&mut events, line);
    }
    ReplayStream {
        events,
        next_cursor: None,
        truncated: false,
        missing: false,
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
    let message = bounded_text_value(value.get("MESSAGE")?, MAX_MESSAGE_CHARS)?;
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
        .get("_SYSTEMD_UNIT")
        .or_else(|| value.get("UNIT"))
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
    })
}

/// journalctl's `--output=json` writes printable fields as JSON strings and
/// binary fields as numeric arrays; both are read back as text.
fn bounded_text_value(value: &Value, max_chars: usize) -> Option<String> {
    let text = match value {
        Value::String(text) => text.as_str(),
        Value::Array(items) => {
            let bytes: Vec<u8> = items
                .iter()
                .filter_map(|item| u8::try_from(item.as_u64()?).ok())
                .collect();
            return String::from_utf8(bytes)
                .ok()
                .map(|text| bounded_replay_text(&text, max_chars))
                .filter(|text| !text.is_empty());
        }
        _ => return None,
    }?;
    let bounded = bounded_replay_text(text, max_chars);
    (!bounded.is_empty()).then_some(bounded)
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
        .filter(|character| !character.is_control() || *character == '\t')
        .take(max_chars)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn journal_entry(cursor: &str, message: &str, monotonic: &str) -> String {
        format!(
            r#"{{"__CURSOR":"{cursor}","__REALTIME_TIMESTAMP":"1730000000000000","__MONOTONIC_TIMESTAMP":"{monotonic}","PRIORITY":"6","_COMM":"systemd","MESSAGE":"{message}"}}"#
        )
    }

    fn probe_page(extra_sections: &str) -> String {
        format!("__CR_PROBE__\n__CR_OK__\n__CR_END__\n{extra_sections}")
    }

    #[test]
    fn rejects_invalid_boot_ids_but_normalizes_cursors() {
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
        assert!(script.contains(r#"journalctl --boot "$boot_selector" --after-cursor "$manager_cursor" _PID=1"#));
        assert!(script.contains(r#"journalctl --boot "$boot_selector" --priority=warning"#));
        assert!(script.contains(&format!("head -n {}", PAGE_EVENT_LIMIT + 1)));
        assert!(script.contains("journal_ok=true"));

        let command = boot_replay_command(&"a".repeat(32), Some("s=abc;i=1"), None);
        // The whole script is a single quoted argument: no raw newlines and
        // no way for cursor bytes to break out of the sh -c argument.
        assert!(!command.contains('\n'));
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
        assert!(page
            .alert_events
            .iter()
            .any(|entry| entry.message.contains("link is not ready")));
        assert!(!page.permission_required);
        assert!(page.errors.is_empty());
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
            bounded_replay_text(&long, MAX_MESSAGE_CHARS).chars().count(),
            MAX_MESSAGE_CHARS
        );
    }
}
