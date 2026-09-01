//! Host-to-host diff: collect comparable state from two explicitly chosen
//! Saved Connections at about the same time, then report where they differ.
//!
//! Nothing here decides which host is right, and nothing here changes a host.
//! Collection is explicit, bounded, read-only, and cancellable, and each side
//! records its own per-section status so a section neither side could read is
//! never reported as agreement.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
};

use chrono::{DateTime, Utc};
use parking_lot::Mutex;

use crate::{
    models::{
        HostDiff, HostDiffFact, HostDiffRow, HostDiffSection, HostDiffSide, HostStateEntry,
        HostStateFact, HostStateSection, SavedConnection,
    },
    remote::{self, RemoteOperationLimiter},
};

pub const SECTION_HOST: &str = "host";
pub const SECTION_SYSTEMD_UNITS: &str = "systemdUnits";
pub const SECTION_LISTENERS: &str = "listeners";
pub const SECTION_CONTAINERS: &str = "containers";
pub const SECTION_FILESYSTEMS: &str = "filesystems";

/// The domains in the first comparison, in display order.
pub const SECTION_KINDS: [&str; 5] = [
    SECTION_HOST,
    SECTION_SYSTEMD_UNITS,
    SECTION_LISTENERS,
    SECTION_CONTAINERS,
    SECTION_FILESYSTEMS,
];

pub const STATUS_COLLECTED: &str = "collected";
pub const STATUS_PARTIAL: &str = "partial";
pub const STATUS_UNSUPPORTED: &str = "unsupported";
pub const STATUS_UNAVAILABLE: &str = "unavailable";
/// The run stopped before this section was reached. Distinct from a section
/// that was read and found empty.
pub const STATUS_NOT_COLLECTED: &str = "notCollected";

pub const ROW_EQUAL: &str = "equal";
pub const ROW_DIFFERENT: &str = "different";
pub const ROW_LEFT_ONLY: &str = "leftOnly";
pub const ROW_RIGHT_ONLY: &str = "rightOnly";

#[derive(Default)]
pub struct HostDiffRunRegistry {
    runs: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl HostDiffRunRegistry {
    /// Reuses an existing flag for the same id, so a cancel that lands before
    /// the run registers is honoured rather than lost.
    fn register(&self, run_id: &str) -> Arc<AtomicBool> {
        let mut runs = self.runs.lock();
        if let Some(existing) = runs.get(run_id) {
            return Arc::clone(existing);
        }
        let flag = Arc::new(AtomicBool::new(false));
        runs.insert(run_id.to_string(), Arc::clone(&flag));
        flag
    }

    fn release(&self, run_id: &str) {
        self.runs.lock().remove(run_id);
    }

    pub fn cancel(&self, run_id: &str) -> Result<(), String> {
        match self.runs.lock().get(run_id) {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                Ok(())
            }
            None => Err("That comparison is no longer running".into()),
        }
    }
}

/// Reports one finished section for one host while the run is still going.
pub trait SectionReporter {
    fn report(&self, connection_id: &str, section: &HostStateSection, completed: u32, total: u32);
}

pub fn compare_hosts(
    left: &SavedConnection,
    right: &SavedConnection,
    run_id: &str,
    limiter: &RemoteOperationLimiter,
    registry: &HostDiffRunRegistry,
    reporter: &dyn SectionReporter,
) -> Result<HostDiff, String> {
    if left.id == right.id {
        return Err("Choose two different Saved Connections".into());
    }
    let cancelled = registry.register(run_id);
    let (sender, receiver) = mpsc::channel::<(bool, HostStateSection)>();
    let mut left_sections: Vec<HostStateSection> = Vec::new();
    let mut right_sections: Vec<HostStateSection> = Vec::new();

    // Both hosts are read at the same time, so the two sides describe about the
    // same moment. The skew between them is reported rather than hidden.
    thread::scope(|scope| {
        for (is_left, connection) in [(true, left), (false, right)] {
            let sender = sender.clone();
            let cancelled = cancelled.as_ref();
            scope.spawn(move || {
                for kind in SECTION_KINDS {
                    let section = if cancelled.load(Ordering::SeqCst) {
                        not_collected(kind)
                    } else {
                        collect_section(connection, kind, limiter)
                    };
                    let _ = sender.send((is_left, section));
                }
            });
        }
        drop(sender);
        let total = SECTION_KINDS.len() as u32 * 2;
        let mut completed = 0;
        for (is_left, section) in receiver {
            completed += 1;
            let connection_id = if is_left { &left.id } else { &right.id };
            reporter.report(connection_id, &section, completed, total);
            if is_left {
                left_sections.push(section);
            } else {
                right_sections.push(section);
            }
        }
    });

    registry.release(run_id);
    Ok(build_diff(left, right, &left_sections, &right_sections))
}

