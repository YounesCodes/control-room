//! Host Snapshots: a bounded, explicit capture of normalized host state, and a
//! deterministic comparison between two captures of the same Saved Connection.
//!
//! Capture only ever runs because the user asked for it. There is no timer, no
//! background task, and no automatic recapture. Every section records its own
//! collection time and support status, so an unsupported or unreadable section
//! can never be mistaken for an unchanged one.

use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use chrono::Utc;
use parking_lot::Mutex;
use uuid::Uuid;

use crate::{
    models::{
        HostIdentity, HostSnapshot, HostSnapshotSummary, SNAPSHOT_SCHEMA_VERSION, SavedConnection,
        SnapshotComparison, SnapshotEntry, SnapshotEntryChange, SnapshotFact, SnapshotFactChange,
        SnapshotSection, SnapshotSectionDiff, SnapshotSectionSummary,
    },
    remote,
};

pub const SECTION_HOST: &str = "host";
pub const SECTION_SYSTEMD_UNITS: &str = "systemdUnits";
pub const SECTION_CONTAINERS: &str = "containers";
pub const SECTION_LISTENERS: &str = "listeners";
pub const SECTION_FILESYSTEMS: &str = "filesystems";

/// The capture order, which is also the display order of a comparison.
pub const SECTION_KINDS: [&str; 5] = [
    SECTION_HOST,
    SECTION_SYSTEMD_UNITS,
    SECTION_CONTAINERS,
    SECTION_LISTENERS,
    SECTION_FILESYSTEMS,
];

pub const STATUS_COLLECTED: &str = "collected";
pub const STATUS_PARTIAL: &str = "partial";
pub const STATUS_UNSUPPORTED: &str = "unsupported";
pub const STATUS_UNAVAILABLE: &str = "unavailable";

/// Tracks captures the user asked to stop. A capture checks the flag between
/// sections, so cancelling takes effect once the section in flight returns.
#[derive(Default)]
pub struct SnapshotCaptureRegistry {
    captures: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl SnapshotCaptureRegistry {
    fn register(&self, capture_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.captures
            .lock()
            .insert(capture_id.to_string(), Arc::clone(&flag));
        flag
    }

    fn release(&self, capture_id: &str) {
        self.captures.lock().remove(capture_id);
    }

    pub fn cancel(&self, capture_id: &str) -> Result<(), String> {
        match self.captures.lock().get(capture_id) {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                Ok(())
            }
            None => Err("That capture is no longer running".into()),
        }
    }
}

/// Reports one finished section while a capture is still running.
pub trait SectionReporter {
    fn report(&self, section: &SnapshotSection, completed: u32, total: u32);
}

pub fn capture(
    connection: &SavedConnection,
    capture_id: &str,
    label: Option<String>,
    registry: &SnapshotCaptureRegistry,
    reporter: &dyn SectionReporter,
) -> Result<HostSnapshot, String> {
    let cancelled = registry.register(capture_id);
    let result = capture_sections(connection, &cancelled, reporter);
    registry.release(capture_id);
    let (identity, sections) = result?;
    Ok(HostSnapshot {
        id: Uuid::new_v4().to_string(),
        connection_id: connection.id.clone(),
        label: normalize_label(label),
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        captured_at: Utc::now().to_rfc3339(),
        identity,
        sections,
    })
}

fn capture_sections(
    connection: &SavedConnection,
    cancelled: &AtomicBool,
    reporter: &dyn SectionReporter,
) -> Result<(HostIdentity, Vec<SnapshotSection>), String> {
    let identity = remote::collect_host_identity(connection)?;
    let total = SECTION_KINDS.len() as u32;
    let mut sections = Vec::new();
    for (index, kind) in SECTION_KINDS.iter().enumerate() {
        if cancelled.load(Ordering::SeqCst) {
            return Err("Capture stopped before it finished".into());
        }
        let section = collect_section(connection, kind, &identity);
        reporter.report(&section, index as u32 + 1, total);
        sections.push(section);
    }
    Ok((identity, sections))
}

fn collect_section(
    connection: &SavedConnection,
    kind: &str,
    identity: &HostIdentity,
) -> SnapshotSection {
    match kind {
        SECTION_HOST => host_section(identity),
        SECTION_SYSTEMD_UNITS => systemd_section(connection),
        SECTION_CONTAINERS => containers_section(connection),
        SECTION_LISTENERS => listeners_section(connection),
        _ => filesystems_section(connection),
    }
}

