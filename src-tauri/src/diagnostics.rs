use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use chrono::Utc;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::{
    models::{ListeningSocket, SavedConnection},
    remote::{self, RemoteCommandExecutor},
    ssh::validate_systemd_unit_id,
};

pub const KIND_STATE: &str = "state";
pub const KIND_JOURNAL: &str = "journal";
pub const KIND_DEPENDENCIES: &str = "dependencies";
pub const KIND_LISTENERS: &str = "listeners";

pub const STATUS_COLLECTED: &str = "collected";
pub const STATUS_PARTIAL: &str = "partial";
pub const STATUS_NOT_APPLICABLE: &str = "notApplicable";

pub const CANCELLED_MESSAGE: &str = "Section collection was cancelled.";

pub const JOURNAL_LINE_OPTIONS: [u16; 4] = [50, 100, 200, 500];
pub const DEFAULT_JOURNAL_LINES: u16 = 200;

/// One level of dependencies only, and never more names than this. A dependency
/// list on a busy host can run to hundreds of units; resolving all of them would
/// turn one section into an unbounded fan-out.
pub const MAX_DEPENDENCY_UNITS: usize = 40;
const MAX_JOURNAL_LINE_CHARS: usize = 2000;
const NO_JOURNAL_ENTRIES_MARKER: &str = "-- No entries --";

/// Suffixes systemd itself defines. Wider than the set Control Room accepts as
/// an inspection subject, because a service legitimately depends on targets,
/// slices, devices, and paths that the app never inspects on their own.
const DEPENDENCY_UNIT_SUFFIXES: [&str; 11] = [
    ".service",
    ".socket",
    ".timer",
    ".mount",
    ".automount",
    ".target",
    ".path",
    ".slice",
    ".scope",
    ".device",
    ".swap",
];

const STATE_PROPERTIES: &str = concat!(
    "Id,Description,LoadState,ActiveState,SubState,UnitFileState,Result,",
    "MainPID,ExecMainPID,ExecMainStatus,ExecMainCode,NRestarts,",
    "ConditionResult,AssertResult,LoadError,FragmentPath,",
    "StateChangeTimestamp,ActiveEnterTimestamp,InactiveEnterTimestamp,",
    "Type,RemainAfterExit"
);

const DEPENDENCY_PROPERTIES: &str = "Requires,Wants,After,PartOf,BoundBy";
const DEPENDENCY_STATE_PROPERTIES: &str = "Id,LoadState,ActiveState,SubState";

/// Section notes live as named constants so a test can read every one of them
/// without scanning source text.
const NOTE_UNIT_NOT_LOADED: &str = "systemd does not have a unit by this name loaded.";
const NOTE_JOURNAL_EMPTY: &str =
    "The journal returned no entries for this unit. Entries may have been rotated away.";
const NOTE_DEPENDENCIES_ONE_LEVEL: &str = "One level of dependencies. Control Room does not follow them further or read causality from the order.";
const NOTE_LISTENERS_INCOMPLETE: &str = "No listener was attributed to this unit. Some listeners on the host had no unambiguous owner, so this is not proof that none exists.";
const NOTE_LISTENERS_NONE: &str = "No listening socket on this host was attributed to this unit.";
const NOTE_NOT_APPLICABLE: &str = "This section does not apply to this unit type.";

fn note_journal_bounded(lines: u16) -> String {
    format!("Showing the last {lines} entries. Older entries were not read.")
}

fn note_dependencies_truncated(resolved_units: usize, named_units: usize) -> String {
    format!(
        "One level of dependencies, with states read for the first {resolved_units} of {named_units} named units."
    )
}