fn not_collected(kind: &str) -> HostStateSection {
    HostStateSection {
        kind: kind.into(),
        status: STATUS_NOT_COLLECTED.into(),
        collected_at: None,
        message: Some("The comparison was stopped before this section was read.".into()),
        entries: Vec::new(),
    }
}

fn section(
    kind: &str,
    status: &str,
    message: Option<String>,
    entries: Vec<HostStateEntry>,
) -> HostStateSection {
    HostStateSection {
        kind: kind.into(),
        status: status.into(),
        collected_at: Some(Utc::now().to_rfc3339()),
        message,
        entries,
    }
}

fn collect_section(
    connection: &SavedConnection,
    kind: &str,
    limiter: &RemoteOperationLimiter,
) -> HostStateSection {
    let permit = match limiter.acquire(&connection.id) {
        Ok(permit) => permit,
        Err(error) => return section(kind, STATUS_UNAVAILABLE, Some(error), Vec::new()),
    };
    let collected = match kind {
        SECTION_HOST => host_section(connection),
        SECTION_SYSTEMD_UNITS => systemd_section(connection),
        SECTION_LISTENERS => listener_section(connection),
        SECTION_CONTAINERS => container_section(connection),
        _ => filesystem_section(connection),
    };
    drop(permit);
    collected
}

fn fact(name: &str, value: impl Into<String>) -> HostStateFact {
    HostStateFact {
        name: name.into(),
        value: value.into(),
    }
}

fn unavailable() -> String {
    "unavailable".into()
}

/// The hostname is the entry label, never a compared fact. Two different hosts
/// always have different hostnames, and reporting that as a difference would
/// bury the ones that matter.
fn host_section(connection: &SavedConnection) -> HostStateSection {
    match remote::discover_capabilities(connection) {
        Ok(capabilities) => section(
            SECTION_HOST,
            STATUS_COLLECTED,
            None,
            vec![HostStateEntry {
                identity: "host".into(),
                label: capabilities
                    .hostname
                    .clone()
                    .unwrap_or_else(|| connection.display_name.clone()),
                facts: vec![
                    fact(
                        "operatingSystem",
                        capabilities.os_name.unwrap_or_else(unavailable),
                    ),
                    fact(
                        "osVersion",
                        capabilities.os_version.unwrap_or_else(unavailable),
                    ),
                    fact("kernel", capabilities.kernel.unwrap_or_else(unavailable)),
                    fact(
                        "architecture",
                        capabilities.architecture.unwrap_or_else(unavailable),
                    ),
                ],
            }],
        ),
        Err(error) => section(SECTION_HOST, STATUS_UNAVAILABLE, Some(error), Vec::new()),
    }
}

fn systemd_section(connection: &SavedConnection) -> HostStateSection {
    match remote::list_services(connection) {
        Ok(units) => {
            let entries = units
                .into_iter()
                .map(|unit| HostStateEntry {
                    identity: unit.id.clone(),
                    label: unit.id,
                    facts: vec![
                        fact("loadState", unit.load_state),
                        fact("activeState", unit.active_state),
                        fact("subState", unit.sub_state),
                        fact(
                            "unitFileState",
                            unit.unit_file_state.unwrap_or_else(unavailable),
                        ),
                    ],
                })
                .collect();
            section(SECTION_SYSTEMD_UNITS, STATUS_COLLECTED, None, entries)
        }
        Err(error) => section(
            SECTION_SYSTEMD_UNITS,
            failure_status(&error),
            Some(error),
            Vec::new(),
        ),
    }
}