fn section(
    kind: &str,
    status: &str,
    message: Option<String>,
    entries: Vec<SnapshotEntry>,
) -> SnapshotSection {
    SnapshotSection {
        kind: kind.into(),
        status: status.into(),
        collected_at: Utc::now().to_rfc3339(),
        message,
        entries,
    }
}

fn host_section(identity: &HostIdentity) -> SnapshotSection {
    let facts = vec![
        fact("hostname", identity.hostname.clone()),
        fact("operatingSystem", identity.os_id.clone()),
        fact("osVersion", identity.os_version.clone()),
        fact("kernel", identity.kernel.clone()),
        fact("architecture", identity.architecture.clone()),
        fact("machineFingerprint", identity.machine_fingerprint.clone()),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    let status = if facts.len() == 6 {
        STATUS_COLLECTED
    } else {
        STATUS_PARTIAL
    };
    let message = (status == STATUS_PARTIAL)
        .then(|| "Some host facts were not readable on this host.".to_string());
    section(
        SECTION_HOST,
        status,
        message,
        vec![SnapshotEntry {
            identity: "host".into(),
            label: identity.hostname.clone().unwrap_or_else(|| "Host".into()),
            facts,
        }],
    )
}

fn systemd_section(connection: &SavedConnection) -> SnapshotSection {
    match remote::list_services(connection) {
        Ok(units) => {
            let entries = units
                .into_iter()
                .map(|unit| SnapshotEntry {
                    identity: unit.id.clone(),
                    label: unit.id.clone(),
                    facts: vec![
                        SnapshotFact {
                            name: "type".into(),
                            value: unit.unit_type,
                        },
                        SnapshotFact {
                            name: "loadState".into(),
                            value: unit.load_state,
                        },
                        SnapshotFact {
                            name: "activeState".into(),
                            value: unit.active_state,
                        },
                        SnapshotFact {
                            name: "subState".into(),
                            value: unit.sub_state,
                        },
                        SnapshotFact {
                            name: "unitFileState".into(),
                            value: unit.unit_file_state.unwrap_or_else(|| "unknown".into()),
                        },
                    ],
                })
                .collect();
            section(SECTION_SYSTEMD_UNITS, STATUS_COLLECTED, None, entries)
        }
        Err(error) => section(
            SECTION_SYSTEMD_UNITS,
            STATUS_UNAVAILABLE,
            Some(error),
            Vec::new(),
        ),
    }
}

fn containers_section(connection: &SavedConnection) -> SnapshotSection {
    match remote::list_containers(connection, None) {
        Ok(containers) => {
            let entries = containers
                .into_iter()
                .map(|container| SnapshotEntry {
                    identity: container.name.clone(),
                    label: container.name.clone(),
                    facts: vec![
                        SnapshotFact {
                            name: "image".into(),
                            value: container.image,
                        },
                        SnapshotFact {
                            name: "state".into(),
                            value: container.state,
                        },
                        SnapshotFact {
                            name: "publishedPorts".into(),
                            value: container.ports,
                        },
                        SnapshotFact {
                            name: "composeProject".into(),
                            value: container.compose_project.unwrap_or_else(|| "none".into()),
                        },
                        SnapshotFact {
                            name: "composeService".into(),
                            value: container.compose_service.unwrap_or_else(|| "none".into()),
                        },
                    ],
                })
                .collect();
            section(SECTION_CONTAINERS, STATUS_COLLECTED, None, entries)
        }
        Err(error) => {
            let status = if mentions_missing_docker(&error) {
                STATUS_UNSUPPORTED
            } else {
                STATUS_UNAVAILABLE
            };
            section(SECTION_CONTAINERS, status, Some(error), Vec::new())
        }
    }
}

fn mentions_missing_docker(error: &str) -> bool {
    let lowered = error.to_ascii_lowercase();
    lowered.contains("not installed") || lowered.contains("command not found")
}

fn listeners_section(connection: &SavedConnection) -> SnapshotSection {
    match remote::list_ports(connection, None) {
        Ok(sockets) => {
            let unowned = sockets
                .iter()
                .filter(|socket| socket.ownership != "known")
                .count();
            let entries = sockets
                .into_iter()
                .map(|socket| SnapshotEntry {
                    identity: format!(
                        "{}/{}/{}:{}",
                        socket.protocol, socket.address_family, socket.local_address, socket.port
                    ),
                    label: format!(
                        "{}:{}/{}",
                        socket.local_address, socket.port, socket.protocol
                    ),
                    facts: vec![
                        SnapshotFact {
                            name: "process".into(),
                            value: socket.process_name.unwrap_or_else(|| "unavailable".into()),
                        },
                        SnapshotFact {
                            name: "systemdUnit".into(),
                            value: socket.systemd_unit.unwrap_or_else(|| "unavailable".into()),
                        },
                        SnapshotFact {
                            name: "ownership".into(),
                            value: socket.ownership,
                        },
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
            STATUS_UNAVAILABLE,
            Some(error),
            Vec::new(),
        ),
    }
}

fn filesystems_section(connection: &SavedConnection) -> SnapshotSection {
    match remote::list_filesystems(connection) {
        Ok(filesystems) => {
            let entries = filesystems
                .into_iter()
                .map(|filesystem| SnapshotEntry {
                    identity: filesystem.mount_point.clone(),
                    label: filesystem.mount_point,
                    facts: vec![
                        SnapshotFact {
                            name: "type".into(),
                            value: filesystem.filesystem_type,
                        },
                        SnapshotFact {
                            name: "sizeKib".into(),
                            value: filesystem.size_kib.to_string(),
                        },
                        SnapshotFact {
                            name: "usedPercent".into(),
                            value: filesystem.used_percent.to_string(),
                        },
                    ],
                })
                .collect();
            section(SECTION_FILESYSTEMS, STATUS_COLLECTED, None, entries)
        }
        Err(error) => {
            let status = if error.contains("no df command") {
                STATUS_UNSUPPORTED
            } else {
                STATUS_UNAVAILABLE
            };
            section(SECTION_FILESYSTEMS, status, Some(error), Vec::new())
        }
    }
}

fn fact(name: &str, value: Option<String>) -> Option<SnapshotFact> {
    value.map(|value| SnapshotFact {
        name: name.into(),
        value,
    })
}

pub fn normalize_label(label: Option<String>) -> Option<String> {
    label
        .map(|value| value.trim().chars().take(80).collect::<String>())
        .filter(|value| !value.is_empty())
}

pub fn summarize(snapshot: &HostSnapshot) -> HostSnapshotSummary {
    HostSnapshotSummary {
        id: snapshot.id.clone(),
        connection_id: snapshot.connection_id.clone(),
        label: snapshot.label.clone(),
        schema_version: snapshot.schema_version,
        captured_at: snapshot.captured_at.clone(),
        identity: snapshot.identity.clone(),
        sections: snapshot
            .sections
            .iter()
            .map(|section| SnapshotSectionSummary {
                kind: section.kind.clone(),
                status: section.status.clone(),
                entry_count: section.entries.len() as u32,
            })
            .collect(),
    }
}

/// Compares two captures of the same Saved Connection. The result states what
/// it could not compare instead of implying nothing changed there, and it draws
/// no causal conclusion about why a value moved.
pub fn compare(base: &HostSnapshot, target: &HostSnapshot) -> SnapshotComparison {
    let schema_compatible = base.schema_version == target.schema_version;
    let sections = SECTION_KINDS
        .iter()
        .map(|kind| compare_section(kind, base, target, schema_compatible))
        .collect();
    SnapshotComparison {
        base: summarize(base),
        target: summarize(target),
        identity_match: identity_match(&base.identity, &target.identity).into(),
        schema_compatible,
        sections,
    }
}

fn identity_match(base: &HostIdentity, target: &HostIdentity) -> &'static str {
    match (&base.machine_fingerprint, &target.machine_fingerprint) {
        (Some(left), Some(right)) if left == right => "same",
        (Some(_), Some(_)) => "different",
        _ => "unknown",
    }
}

fn compare_section(
    kind: &str,
    base: &HostSnapshot,
    target: &HostSnapshot,
    schema_compatible: bool,
) -> SnapshotSectionDiff {
    let base_section = base.sections.iter().find(|section| section.kind == kind);
    let target_section = target.sections.iter().find(|section| section.kind == kind);
    let base_status = base_section
        .map(|section| section.status.clone())
        .unwrap_or_else(|| STATUS_UNAVAILABLE.into());
    let target_status = target_section
        .map(|section| section.status.clone())
        .unwrap_or_else(|| STATUS_UNAVAILABLE.into());
    let readable = |status: &str| status == STATUS_COLLECTED || status == STATUS_PARTIAL;
    let comparable = schema_compatible && readable(&base_status) && readable(&target_status);
    if !comparable {
        return SnapshotSectionDiff {
            kind: kind.into(),
            note: Some(incomparable_note(
                schema_compatible,
                &base_status,
                &target_status,
            )),
            base_status,
            target_status,
            comparable: false,
            added: Vec::new(),
            removed: Vec::new(),
            changed: Vec::new(),
            unchanged_count: 0,
        };
    }
    let base_entries = index_entries(base_section);
    let target_entries = index_entries(target_section);
    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut changed = Vec::new();
    let mut unchanged_count = 0;
    for (identity, entry) in &target_entries {
        match base_entries.get(identity) {
            None => added.push((*entry).clone()),
            Some(previous) => {
                let changes = compare_facts(previous, entry);
                if changes.is_empty() {
                    unchanged_count += 1;
                } else {
                    changed.push(SnapshotEntryChange {
                        identity: identity.clone(),
                        label: entry.label.clone(),
                        changes,
                    });
                }
            }
        }
    }
    for (identity, entry) in &base_entries {
        if !target_entries.contains_key(identity) {
            removed.push((*entry).clone());
        }
    }
    let partial = base_status == STATUS_PARTIAL || target_status == STATUS_PARTIAL;
    SnapshotSectionDiff {
        kind: kind.into(),
        base_status,
        target_status,
        comparable: true,
        note: partial.then(|| {
            "One side of this section was partial. The comparison covers only what each capture could read."
                .to_string()
        }),
        added,
        removed,
        changed,
        unchanged_count,
    }
}

fn incomparable_note(schema_compatible: bool, base_status: &str, target_status: &str) -> String {
    if !schema_compatible {
        return "These snapshots use different schema versions, so this section cannot be compared."
            .into();
    }
    let describe = |status: &str| match status {
        STATUS_UNSUPPORTED => "the subsystem was not present",
        _ => "the data could not be read",
    };
    match (base_status, target_status) {
        (base, target) if base == STATUS_COLLECTED || base == STATUS_PARTIAL => {
            format!("Not comparable: in the later capture {}.", describe(target))
        }
        (base, target) if target == STATUS_COLLECTED || target == STATUS_PARTIAL => {
            format!("Not comparable: in the earlier capture {}.", describe(base))
        }
        (base, _) => format!("Not comparable: in both captures {}.", describe(base)),
    }
}

fn index_entries(section: Option<&SnapshotSection>) -> BTreeMap<String, &SnapshotEntry> {
    section
        .map(|section| {
            section
                .entries
                .iter()
                .map(|entry| (entry.identity.clone(), entry))
                .collect()
        })
        .unwrap_or_default()
}

fn compare_facts(base: &SnapshotEntry, target: &SnapshotEntry) -> Vec<SnapshotFactChange> {
    let mut names: Vec<&str> = Vec::new();
    for entry in [base, target] {
        for fact in &entry.facts {
            if !names.contains(&fact.name.as_str()) {
                names.push(&fact.name);
            }
        }
    }
    names
        .into_iter()
        .filter_map(|name| {
            let base_value = find_fact(base, name);
            let target_value = find_fact(target, name);
            (base_value != target_value).then(|| SnapshotFactChange {
                name: name.to_string(),
                base_value,
                target_value,
            })
        })
        .collect()
}

fn find_fact(entry: &SnapshotEntry, name: &str) -> Option<String> {
    entry
        .facts
        .iter()
        .find(|fact| fact.name == name)
        .map(|fact| fact.value.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(identity: &str, facts: &[(&str, &str)]) -> SnapshotEntry {
        SnapshotEntry {
            identity: identity.into(),
            label: identity.into(),
            facts: facts
                .iter()
                .map(|(name, value)| SnapshotFact {
                    name: (*name).into(),
                    value: (*value).into(),
                })
                .collect(),
        }
    }

    fn snapshot(
        id: &str,
        fingerprint: Option<&str>,
        sections: Vec<SnapshotSection>,
    ) -> HostSnapshot {
        HostSnapshot {
            id: id.into(),
            connection_id: "connection-a".into(),
            label: None,
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            captured_at: "2026-09-01T00:00:00Z".into(),
            identity: HostIdentity {
                hostname: Some("host-a".into()),
                machine_fingerprint: fingerprint.map(str::to_string),
                os_id: Some("debian".into()),
                os_version: Some("13".into()),
                kernel: Some("6.1.0".into()),
                architecture: Some("x86_64".into()),
            },
            sections,
        }
    }

    fn units(status: &str, entries: Vec<SnapshotEntry>) -> SnapshotSection {
        section(SECTION_SYSTEMD_UNITS, status, None, entries)
    }

    fn find(comparison: SnapshotComparison, kind: &str) -> SnapshotSectionDiff {
        comparison
            .sections
            .into_iter()
            .find(|diff| diff.kind == kind)
            .expect("section diff")
    }

    #[test]
    fn diff_reports_typed_additions_removals_and_modifications() {
        let base = snapshot(
            "base",
            Some("aaaa"),
            vec![units(
                STATUS_COLLECTED,
                vec![
                    entry("ssh.service", &[("activeState", "active")]),
                    entry("nginx.service", &[("activeState", "active")]),
                ],
            )],
        );
        let target = snapshot(
            "target",
            Some("aaaa"),
            vec![units(
                STATUS_COLLECTED,
                vec![
                    entry("ssh.service", &[("activeState", "active")]),
                    entry("postgresql.service", &[("activeState", "active")]),
                ],
            )],
        );
        let diff = find(compare(&base, &target), SECTION_SYSTEMD_UNITS);
        assert!(diff.comparable);
        assert_eq!(diff.added.len(), 1);
        assert_eq!(diff.added[0].identity, "postgresql.service");
        assert_eq!(diff.removed.len(), 1);
        assert_eq!(diff.removed[0].identity, "nginx.service");
        assert_eq!(diff.unchanged_count, 1);
        assert!(diff.changed.is_empty());
    }

    #[test]
    fn changed_facts_carry_both_values() {
        let base = snapshot(
            "base",
            Some("aaaa"),
            vec![units(
                STATUS_COLLECTED,
                vec![entry(
                    "nginx.service",
                    &[("activeState", "active"), ("subState", "running")],
                )],
            )],
        );
        let target = snapshot(
            "target",
            Some("aaaa"),
            vec![units(
                STATUS_COLLECTED,
                vec![entry(
                    "nginx.service",
                    &[("activeState", "failed"), ("subState", "running")],
                )],
            )],
        );
        let diff = find(compare(&base, &target), SECTION_SYSTEMD_UNITS);
        assert_eq!(diff.changed.len(), 1);
        assert_eq!(
            diff.changed[0].changes,
            vec![SnapshotFactChange {
                name: "activeState".into(),
                base_value: Some("active".into()),
                target_value: Some("failed".into()),
            }]
        );
        assert_eq!(diff.unchanged_count, 0);
    }

    #[test]
    fn a_fact_present_on_only_one_side_is_a_change() {
        let base = snapshot(
            "base",
            Some("aaaa"),
            vec![units(STATUS_COLLECTED, vec![entry("nginx.service", &[])])],
        );
        let target = snapshot(
            "target",
            Some("aaaa"),
            vec![units(
                STATUS_COLLECTED,
                vec![entry("nginx.service", &[("activeState", "active")])],
            )],
        );
        let diff = find(compare(&base, &target), SECTION_SYSTEMD_UNITS);
        assert_eq!(
            diff.changed[0].changes,
            vec![SnapshotFactChange {
                name: "activeState".into(),
                base_value: None,
                target_value: Some("active".into()),
            }]
        );
    }

    #[test]
    fn unsupported_and_unavailable_sections_never_look_unchanged() {
        let base = snapshot(
            "base",
            Some("aaaa"),
            vec![section(
                SECTION_CONTAINERS,
                STATUS_COLLECTED,
                None,
                vec![entry("api", &[])],
            )],
        );
        let target = snapshot(
            "target",
            Some("aaaa"),
            vec![section(
                SECTION_CONTAINERS,
                STATUS_UNSUPPORTED,
                Some("Docker is not installed".into()),
                Vec::new(),
            )],
        );
        let diff = find(compare(&base, &target), SECTION_CONTAINERS);
        assert!(!diff.comparable);
        assert_eq!(diff.unchanged_count, 0);
        assert!(diff.added.is_empty() && diff.removed.is_empty() && diff.changed.is_empty());
        assert_eq!(
            diff.note.as_deref(),
            Some("Not comparable: in the later capture the subsystem was not present.")
        );
    }

    #[test]
    fn a_missing_section_is_reported_rather_than_dropped() {
        let base = snapshot("base", Some("aaaa"), Vec::new());
        let target = snapshot("target", Some("aaaa"), Vec::new());
        let comparison = compare(&base, &target);
        assert_eq!(comparison.sections.len(), SECTION_KINDS.len());
        for diff in &comparison.sections {
            assert!(!diff.comparable);
            assert_eq!(diff.base_status, STATUS_UNAVAILABLE);
        }
    }

    #[test]
    fn a_partial_section_still_compares_but_says_so() {
        let base = snapshot(
            "base",
            Some("aaaa"),
            vec![section(
                SECTION_LISTENERS,
                STATUS_PARTIAL,
                Some("2 listeners have no readable owner.".into()),
                vec![entry(
                    "tcp/ipv4/0.0.0.0:22",
                    &[("ownership", "unavailable")],
                )],
            )],
        );
        let target = snapshot(
            "target",
            Some("aaaa"),
            vec![section(
                SECTION_LISTENERS,
                STATUS_COLLECTED,
                None,
                vec![entry("tcp/ipv4/0.0.0.0:22", &[("ownership", "known")])],
            )],
        );
        let diff = find(compare(&base, &target), SECTION_LISTENERS);
        assert!(diff.comparable);
        assert_eq!(diff.changed.len(), 1);
        assert!(
            diff.note
                .as_deref()
                .is_some_and(|note| note.contains("partial"))
        );
    }

    #[test]
    fn host_identity_evidence_is_reported_without_guessing() {
        let base = snapshot("base", Some("aaaa"), Vec::new());
        let same = snapshot("same", Some("aaaa"), Vec::new());
        let other = snapshot("other", Some("bbbb"), Vec::new());
        let unknown = snapshot("unknown", None, Vec::new());
        assert_eq!(compare(&base, &same).identity_match, "same");
        assert_eq!(compare(&base, &other).identity_match, "different");
        assert_eq!(compare(&base, &unknown).identity_match, "unknown");
    }

    #[test]
    fn an_incompatible_schema_blocks_every_section() {
        let base = snapshot(
            "base",
            Some("aaaa"),
            vec![units(STATUS_COLLECTED, vec![entry("ssh.service", &[])])],
        );
        let mut target = snapshot(
            "target",
            Some("aaaa"),
            vec![units(STATUS_COLLECTED, vec![entry("ssh.service", &[])])],
        );
        target.schema_version = SNAPSHOT_SCHEMA_VERSION + 1;
        let comparison = compare(&base, &target);
        assert!(!comparison.schema_compatible);
        assert!(comparison.sections.iter().all(|diff| !diff.comparable));
    }

    #[test]
    fn labels_are_trimmed_bounded_and_optional() {
        assert_eq!(
            normalize_label(Some("  before upgrade  ".into())).as_deref(),
            Some("before upgrade")
        );
        assert_eq!(normalize_label(Some("   ".into())), None);
        assert_eq!(normalize_label(None), None);
        assert_eq!(
            normalize_label(Some("x".repeat(200))).map(|value| value.len()),
            Some(80)
        );
    }

    #[test]
    fn cancelling_an_unknown_capture_is_an_error_not_a_silent_success() {
        let registry = SnapshotCaptureRegistry::default();
        assert!(registry.cancel("missing").is_err());
        let flag = registry.register("capture-1");
        assert!(registry.cancel("capture-1").is_ok());
        assert!(flag.load(Ordering::SeqCst));
        registry.release("capture-1");
        assert!(registry.cancel("capture-1").is_err());
    }

    #[test]
    fn capture_is_explicit_and_never_scheduled() {
        let source = include_str!("snapshots.rs");
        assert!(!source.contains(concat!("thread", "::spawn")));
        assert!(!source.contains(concat!("set", "_interval")));
        assert!(!source.contains(concat!("sleep", "(")));
    }
}