const RELATION_KINDS: [(&str, &str); 5] = [
    ("Requires", "requires"),
    ("Wants", "wants"),
    ("After", "after"),
    ("PartOf", "partOf"),
    ("BoundBy", "boundBy"),
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDiagnosticRequest {
    pub connection_id: String,
    pub unit: String,
    pub kind: String,
    pub operation_id: String,
    #[serde(default)]
    pub journal_lines: Option<u16>,
    #[serde(default)]
    pub sudo_password: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDiagnosticSection {
    pub unit: String,
    pub kind: String,
    pub status: String,
    /// Where the facts came from, in words. Never a shell command.
    pub source: String,
    pub collected_at: String,
    pub note: Option<String>,
    pub state: Option<UnitStateFacts>,
    pub journal: Option<JournalExcerpt>,
    pub dependencies: Option<DependencyFacts>,
    pub listeners: Option<ListenerEvidence>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct UnitStateFacts {
    pub id: String,
    pub known: bool,
    pub description: Option<String>,
    pub load_state: Option<String>,
    pub active_state: Option<String>,
    pub sub_state: Option<String>,
    pub unit_file_state: Option<String>,
    pub unit_type: Option<String>,
    pub remain_after_exit: Option<bool>,
    pub result: Option<String>,
    pub main_pid: Option<u32>,
    pub exec_main_pid: Option<u32>,
    pub exec_main_status: Option<i32>,
    pub exec_main_code: Option<String>,
    pub restart_count: Option<u32>,
    pub condition_result: Option<bool>,
    pub assert_result: Option<bool>,
    pub load_error: Option<String>,
    pub fragment_path: Option<String>,
    pub state_change_timestamp: Option<String>,
    pub active_enter_timestamp: Option<String>,
    pub inactive_enter_timestamp: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JournalExcerpt {
    pub lines: Vec<String>,
    pub requested_lines: u16,
    /// True when the host returned as many lines as were asked for, so older
    /// entries exist beyond this excerpt.
    pub reached_requested_lines: bool,
    pub empty: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DependencyFacts {
    pub relations: Vec<DependencyRelation>,
    pub named_units: usize,
    pub resolved_units: usize,
    pub truncated: bool,
    pub states_resolved: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DependencyRelation {
    pub kind: String,
    pub units: Vec<DependencyUnit>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DependencyUnit {
    pub id: String,
    pub load_state: Option<String>,
    pub active_state: Option<String>,
    pub sub_state: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListenerEvidence {
    pub sockets: Vec<ListeningSocket>,
    pub total_listeners: usize,
    /// False when at least one listener on the host had no unambiguous owning
    /// unit. An empty match is then absence of evidence, not evidence of
    /// absence.
    pub ownership_complete: bool,
}

/// Cancel flags keyed by the operation id React sends with a section request.
#[derive(Default)]
pub struct DiagnosticCancellations {
    flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl DiagnosticCancellations {
    fn register(&self, operation_id: &str) -> Arc<AtomicBool> {
        let mut flags = self.flags.lock();
        // Reuses an existing flag for the same id. A cancel that lands before
        // the run reaches this point still takes effect instead of being lost.
        flags
            .entry(operation_id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    fn release(&self, operation_id: &str) {
        self.flags.lock().remove(operation_id);
    }

    pub fn cancel(&self, operation_id: &str) {
        let mut flags = self.flags.lock();
        flags
            .entry(operation_id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .store(true, Ordering::SeqCst);
    }
}

/// Which sections carry facts for this unit type. A timer has no listening
/// socket of its own, so the section is reported as not applicable rather than
/// collected and empty.
pub fn applicable_sections(unit: &str) -> Vec<&'static str> {
    if unit.ends_with(".service") || unit.ends_with(".socket") {
        return vec![KIND_STATE, KIND_JOURNAL, KIND_DEPENDENCIES, KIND_LISTENERS];
    }
    vec![KIND_STATE, KIND_JOURNAL, KIND_DEPENDENCIES]
}

pub fn journal_lines(requested: Option<u16>) -> u16 {
    match requested {
        Some(value) if JOURNAL_LINE_OPTIONS.contains(&value) => value,
        _ => DEFAULT_JOURNAL_LINES,
    }
}

pub fn state_command(unit: &str) -> String {
    format!("env LC_ALL=C systemctl show --no-pager --property={STATE_PROPERTIES} -- '{unit}'")
}

pub fn journal_command(unit: &str, lines: u16) -> String {
    format!(
        "env LC_ALL=C journalctl --no-pager --quiet --output=short-iso-precise --lines={lines} --unit='{unit}'"
    )
}

pub fn dependency_command(unit: &str) -> String {
    format!("env LC_ALL=C systemctl show --no-pager --property={DEPENDENCY_PROPERTIES} -- '{unit}'")
}

pub fn dependency_state_command(units: &[String]) -> String {
    let quoted = units
        .iter()
        .map(|unit| format!("'{unit}'"))
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        "env LC_ALL=C systemctl show --no-pager --property={DEPENDENCY_STATE_PROPERTIES} -- {quoted}"
    )
}

/// Character rules match `ssh::validate_systemd_unit_id`; only the accepted
/// suffixes differ. A name the host reports that fails this check is dropped
/// instead of being interpolated into a command.
pub fn validate_dependency_unit(value: &str) -> Option<&str> {
    if value.is_empty() || value.len() > 255 {
        return None;
    }
    if !DEPENDENCY_UNIT_SUFFIXES
        .iter()
        .any(|suffix| value.ends_with(suffix))
    {
        return None;
    }
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if byte == b'\\' {
            if index + 3 >= bytes.len()
                || bytes[index + 1] != b'x'
                || !bytes[index + 2].is_ascii_hexdigit()
                || !bytes[index + 3].is_ascii_hexdigit()
            {
                return None;
            }
            index += 4;
            continue;
        }
        if !(byte.is_ascii_alphanumeric() || b"@_.:-".contains(&byte)) {
            return None;
        }
        index += 1;
    }
    Some(value)
}

pub fn collect_section(
    connection: &SavedConnection,
    request: &ServiceDiagnosticRequest,
    cancellations: &DiagnosticCancellations,
) -> Result<ServiceDiagnosticSection, String> {
    let unit = validate_systemd_unit_id(&request.unit)?.to_string();
    let kind = request.kind.as_str();
    if !applicable_sections(&unit).contains(&kind) {
        return Ok(not_applicable(&unit, kind));
    }

    let cancelled = cancellations.register(&request.operation_id);
    let outcome = run_section(connection, &unit, request, &cancelled);
    cancellations.release(&request.operation_id);
    outcome
}

fn run_section(
    connection: &SavedConnection,
    unit: &str,
    request: &ServiceDiagnosticRequest,
    cancelled: &AtomicBool,
) -> Result<ServiceDiagnosticSection, String> {
    if cancelled.load(Ordering::SeqCst) {
        return Err(CANCELLED_MESSAGE.into());
    }
    let section = match request.kind.as_str() {
        KIND_STATE => collect_state(connection, unit, request.sudo_password.clone())?,
        KIND_JOURNAL => collect_journal(
            connection,
            unit,
            journal_lines(request.journal_lines),
            request.sudo_password.clone(),
        )?,
        KIND_DEPENDENCIES => {
            collect_dependencies(connection, unit, request.sudo_password.clone(), cancelled)?
        }
        KIND_LISTENERS => collect_listeners(connection, unit, request.sudo_password.clone())?,
        other => return Err(format!("Unknown diagnostic section: {other}")),
    };
    if cancelled.load(Ordering::SeqCst) {
        return Err(CANCELLED_MESSAGE.into());
    }
    Ok(section)
}

fn run_remote(
    connection: &SavedConnection,
    operation: &'static str,
    command: &str,
    sudo_password: Option<String>,
) -> Result<String, String> {
    let output = match sudo_password {
        Some(password) => {
            RemoteCommandExecutor::execute_with_sudo(connection, operation, command, password)?
        }
        None => RemoteCommandExecutor::execute(connection, operation, command)?,
    };
    output.success_text()
}

fn collect_state(
    connection: &SavedConnection,
    unit: &str,
    sudo_password: Option<String>,
) -> Result<ServiceDiagnosticSection, String> {
    let text = run_remote(
        connection,
        "service_diagnostic_state",
        &state_command(unit),
        sudo_password,
    )?;
    let state = parse_state(unit, &text);
    let note = if state.known {
        None
    } else {
        Some(NOTE_UNIT_NOT_LOADED.into())
    };
    Ok(ServiceDiagnosticSection {
        unit: unit.into(),
        kind: KIND_STATE.into(),
        status: STATUS_COLLECTED.into(),
        source: "systemd unit properties".into(),
        collected_at: Utc::now().to_rfc3339(),
        note,
        state: Some(state),
        journal: None,
        dependencies: None,
        listeners: None,
    })
}

fn collect_journal(
    connection: &SavedConnection,
    unit: &str,
    lines: u16,
    sudo_password: Option<String>,
) -> Result<ServiceDiagnosticSection, String> {
    let text = run_remote(
        connection,
        "service_diagnostic_journal",
        &journal_command(unit, lines),
        sudo_password,
    )?;
    let journal = parse_journal(&text, lines);
    let note = if journal.empty {
        Some(NOTE_JOURNAL_EMPTY.into())
    } else if journal.reached_requested_lines {
        Some(note_journal_bounded(lines))
    } else {
        None
    };
    Ok(ServiceDiagnosticSection {
        unit: unit.into(),
        kind: KIND_JOURNAL.into(),
        status: STATUS_COLLECTED.into(),
        source: format!("journald, last {lines} entries for this unit"),
        collected_at: Utc::now().to_rfc3339(),
        note,
        state: None,
        journal: Some(journal),
        dependencies: None,
        listeners: None,
    })
}

fn collect_dependencies(
    connection: &SavedConnection,
    unit: &str,
    sudo_password: Option<String>,
    cancelled: &AtomicBool,
) -> Result<ServiceDiagnosticSection, String> {
    let text = run_remote(
        connection,
        "service_diagnostic_dependencies",
        &dependency_command(unit),
        sudo_password.clone(),
    )?;
    let (mut relations, named_units) = parse_dependency_relations(&text);
    let selected = dependency_selection(&relations);
    let truncated = named_units > selected.len();

    let mut states_resolved = false;
    if !selected.is_empty() {
        if cancelled.load(Ordering::SeqCst) {
            return Err(CANCELLED_MESSAGE.into());
        }
        let resolved = run_remote(
            connection,
            "service_diagnostic_dependency_states",
            &dependency_state_command(&selected),
            sudo_password,
        )?;
        let states = parse_dependency_states(&resolved);
        apply_dependency_states(&mut relations, &states);
        states_resolved = true;
    }

    let resolved_units = selected.len();
    let note = if truncated {
        Some(note_dependencies_truncated(resolved_units, named_units))
    } else {
        Some(NOTE_DEPENDENCIES_ONE_LEVEL.into())
    };
    Ok(ServiceDiagnosticSection {
        unit: unit.into(),
        kind: KIND_DEPENDENCIES.into(),
        status: if truncated {
            STATUS_PARTIAL.into()
        } else {
            STATUS_COLLECTED.into()
        },
        source: "systemd dependency properties".into(),
        collected_at: Utc::now().to_rfc3339(),
        note,
        state: None,
        journal: None,
        dependencies: Some(DependencyFacts {
            relations,
            named_units,
            resolved_units,
            truncated,
            states_resolved,
        }),
        listeners: None,
    })
}

fn collect_listeners(
    connection: &SavedConnection,
    unit: &str,
    sudo_password: Option<String>,
) -> Result<ServiceDiagnosticSection, String> {
    let sockets = remote::list_ports(connection, sudo_password)?;
    let evidence = listener_evidence(unit, sockets);
    let note = if evidence.sockets.is_empty() && !evidence.ownership_complete {
        Some(NOTE_LISTENERS_INCOMPLETE.into())
    } else if evidence.sockets.is_empty() {
        Some(NOTE_LISTENERS_NONE.into())
    } else {
        None
    };
    Ok(ServiceDiagnosticSection {
        unit: unit.into(),
        kind: KIND_LISTENERS.into(),
        status: if evidence.ownership_complete {
            STATUS_COLLECTED.into()
        } else {
            STATUS_PARTIAL.into()
        },
        source: "kernel listener snapshot correlated to systemd units".into(),
        collected_at: Utc::now().to_rfc3339(),
        note,
        state: None,
        journal: None,
        dependencies: None,
        listeners: Some(evidence),
    })
}

fn not_applicable(unit: &str, kind: &str) -> ServiceDiagnosticSection {
    ServiceDiagnosticSection {
        unit: unit.into(),
        kind: kind.into(),
        status: STATUS_NOT_APPLICABLE.into(),
        source: "not collected".into(),
        collected_at: Utc::now().to_rfc3339(),
        note: Some(NOTE_NOT_APPLICABLE.into()),
        state: None,
        journal: None,
        dependencies: None,
        listeners: None,
    }
}

pub fn listener_evidence(unit: &str, sockets: Vec<ListeningSocket>) -> ListenerEvidence {
    let total_listeners = sockets.len();
    let ownership_complete = sockets
        .iter()
        .all(|socket| socket.ownership == "known" || socket.systemd_unit.is_some());
    let matched = sockets
        .into_iter()
        .filter(|socket| socket.systemd_unit.as_deref() == Some(unit))
        .collect();
    ListenerEvidence {
        sockets: matched,
        total_listeners,
        ownership_complete,
    }
}

fn property_map(block: &str) -> HashMap<String, String> {
    block
        .lines()
        .filter_map(|line| line.split_once('='))
        .map(|(key, value)| (key.trim().to_string(), value.trim().to_string()))
        .collect()
}

fn text_value(values: &HashMap<String, String>, key: &str) -> Option<String> {
    values
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty() && *value != "n/a")
        .map(str::to_string)
}

fn yes_no(values: &HashMap<String, String>, key: &str) -> Option<bool> {
    match values.get(key).map(String::as_str) {
        Some("yes") => Some(true),
        Some("no") => Some(false),
        _ => None,
    }
}

fn number<T: std::str::FromStr>(values: &HashMap<String, String>, key: &str) -> Option<T> {
    values.get(key).and_then(|value| value.trim().parse().ok())
}

fn exec_main_code(values: &HashMap<String, String>) -> Option<String> {
    let raw: i32 = number(values, "ExecMainCode")?;
    match raw {
        0 => None,
        1 => Some("exited".into()),
        2 => Some("killed by signal".into()),
        3 => Some("killed by signal, core dumped".into()),
        other => Some(other.to_string()),
    }
}

pub fn parse_state(unit: &str, text: &str) -> UnitStateFacts {
    let values = property_map(text);
    let load_state = text_value(&values, "LoadState");
    UnitStateFacts {
        id: text_value(&values, "Id").unwrap_or_else(|| unit.to_string()),
        known: load_state
            .as_deref()
            .is_some_and(|state| state != "not-found"),
        description: text_value(&values, "Description"),
        load_state,
        active_state: text_value(&values, "ActiveState"),
        sub_state: text_value(&values, "SubState"),
        unit_file_state: text_value(&values, "UnitFileState"),
        unit_type: text_value(&values, "Type"),
        remain_after_exit: yes_no(&values, "RemainAfterExit"),
        result: text_value(&values, "Result"),
        main_pid: number::<u32>(&values, "MainPID").filter(|pid| *pid != 0),
        exec_main_pid: number::<u32>(&values, "ExecMainPID").filter(|pid| *pid != 0),
        exec_main_status: number(&values, "ExecMainStatus"),
        exec_main_code: exec_main_code(&values),
        restart_count: number(&values, "NRestarts"),
        condition_result: yes_no(&values, "ConditionResult"),
        assert_result: yes_no(&values, "AssertResult"),
        load_error: text_value(&values, "LoadError").filter(|value| value != "\"\" \"\""),
        fragment_path: text_value(&values, "FragmentPath"),
        state_change_timestamp: text_value(&values, "StateChangeTimestamp"),
        active_enter_timestamp: text_value(&values, "ActiveEnterTimestamp"),
        inactive_enter_timestamp: text_value(&values, "InactiveEnterTimestamp"),
    }
}

fn bounded_line(value: &str) -> String {
    if value.chars().count() <= MAX_JOURNAL_LINE_CHARS {
        return value.to_string();
    }
    let kept: String = value.chars().take(MAX_JOURNAL_LINE_CHARS).collect();
    format!("{kept}…")
}

pub fn parse_journal(text: &str, requested_lines: u16) -> JournalExcerpt {
    let lines: Vec<String> = text
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.is_empty() && *line != NO_JOURNAL_ENTRIES_MARKER)
        .map(bounded_line)
        .collect();
    let reached_requested_lines = lines.len() >= usize::from(requested_lines);
    JournalExcerpt {
        empty: lines.is_empty(),
        reached_requested_lines,
        requested_lines,
        lines,
    }
}

pub fn parse_dependency_relations(text: &str) -> (Vec<DependencyRelation>, usize) {
    let values = property_map(text);
    let mut relations = Vec::new();
    let mut named = 0;
    for (property, kind) in RELATION_KINDS {
        let raw = values.get(property).map(String::as_str).unwrap_or_default();
        let units: Vec<DependencyUnit> = raw
            .split_whitespace()
            .filter_map(validate_dependency_unit)
            .map(|id| DependencyUnit {
                id: id.to_string(),
                load_state: None,
                active_state: None,
                sub_state: None,
            })
            .collect();
        named += units.len();
        if !units.is_empty() {
            relations.push(DependencyRelation {
                kind: kind.into(),
                units,
            });
        }
    }
    (relations, named)
}

/// The first `MAX_DEPENDENCY_UNITS` distinct names in relation order. Distinct,
/// because a unit commonly appears under both Requires and After and should not
/// consume the bound twice.
fn dependency_selection(relations: &[DependencyRelation]) -> Vec<String> {
    let mut selected: Vec<String> = Vec::new();
    for relation in relations {
        for unit in &relation.units {
            if selected.len() >= MAX_DEPENDENCY_UNITS {
                return selected;
            }
            if !selected.contains(&unit.id) {
                selected.push(unit.id.clone());
            }
        }
    }
    selected
}

pub fn parse_dependency_states(text: &str) -> HashMap<String, DependencyUnit> {
    let mut states = HashMap::new();
    for block in text.split("\n\n") {
        let values = property_map(block);
        let Some(id) = text_value(&values, "Id") else {
            continue;
        };
        states.insert(
            id.clone(),
            DependencyUnit {
                id,
                load_state: text_value(&values, "LoadState"),
                active_state: text_value(&values, "ActiveState"),
                sub_state: text_value(&values, "SubState"),
            },
        );
    }
    states
}

fn apply_dependency_states(
    relations: &mut [DependencyRelation],
    states: &HashMap<String, DependencyUnit>,
) {
    for relation in relations.iter_mut() {
        for unit in relation.units.iter_mut() {
            if let Some(state) = states.get(&unit.id) {
                unit.load_state = state.load_state.clone();
                unit.active_state = state.active_state.clone();
                unit.sub_state = state.sub_state.clone();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ListeningSocket;

    fn socket(port: u16, unit: Option<&str>, ownership: &str) -> ListeningSocket {
        ListeningSocket {
            id: format!("tcp-ipv4-0.0.0.0-{port}"),
            protocol: "tcp".into(),
            address_family: "ipv4".into(),
            local_address: "0.0.0.0".into(),
            port,
            process_name: Some("nginx".into()),
            process_id: Some(812),
            systemd_unit: unit.map(str::to_string),
            ownership: ownership.into(),
        }
    }

    #[test]
    fn section_applicability_follows_the_unit_type() {
        assert_eq!(
            applicable_sections("nginx.service"),
            vec![KIND_STATE, KIND_JOURNAL, KIND_DEPENDENCIES, KIND_LISTENERS]
        );
        assert_eq!(
            applicable_sections("sshd.socket"),
            vec![KIND_STATE, KIND_JOURNAL, KIND_DEPENDENCIES, KIND_LISTENERS]
        );
        for unit in ["logrotate.timer", "srv-data.mount"] {
            let sections = applicable_sections(unit);
            assert!(!sections.contains(&KIND_LISTENERS), "{unit}");
            assert_eq!(sections.len(), 3, "{unit}");
        }
    }

    #[test]
    fn an_inapplicable_section_is_reported_without_running_a_command() {
        let section = not_applicable("logrotate.timer", KIND_LISTENERS);
        assert_eq!(section.status, STATUS_NOT_APPLICABLE);
        assert!(section.listeners.is_none());
        assert_eq!(section.source, "not collected");
    }

    #[test]
    fn journal_line_counts_fall_back_to_the_allowlist() {
        assert_eq!(journal_lines(Some(50)), 50);
        assert_eq!(journal_lines(Some(500)), 500);
        assert_eq!(journal_lines(Some(7)), DEFAULT_JOURNAL_LINES);
        assert_eq!(journal_lines(Some(10_000)), DEFAULT_JOURNAL_LINES);
        assert_eq!(journal_lines(None), DEFAULT_JOURNAL_LINES);
    }

    /// Write verbs are checked per whitespace token, not as substrings: the
    /// property list legitimately contains NRestarts.
    fn assert_read_only(command: &str) {
        for forbidden in [
            "start",
            "stop",
            "restart",
            "reload",
            "kill",
            "enable",
            "disable",
            "edit",
            "mask",
            "set-property",
            "daemon-reload",
            "rm",
            "tee",
        ] {
            assert!(
                !command.split_whitespace().any(|token| token == forbidden),
                "{command} runs {forbidden}"
            );
        }
        for metacharacter in [
            ";", "|", "&", ">", "<", "$(", "`", "
",
        ] {
            assert!(
                !command.contains(metacharacter),
                "{command} contains {metacharacter}"
            );
        }
    }

    #[test]
    fn commands_are_read_only_and_quote_the_unit() {
        let state = state_command("nginx.service");
        assert!(state.starts_with("env LC_ALL=C systemctl show "));
        assert!(state.contains("'nginx.service'"));
        let journal = journal_command("nginx.service", 200);
        assert!(journal.starts_with("env LC_ALL=C journalctl "));
        assert!(journal.contains("--lines=200"));
        assert!(journal.contains("--unit='nginx.service'"));
        let dependencies = dependency_command("nginx.service");
        assert!(dependencies.contains("--property=Requires,Wants,After,PartOf,BoundBy"));
        for command in [&state, &journal, &dependencies] {
            assert_read_only(command);
        }
    }

    #[test]
    fn state_collection_leaves_out_environment_and_command_line_properties() {
        let command = state_command("nginx.service");
        for excluded in [
            "Environment",
            "ExecStart",
            "ExecStop",
            "StatusText",
            "DropInPaths",
        ] {
            assert!(!command.contains(excluded), "{command} asks for {excluded}");
        }
    }

    #[test]
    fn dependency_state_command_quotes_every_unit() {
        let command = dependency_state_command(&["a.service".into(), "b.target".into()]);
        assert!(command.ends_with("-- 'a.service' 'b.target'"));
    }

    #[test]
    fn dependency_names_from_the_host_are_validated_before_use() {
        for accepted in [
            "basic.target",
            "system.slice",
            "-.mount",
            "dev-disk-by\\x2duuid.device",
            "sshd@1.service",
        ] {
            assert_eq!(validate_dependency_unit(accepted), Some(accepted));
        }
        for rejected in [
            "",
            "nginx.service; rm -rf /",
            "nginx.service && id",
            "$(id).service",
            "`id`.service",
            "nginx.service'",
            "nginx",
            "nginx.conf",
            "bad\\zz.service",
        ] {
            assert_eq!(validate_dependency_unit(rejected), None, "{rejected}");
        }
    }

    #[test]
    fn a_failed_service_parses_into_exit_facts() {
        let text = "Id=nginx.service\nDescription=A high performance web server\nLoadState=loaded\nActiveState=failed\nSubState=failed\nUnitFileState=enabled\nResult=exit-code\nMainPID=0\nExecMainPID=812\nExecMainStatus=1\nExecMainCode=1\nNRestarts=3\nConditionResult=yes\nAssertResult=yes\nLoadError=\nFragmentPath=/lib/systemd/system/nginx.service\nStateChangeTimestamp=Mon 2026-09-01 10:00:00 UTC\nActiveEnterTimestamp=Mon 2026-09-01 09:00:00 UTC\nInactiveEnterTimestamp=Mon 2026-09-01 10:00:00 UTC\nType=forking\nRemainAfterExit=no\n";
        let state = parse_state("nginx.service", text);
        assert!(state.known);
        assert_eq!(state.active_state.as_deref(), Some("failed"));
        assert_eq!(state.result.as_deref(), Some("exit-code"));
        assert_eq!(state.exec_main_status, Some(1));
        assert_eq!(state.exec_main_code.as_deref(), Some("exited"));
        assert_eq!(state.restart_count, Some(3));
        assert_eq!(state.main_pid, None, "MainPID=0 means no live process");
        assert_eq!(state.exec_main_pid, Some(812));
        assert_eq!(state.load_error, None);
        assert_eq!(state.remain_after_exit, Some(false));
    }

    #[test]
    fn an_unknown_unit_is_reported_as_not_loaded() {
        let text = "Id=ghost.service\nLoadState=not-found\nActiveState=inactive\nSubState=dead\nLoadError=org.freedesktop.systemd1.NoSuchUnit \"Unit ghost.service not found.\"\n";
        let state = parse_state("ghost.service", text);
        assert!(!state.known);
        assert!(state.load_error.is_some());
    }

    #[test]
    fn a_healthy_one_shot_unit_keeps_its_inactive_state_without_a_failure_verdict() {
        let text = "Id=setup.service\nLoadState=loaded\nActiveState=inactive\nSubState=dead\nResult=success\nExecMainStatus=0\nExecMainCode=1\nType=oneshot\nRemainAfterExit=no\nNRestarts=0\n";
        let state = parse_state("setup.service", text);
        assert!(state.known);
        assert_eq!(state.active_state.as_deref(), Some("inactive"));
        assert_eq!(state.result.as_deref(), Some("success"));
        assert_eq!(state.unit_type.as_deref(), Some("oneshot"));
        assert_eq!(state.exec_main_status, Some(0));
    }

    #[test]
    fn missing_properties_stay_absent_instead_of_becoming_defaults() {
        let state = parse_state("nginx.service", "LoadState=loaded\n");
        assert_eq!(state.id, "nginx.service");
        assert_eq!(state.active_state, None);
        assert_eq!(state.restart_count, None);
        assert_eq!(state.condition_result, None);
        assert_eq!(state.exec_main_code, None);
    }

    #[test]
    fn timestamps_that_read_n_a_are_treated_as_absent() {
        let state = parse_state(
            "nginx.service",
            "LoadState=loaded\nActiveEnterTimestamp=n/a\nStateChangeTimestamp=\n",
        );
        assert_eq!(state.active_enter_timestamp, None);
        assert_eq!(state.state_change_timestamp, None);
    }

    #[test]
    fn journal_parsing_drops_the_no_entries_marker() {
        let excerpt = parse_journal("-- No entries --\n", 200);
        assert!(excerpt.empty);
        assert!(excerpt.lines.is_empty());
        assert!(!excerpt.reached_requested_lines);
    }

    #[test]
    fn journal_parsing_reports_when_the_excerpt_filled_the_bound() {
        let text = (0..50)
            .map(|index| {
                format!(
                    "2026-09-01T10:00:0{}.000000+0000 web nginx[812]: line",
                    index % 10
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        let excerpt = parse_journal(&text, 50);
        assert_eq!(excerpt.lines.len(), 50);
        assert!(excerpt.reached_requested_lines);
        assert!(!excerpt.empty);
        let short = parse_journal(&text, 500);
        assert!(!short.reached_requested_lines);
    }

    #[test]
    fn a_very_long_journal_line_is_bounded() {
        let line = "x".repeat(MAX_JOURNAL_LINE_CHARS + 500);
        let excerpt = parse_journal(&line, 50);
        assert_eq!(excerpt.lines[0].chars().count(), MAX_JOURNAL_LINE_CHARS + 1);
        assert!(excerpt.lines[0].ends_with('…'));
    }

    #[test]
    fn dependency_relations_keep_their_kind_and_drop_unusable_names() {
        let text = "Requires=system.slice sysinit.target\nWants=network-online.target\nAfter=network.target nonsense\nPartOf=\nBoundBy=\n";
        let (relations, named) = parse_dependency_relations(text);
        assert_eq!(named, 4, "the unparsable name is dropped");
        assert_eq!(
            relations
                .iter()
                .map(|relation| relation.kind.as_str())
                .collect::<Vec<_>>(),
            vec!["requires", "wants", "after"]
        );
        assert_eq!(relations[0].units.len(), 2);
        assert!(
            relations[0]
                .units
                .iter()
                .all(|unit| unit.active_state.is_none())
        );
    }

    #[test]
    fn the_dependency_selection_is_distinct_and_bounded() {
        let mut units: Vec<DependencyUnit> = (0..MAX_DEPENDENCY_UNITS + 10)
            .map(|index| DependencyUnit {
                id: format!("unit-{index}.service"),
                load_state: None,
                active_state: None,
                sub_state: None,
            })
            .collect();
        units.push(units[0].clone());
        let relations = vec![DependencyRelation {
            kind: "after".into(),
            units,
        }];
        let selected = dependency_selection(&relations);
        assert_eq!(selected.len(), MAX_DEPENDENCY_UNITS);
        let mut sorted = selected.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), MAX_DEPENDENCY_UNITS);
    }

    #[test]
    fn dependency_states_are_matched_back_onto_the_named_units() {
        let (mut relations, _) = parse_dependency_relations("Requires=a.service\nAfter=b.target\n");
        let states = parse_dependency_states(
            "Id=a.service\nLoadState=loaded\nActiveState=active\nSubState=running\n\nId=b.target\nLoadState=loaded\nActiveState=inactive\nSubState=dead\n",
        );
        apply_dependency_states(&mut relations, &states);
        assert_eq!(
            relations[0].units[0].active_state.as_deref(),
            Some("active")
        );
        assert_eq!(relations[1].units[0].sub_state.as_deref(), Some("dead"));
    }

    #[test]
    fn a_dependency_the_host_did_not_report_on_keeps_an_unresolved_state() {
        let (mut relations, _) = parse_dependency_relations("Requires=a.service b.service\n");
        let states = parse_dependency_states("Id=a.service\nActiveState=active\n");
        apply_dependency_states(&mut relations, &states);
        assert_eq!(relations[0].units[1].active_state, None);
    }

    #[test]
    fn listener_evidence_matches_only_the_selected_unit() {
        let evidence = listener_evidence(
            "nginx.service",
            vec![
                socket(80, Some("nginx.service"), "known"),
                socket(443, Some("nginx.service"), "known"),
                socket(22, Some("ssh.service"), "known"),
            ],
        );
        assert_eq!(evidence.sockets.len(), 2);
        assert_eq!(evidence.total_listeners, 3);
        assert!(evidence.ownership_complete);
    }

    #[test]
    fn an_empty_match_with_unknown_owners_is_not_reported_as_complete() {
        let evidence = listener_evidence(
            "nginx.service",
            vec![
                socket(80, None, "unavailable"),
                socket(22, None, "ambiguous"),
            ],
        );
        assert!(evidence.sockets.is_empty());
        assert!(!evidence.ownership_complete);
    }

    #[test]
    fn a_cancel_that_lands_before_the_run_still_takes_effect() {
        let cancellations = DiagnosticCancellations::default();
        cancellations.cancel("operation-1");
        let flag = cancellations.register("operation-1");
        assert!(flag.load(Ordering::SeqCst));
        cancellations.release("operation-1");
        assert!(!cancellations.register("operation-1").load(Ordering::SeqCst));
    }

    #[test]
    fn no_section_note_claims_a_cause_or_a_remedy() {
        let notes = [
            NOTE_UNIT_NOT_LOADED.to_string(),
            NOTE_JOURNAL_EMPTY.to_string(),
            NOTE_DEPENDENCIES_ONE_LEVEL.to_string(),
            NOTE_LISTENERS_INCOMPLETE.to_string(),
            NOTE_LISTENERS_NONE.to_string(),
            NOTE_NOT_APPLICABLE.to_string(),
            note_journal_bounded(200),
            note_dependencies_truncated(40, 61),
        ];
        for note in notes {
            let lower = note.to_ascii_lowercase();
            for forbidden in [
                "caused by",
                "root cause",
                "you should",
                "try restarting",
                "to fix",
                "likely",
                "probably",
            ] {
                assert!(!lower.contains(forbidden), "{note} claims {forbidden}");
            }
        }
    }

    #[test]
    fn every_note_constant_is_used_by_a_collector() {
        let source = include_str!("diagnostics.rs");
        let collectors = &source[..source.find("mod tests").expect("tests module exists")];
        for name in [
            "NOTE_UNIT_NOT_LOADED",
            "NOTE_JOURNAL_EMPTY",
            "NOTE_DEPENDENCIES_ONE_LEVEL",
            "NOTE_LISTENERS_INCOMPLETE",
            "NOTE_LISTENERS_NONE",
            "NOTE_NOT_APPLICABLE",
        ] {
            assert_eq!(
                collectors.matches(name).count(),
                2,
                "{name} should be declared once and used once"
            );
        }
    }
}