/// A listener is identified by protocol, address family, and port. The bind
/// address is a compared value, not identity: two hosts serving the same port
/// on their own addresses are the same listener, differing in where it binds.
fn listener_section(connection: &SavedConnection) -> HostStateSection {
    match remote::list_ports(connection, None) {
        Ok(sockets) => {
            let unowned = sockets
                .iter()
                .filter(|socket| socket.ownership != "known")
                .count();
            let mut grouped: BTreeMap<String, (String, BTreeSet<String>, BTreeSet<String>)> =
                BTreeMap::new();
            for socket in sockets {
                let identity = format!(
                    "{}/{}/{}",
                    socket.protocol, socket.address_family, socket.port
                );
                let label = format!("{}/{}", socket.port, socket.protocol);
                let owner = socket
                    .systemd_unit
                    .or(socket.process_name)
                    .unwrap_or_else(unavailable);
                let group = grouped
                    .entry(identity)
                    .or_insert_with(|| (label, BTreeSet::new(), BTreeSet::new()));
                group.1.insert(socket.local_address);
                group.2.insert(owner);
            }
            let entries = grouped
                .into_iter()
                .map(|(identity, (label, addresses, owners))| HostStateEntry {
                    identity,
                    label,
                    facts: vec![
                        fact(
                            "addresses",
                            addresses.into_iter().collect::<Vec<_>>().join(", "),
                        ),
                        fact("owners", owners.into_iter().collect::<Vec<_>>().join(", ")),
                    ],
                })
                .collect();
            let status = if unowned > 0 {
                STATUS_PARTIAL
            } else {
                STATUS_COLLECTED
            };
            let message = (unowned > 0).then(|| {
                format!(
                    "{unowned} listeners have no readable owner. Process details need elevation."
                )
            });
            section(SECTION_LISTENERS, status, message, entries)
        }
        Err(error) => section(
            SECTION_LISTENERS,
            failure_status(&error),
            Some(error),
            Vec::new(),
        ),
    }
}

/// A container is identified by its validated Compose project, service, and
/// instance number when all are present, and by its name otherwise. The image
/// reference is a compared value, never identity, because a mutable tag can
/// point at different content on each host.
fn container_section(connection: &SavedConnection) -> HostStateSection {
    match remote::list_containers(connection, None) {
        Ok(containers) => {
            let entries = containers
                .into_iter()
                .map(|container| {
                    let identity = match (
                        &container.compose_project,
                        &container.compose_service,
                        container.compose_container_number,
                    ) {
                        (Some(project), Some(service), Some(number)) => {
                            format!("compose:{project}/{service}#{number}")
                        }
                        (Some(project), Some(service), None) => {
                            format!("compose:{project}/{service}")
                        }
                        _ => format!("name:{}", container.name),
                    };
                    HostStateEntry {
                        identity,
                        label: container.name,
                        facts: vec![
                            fact("image", container.image),
                            fact("state", container.state),
                        ],
                    }
                })
                .collect();
            section(SECTION_CONTAINERS, STATUS_COLLECTED, None, entries)
        }
        Err(error) => section(
            SECTION_CONTAINERS,
            failure_status(&error),
            Some(error),
            Vec::new(),
        ),
    }
}

fn filesystem_section(connection: &SavedConnection) -> HostStateSection {
    match remote::list_filesystems(connection) {
        Ok(filesystems) => {
            let entries = filesystems
                .into_iter()
                .map(|filesystem| HostStateEntry {
                    identity: filesystem.mount_point.clone(),
                    label: filesystem.mount_point,
                    facts: vec![
                        fact("type", filesystem.filesystem_type),
                        fact("sizeKib", filesystem.size_kib.to_string()),
                        fact("usedPercent", filesystem.used_percent.to_string()),
                    ],
                })
                .collect();
            section(SECTION_FILESYSTEMS, STATUS_COLLECTED, None, entries)
        }
        Err(error) => section(
            SECTION_FILESYSTEMS,
            failure_status(&error),
            Some(error),
            Vec::new(),
        ),
    }
}

/// An absent subsystem and an unreadable one are different answers.
fn failure_status(error: &str) -> &'static str {
    let lower = error.to_ascii_lowercase();
    if lower.contains("is not installed")
        || lower.contains("not found")
        || lower.contains("no df command")
    {
        STATUS_UNSUPPORTED
    } else {
        STATUS_UNAVAILABLE
    }
}

fn build_diff(
    left: &SavedConnection,
    right: &SavedConnection,
    left_sections: &[HostStateSection],
    right_sections: &[HostStateSection],
) -> HostDiff {
    let left_at = latest_collection(left_sections);
    let right_at = latest_collection(right_sections);
    HostDiff {
        left: HostDiffSide {
            connection_id: left.id.clone(),
            connection_name: left.display_name.clone(),
            collected_at: left_at.clone(),
        },
        right: HostDiffSide {
            connection_id: right.id.clone(),
            connection_name: right.display_name.clone(),
            collected_at: right_at.clone(),
        },
        collection_skew_seconds: skew_seconds(left_at.as_deref(), right_at.as_deref()),
        sections: SECTION_KINDS
            .iter()
            .map(|kind| diff_section(kind, left_sections, right_sections))
            .collect(),
    }
}

fn latest_collection(sections: &[HostStateSection]) -> Option<String> {
    sections
        .iter()
        .filter_map(|section| section.collected_at.clone())
        .max()
}

/// The visible time window between the two sides. Callers show it so a stale
/// half of the comparison is obvious.
fn skew_seconds(left: Option<&str>, right: Option<&str>) -> Option<i64> {
    let parse = |value: Option<&str>| {
        value
            .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.with_timezone(&Utc))
    };
    match (parse(left), parse(right)) {
        (Some(left), Some(right)) => Some((left - right).num_seconds().abs()),
        _ => None,
    }
}

fn find<'a>(sections: &'a [HostStateSection], kind: &str) -> Option<&'a HostStateSection> {
    sections.iter().find(|section| section.kind == kind)
}

fn diff_section(
    kind: &str,
    left_sections: &[HostStateSection],
    right_sections: &[HostStateSection],
) -> HostDiffSection {
    let left = find(left_sections, kind);
    let right = find(right_sections, kind);
    let left_status = status_of(left);
    let right_status = status_of(right);
    let readable = |status: &str| status == STATUS_COLLECTED || status == STATUS_PARTIAL;
    if !readable(&left_status) || !readable(&right_status) {
        return HostDiffSection {
            kind: kind.into(),
            note: Some(incomparable_note(&left_status, &right_status)),
            left_status,
            right_status,
            comparable: false,
            rows: Vec::new(),
            equal_count: 0,
            different_count: 0,
        };
    }
    let left_entries = index(left);
    let right_entries = index(right);
    let identities: BTreeSet<&String> = left_entries
        .keys()
        .chain(right_entries.keys())
        .copied()
        .collect();
    let mut rows = Vec::new();
    let mut equal_count = 0;
    let mut different_count = 0;
    for identity in identities {
        let row = diff_row(
            identity,
            left_entries.get(identity).copied(),
            right_entries.get(identity).copied(),
        );
        if row.state == ROW_EQUAL {
            equal_count += 1;
        } else {
            different_count += 1;
        }
        rows.push(row);
    }
    let partial = left_status == STATUS_PARTIAL || right_status == STATUS_PARTIAL;
    HostDiffSection {
        kind: kind.into(),
        left_status,
        right_status,
        comparable: true,
        note: partial.then(|| {
            "One side of this section was partial. The comparison covers only what each host could read.".to_string()
        }),
        rows,
        equal_count,
        different_count,
    }
}

fn status_of(section: Option<&HostStateSection>) -> String {
    section
        .map(|section| section.status.clone())
        .unwrap_or_else(|| STATUS_NOT_COLLECTED.into())
}

fn incomparable_note(left_status: &str, right_status: &str) -> String {
    let describe = |status: &str| match status {
        STATUS_UNSUPPORTED => "the subsystem is not present",
        STATUS_NOT_COLLECTED => "collection stopped first",
        _ => "the data could not be read",
    };
    let readable = |status: &str| status == STATUS_COLLECTED || status == STATUS_PARTIAL;
    if readable(left_status) {
        format!(
            "Not comparable: on the right host {}.",
            describe(right_status)
        )
    } else if readable(right_status) {
        format!(
            "Not comparable: on the left host {}.",
            describe(left_status)
        )
    } else if left_status == right_status {
        format!("Not comparable: on both hosts {}.", describe(left_status))
    } else {
        format!(
            "Not comparable: on the left host {}, and on the right host {}.",
            describe(left_status),
            describe(right_status)
        )
    }
}

fn index(section: Option<&HostStateSection>) -> BTreeMap<&String, &HostStateEntry> {
    section
        .map(|section| {
            section
                .entries
                .iter()
                .map(|entry| (&entry.identity, entry))
                .collect()
        })
        .unwrap_or_default()
}

fn diff_row(
    identity: &str,
    left: Option<&HostStateEntry>,
    right: Option<&HostStateEntry>,
) -> HostDiffRow {
    let label = left
        .or(right)
        .map(|entry| entry.label.clone())
        .unwrap_or_else(|| identity.to_string());
    let mut names: Vec<&str> = Vec::new();
    for entry in [left, right].into_iter().flatten() {
        for fact in &entry.facts {
            if !names.contains(&fact.name.as_str()) {
                names.push(&fact.name);
            }
        }
    }
    let facts: Vec<HostDiffFact> = names
        .into_iter()
        .map(|name| {
            let left_value = value_of(left, name);
            let right_value = value_of(right, name);
            HostDiffFact {
                name: name.to_string(),
                equal: left_value == right_value,
                left_value,
                right_value,
            }
        })
        .collect();
    let state = match (left, right) {
        (Some(_), None) => ROW_LEFT_ONLY,
        (None, Some(_)) => ROW_RIGHT_ONLY,
        _ if facts.iter().all(|fact| fact.equal) => ROW_EQUAL,
        _ => ROW_DIFFERENT,
    };
    HostDiffRow {
        identity: identity.to_string(),
        label,
        state: state.into(),
        facts,
    }
}

fn value_of(entry: Option<&HostStateEntry>, name: &str) -> Option<String> {
    entry?
        .facts
        .iter()
        .find(|fact| fact.name == name)
        .map(|fact| fact.value.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection(id: &str) -> SavedConnection {
        SavedConnection {
            id: id.into(),
            display_name: format!("Host {id}"),
            destination: format!("{id}.example"),
            username: None,
            port: None,
            identity_file: None,
            history_enabled: false,
            group_id: None,
            tags: Vec::new(),
            created_at: String::new(),
            updated_at: String::new(),
            last_connected_at: None,
        }
    }

    fn entry(identity: &str, facts: &[(&str, &str)]) -> HostStateEntry {
        HostStateEntry {
            identity: identity.into(),
            label: identity.into(),
            facts: facts
                .iter()
                .map(|(name, value)| fact(name, *value))
                .collect(),
        }
    }

    fn collected(kind: &str, entries: Vec<HostStateEntry>) -> HostStateSection {
        HostStateSection {
            kind: kind.into(),
            status: STATUS_COLLECTED.into(),
            collected_at: Some("2026-09-01T10:00:00Z".into()),
            message: None,
            entries,
        }
    }

    fn diff_of(left: Vec<HostStateSection>, right: Vec<HostStateSection>) -> HostDiff {
        build_diff(&connection("a"), &connection("b"), &left, &right)
    }

    fn section_of<'a>(diff: &'a HostDiff, kind: &str) -> &'a HostDiffSection {
        diff.sections
            .iter()
            .find(|section| section.kind == kind)
            .expect("section")
    }

    #[test]
    fn equal_different_and_one_sided_rows_are_reported_separately() {
        let left = vec![collected(
            SECTION_SYSTEMD_UNITS,
            vec![
                entry("ssh.service", &[("activeState", "active")]),
                entry("nginx.service", &[("activeState", "active")]),
                entry("only-left.service", &[("activeState", "active")]),
            ],
        )];
        let right = vec![collected(
            SECTION_SYSTEMD_UNITS,
            vec![
                entry("ssh.service", &[("activeState", "active")]),
                entry("nginx.service", &[("activeState", "failed")]),
                entry("only-right.service", &[("activeState", "active")]),
            ],
        )];
        let diff = diff_of(left, right);
        let section = section_of(&diff, SECTION_SYSTEMD_UNITS);
        assert!(section.comparable);
        assert_eq!(section.equal_count, 1);
        assert_eq!(section.different_count, 3);
        let states: Vec<(&str, &str)> = section
            .rows
            .iter()
            .map(|row| (row.identity.as_str(), row.state.as_str()))
            .collect();
        // Rows are ordered by identity, so the same pair always renders the same.
        assert_eq!(
            states,
            vec![
                ("nginx.service", ROW_DIFFERENT),
                ("only-left.service", ROW_LEFT_ONLY),
                ("only-right.service", ROW_RIGHT_ONLY),
                ("ssh.service", ROW_EQUAL),
            ]
        );
    }

    #[test]
    fn a_changed_fact_carries_both_values() {
        let diff = diff_of(
            vec![collected(
                SECTION_HOST,
                vec![entry(
                    "host",
                    &[("kernel", "6.1.0"), ("architecture", "x86_64")],
                )],
            )],
            vec![collected(
                SECTION_HOST,
                vec![entry(
                    "host",
                    &[("kernel", "6.6.2"), ("architecture", "x86_64")],
                )],
            )],
        );
        let row = &section_of(&diff, SECTION_HOST).rows[0];
        assert_eq!(row.state, ROW_DIFFERENT);
        let kernel = row.facts.iter().find(|fact| fact.name == "kernel").unwrap();
        assert_eq!(kernel.left_value.as_deref(), Some("6.1.0"));
        assert_eq!(kernel.right_value.as_deref(), Some("6.6.2"));
        assert!(!kernel.equal);
        let architecture = row
            .facts
            .iter()
            .find(|fact| fact.name == "architecture")
            .unwrap();
        assert!(architecture.equal);
    }

    #[test]
    fn a_fact_present_on_only_one_host_is_a_difference_not_a_match() {
        let diff = diff_of(
            vec![collected(SECTION_HOST, vec![entry("host", &[])])],
            vec![collected(
                SECTION_HOST,
                vec![entry("host", &[("kernel", "6.6.2")])],
            )],
        );
        let row = &section_of(&diff, SECTION_HOST).rows[0];
        assert_eq!(row.state, ROW_DIFFERENT);
        assert_eq!(row.facts[0].left_value, None);
        assert_eq!(row.facts[0].right_value.as_deref(), Some("6.6.2"));
    }

    #[test]
    fn missing_data_is_never_presented_as_equality() {
        let mut unsupported = collected(SECTION_CONTAINERS, Vec::new());
        unsupported.status = STATUS_UNSUPPORTED.into();
        let diff = diff_of(
            vec![collected(SECTION_CONTAINERS, vec![entry("name:api", &[])])],
            vec![unsupported],
        );
        let section = section_of(&diff, SECTION_CONTAINERS);
        assert!(!section.comparable);
        assert_eq!(section.equal_count, 0);
        assert_eq!(section.different_count, 0);
        assert!(section.rows.is_empty());
        assert_eq!(
            section.note.as_deref(),
            Some("Not comparable: on the right host the subsystem is not present.")
        );
    }

    #[test]
    fn a_section_neither_host_reached_says_so() {
        let diff = diff_of(
            vec![not_collected(SECTION_FILESYSTEMS)],
            vec![not_collected(SECTION_FILESYSTEMS)],
        );
        let section = section_of(&diff, SECTION_FILESYSTEMS);
        assert!(!section.comparable);
        assert_eq!(section.left_status, STATUS_NOT_COLLECTED);
        assert_eq!(
            section.note.as_deref(),
            Some("Not comparable: on both hosts collection stopped first.")
        );
    }

    #[test]
    fn a_section_missing_from_one_side_still_appears() {
        let diff = diff_of(vec![collected(SECTION_HOST, Vec::new())], Vec::new());
        assert_eq!(diff.sections.len(), SECTION_KINDS.len());
        let section = section_of(&diff, SECTION_HOST);
        assert_eq!(section.right_status, STATUS_NOT_COLLECTED);
        assert!(!section.comparable);
    }

    #[test]
    fn a_partial_side_still_compares_but_says_so() {
        let mut partial = collected(
            SECTION_LISTENERS,
            vec![entry("tcp/ipv4/22", &[("owners", "unavailable")])],
        );
        partial.status = STATUS_PARTIAL.into();
        let diff = diff_of(
            vec![partial],
            vec![collected(
                SECTION_LISTENERS,
                vec![entry("tcp/ipv4/22", &[("owners", "ssh.service")])],
            )],
        );
        let section = section_of(&diff, SECTION_LISTENERS);
        assert!(section.comparable);
        assert_eq!(section.different_count, 1);
        assert!(
            section
                .note
                .as_deref()
                .is_some_and(|note| note.contains("partial"))
        );
    }

    #[test]
    fn both_collection_times_and_their_skew_are_reported() {
        let mut left = collected(SECTION_HOST, Vec::new());
        left.collected_at = Some("2026-09-01T10:00:00Z".into());
        let mut right = collected(SECTION_HOST, Vec::new());
        right.collected_at = Some("2026-09-01T10:00:07Z".into());
        let diff = diff_of(vec![left], vec![right]);
        assert_eq!(
            diff.left.collected_at.as_deref(),
            Some("2026-09-01T10:00:00Z")
        );
        assert_eq!(
            diff.right.collected_at.as_deref(),
            Some("2026-09-01T10:00:07Z")
        );
        assert_eq!(diff.collection_skew_seconds, Some(7));
    }

    #[test]
    fn skew_is_unknown_when_a_side_never_reported_a_time() {
        let diff = diff_of(
            vec![not_collected(SECTION_HOST)],
            vec![collected(SECTION_HOST, Vec::new())],
        );
        assert_eq!(diff.collection_skew_seconds, None);
        assert_eq!(diff.left.collected_at, None);
    }

    #[test]
    fn host_identity_is_kept_on_both_sides() {
        let diff = diff_of(Vec::new(), Vec::new());
        assert_eq!(diff.left.connection_id, "a");
        assert_eq!(diff.right.connection_name, "Host b");
    }

    #[test]
    fn comparing_a_connection_with_itself_is_refused() {
        let registry = HostDiffRunRegistry::default();
        let limiter = RemoteOperationLimiter::default();
        struct Silent;
        impl SectionReporter for Silent {
            fn report(&self, _: &str, _: &HostStateSection, _: u32, _: u32) {}
        }
        let same = connection("a");
        let error = compare_hosts(&same, &same, "run-1", &limiter, &registry, &Silent).unwrap_err();
        assert!(error.contains("two different"));
    }

    #[test]
    fn a_cancelled_run_reads_nothing_and_marks_every_section() {
        let registry = HostDiffRunRegistry::default();
        let limiter = RemoteOperationLimiter::default();
        struct Silent;
        impl SectionReporter for Silent {
            fn report(&self, _: &str, _: &HostStateSection, _: u32, _: u32) {}
        }
        let flag = registry.register("run-1");
        flag.store(true, Ordering::SeqCst);
        let diff = compare_hosts(
            &connection("a"),
            &connection("b"),
            "run-1",
            &limiter,
            &registry,
            &Silent,
        )
        .unwrap();
        assert!(diff.sections.iter().all(|section| !section.comparable));
        assert!(
            diff.sections
                .iter()
                .all(|section| section.left_status == STATUS_NOT_COLLECTED)
        );
        assert_eq!(diff.collection_skew_seconds, None);
    }

    #[test]
    fn cancelling_an_unknown_run_is_an_error() {
        let registry = HostDiffRunRegistry::default();
        assert!(registry.cancel("missing").is_err());
        let flag = registry.register("run-1");
        assert!(registry.cancel("run-1").is_ok());
        assert!(flag.load(Ordering::SeqCst));
        registry.release("run-1");
        assert!(registry.cancel("run-1").is_err());
    }

    #[test]
    fn an_absent_subsystem_and_an_unreadable_one_are_different_answers() {
        assert_eq!(
            failure_status("Feature is not installed on this host: docker: not found"),
            STATUS_UNSUPPORTED
        );
        assert_eq!(
            failure_status("The host has no df command"),
            STATUS_UNSUPPORTED
        );
        assert_eq!(
            failure_status("Permission denied: you need to be root"),
            STATUS_UNAVAILABLE
        );
    }

    #[test]
    fn the_module_offers_no_remediation_or_command_path() {
        let source = include_str!("host_diff.rs");
        assert!(!source.contains(concat!("background", "_command")));
        assert!(!source.contains(concat!("Remote", "CommandExecutor")));
        assert!(!source.contains(concat!("execute_with", "_sudo")));
        // Split so the assertion text itself is not what the scan finds.
        for verb in [
            concat!("rest", "art"),
            concat!("systemctl ", "start"),
            concat!("docker ", "rm"),
        ] {
            assert!(!source.contains(verb), "found a mutation verb: {verb}");
        }
    }
}
