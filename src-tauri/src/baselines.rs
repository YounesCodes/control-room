//! Host Baselines: a bounded, explicit capture of normalized host state, and a
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
    baseline_collectors as evidence,
    models::{
        BASELINE_SCHEMA_VERSION, BaselineComparison, BaselineEntry, BaselineEntryChange,
        BaselineFact, BaselineFactChange, BaselineSection, BaselineSectionDiff,
        BaselineSectionSummary, BaselineTrace, BaselineTracePoint, HostBaseline,
        HostBaselineSummary, HostIdentity, SavedConnection,
    },
    remote::{self, Elevation},
};

pub const SECTION_HOST: &str = "host";
pub const SECTION_SYSTEMD_UNITS: &str = "systemdUnits";
pub const SECTION_CONTAINERS: &str = "containers";
pub const SECTION_LISTENERS: &str = "listeners";
pub const SECTION_FIREWALL: &str = "firewall";
pub const SECTION_FILESYSTEMS: &str = "filesystems";
pub const SECTION_SCHEDULED_JOBS: &str = "scheduledJobs";
pub const SECTION_PACKAGES: &str = "packages";
pub const SECTION_CONFIGURATION: &str = "configurationAccess";

/// The capture order, which is also the display order of a comparison.
pub const SECTION_KINDS: [&str; 9] = [
    SECTION_HOST,
    SECTION_SYSTEMD_UNITS,
    SECTION_CONTAINERS,
    SECTION_LISTENERS,
    SECTION_FIREWALL,
    SECTION_FILESYSTEMS,
    SECTION_SCHEDULED_JOBS,
    SECTION_PACKAGES,
    SECTION_CONFIGURATION,
];

pub const STATUS_COLLECTED: &str = "collected";
pub const STATUS_PARTIAL: &str = "partial";
pub const STATUS_UNSUPPORTED: &str = "unsupported";
pub const STATUS_UNAVAILABLE: &str = "unavailable";
/// The capture never asked this section for anything: the user left it out, or
/// stopped the run before it came up. Distinct from a section that was asked
/// and could not answer.
pub const STATUS_SKIPPED: &str = "skipped";

pub const CLASSIFICATION_MEANINGFUL: &str = "meaningful";
pub const CLASSIFICATION_ROUTINE: &str = "routine";

/// Each section's fact shape carries its own version. Bump only the section you
/// changed: an older capture stays comparable in every section you did not
/// touch, which matters because captures are manual and retention is bounded.
pub fn section_schema_version(kind: &str) -> u32 {
    match kind {
        SECTION_HOST => 1,
        SECTION_SYSTEMD_UNITS => 1,
        SECTION_CONTAINERS => 1,
        SECTION_LISTENERS => 1,
        SECTION_FIREWALL => 2,
        SECTION_FILESYSTEMS => 1,
        SECTION_SCHEDULED_JOBS => 2,
        SECTION_PACKAGES => 1,
        _ => 1,
    }
}

/// The whole-capture version a section first appeared in. A capture older than
/// this could not have recorded the section, so a missing one is the capture's
/// vintage rather than a failed read.
pub fn section_introduced_in(kind: &str) -> u32 {
    match kind {
        SECTION_FIREWALL | SECTION_SCHEDULED_JOBS | SECTION_PACKAGES => 2,
        SECTION_CONFIGURATION => 3,
        _ => 1,
    }
}

/// Tracks captures the user asked to stop. A capture checks the flag between
/// sections, so cancelling takes effect once the section in flight returns.
#[derive(Default)]
pub struct BaselineCaptureRegistry {
    captures: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl BaselineCaptureRegistry {
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
    fn report(&self, section: &BaselineSection, completed: u32, total: u32);
}

/// Validates the section selection, rejecting names this build does not know
/// rather than silently capturing less than the caller asked for.
pub fn resolve_selection(requested: Option<&[String]>) -> Result<Vec<&'static str>, String> {
    let Some(requested) = requested else {
        return Ok(SECTION_KINDS.to_vec());
    };
    if requested.is_empty() {
        return Err("Choose at least one section to capture".into());
    }
    let mut selected = Vec::new();
    for name in requested {
        let kind = SECTION_KINDS
            .iter()
            .find(|kind| *kind == name)
            .ok_or_else(|| format!("Unknown baseline section: {name}"))?;
        if !selected.contains(kind) {
            selected.push(*kind);
        }
    }
    Ok(selected)
}

pub fn capture(
    connection: &SavedConnection,
    capture_id: &str,
    label: Option<String>,
    sections: Option<&[String]>,
    elevation: &Elevation,
    registry: &BaselineCaptureRegistry,
    reporter: &dyn SectionReporter,
) -> Result<HostBaseline, String> {
    let selection = resolve_selection(sections)?;
    let cancelled = registry.register(capture_id);
    let result = capture_sections(connection, &selection, elevation, &cancelled, reporter);
    registry.release(capture_id);
    let (identity, sections) = result?;
    Ok(HostBaseline {
        id: Uuid::new_v4().to_string(),
        connection_id: connection.id.clone(),
        label: normalize_label(label),
        schema_version: BASELINE_SCHEMA_VERSION,
        captured_at: Utc::now().to_rfc3339(),
        pinned: false,
        identity,
        sections,
    })
}

/// Every section always appears, so a capture can never look complete when it
/// is not. A section the user left out or stopped short of is recorded as
/// skipped, which is neither collected nor a failed read.
fn capture_sections(
    connection: &SavedConnection,
    selection: &[&str],
    elevation: &Elevation,
    cancelled: &AtomicBool,
    reporter: &dyn SectionReporter,
) -> Result<(HostIdentity, Vec<BaselineSection>), String> {
    let identity = remote::collect_host_identity(connection)?;
    let total = SECTION_KINDS.len() as u32;
    let mut sections = Vec::new();
    let mut stopped = false;
    for (index, kind) in SECTION_KINDS.iter().enumerate() {
        let section = if !selection.contains(kind) {
            skipped_section(kind, "This section was not part of the capture.")
        } else if stopped || cancelled.load(Ordering::SeqCst) {
            stopped = true;
            skipped_section(
                kind,
                "The capture was stopped before this section was read.",
            )
        } else {
            collect_section(connection, kind, elevation, &identity)
        };
        reporter.report(&section, index as u32 + 1, total);
        sections.push(section);
    }
    // Keeping what finished is the point of stopping. Saving a capture that
    // read nothing would only spend a retention slot on an empty record.
    let read_anything = sections
        .iter()
        .any(|section| section.status != STATUS_SKIPPED);
    if !read_anything {
        return Err("Capture stopped before it read anything".into());
    }
    Ok((identity, sections))
}

fn skipped_section(kind: &str, message: &str) -> BaselineSection {
    section(kind, STATUS_SKIPPED, Some(message.to_string()), Vec::new())
}

fn collect_section(
    connection: &SavedConnection,
    kind: &str,
    elevation: &Elevation,
    identity: &HostIdentity,
) -> BaselineSection {
    match kind {
        SECTION_HOST => host_section(connection, identity),
        SECTION_SYSTEMD_UNITS => evidence::merge(
            systemd_section(connection),
            evidence::read(connection, elevation, kind, evidence::SYSTEMD),
        ),
        SECTION_CONTAINERS => evidence::merge(
            containers_section(connection, elevation),
            evidence::docker(connection, elevation),
        ),
        SECTION_LISTENERS => evidence::merge(
            listeners_section(connection, elevation),
            evidence::read(connection, elevation, kind, evidence::NETWORK),
        ),
        SECTION_FIREWALL => evidence::read(connection, elevation, kind, evidence::FIREWALL),
        SECTION_FILESYSTEMS => evidence::merge(
            filesystems_section(connection),
            evidence::read(connection, elevation, kind, evidence::STORAGE),
        ),
        SECTION_SCHEDULED_JOBS => scheduled_jobs_section(connection, elevation),
        SECTION_PACKAGES => evidence::merge(
            packages_section(connection),
            evidence::read(connection, elevation, kind, evidence::PACKAGE_HISTORY),
        ),
        _ => evidence::read(connection, elevation, kind, evidence::CONFIGURATION),
    }
}

fn section(
    kind: &str,
    status: &str,
    message: Option<String>,
    entries: Vec<BaselineEntry>,
) -> BaselineSection {
    BaselineSection {
        kind: kind.into(),
        status: status.into(),
        schema_version: section_schema_version(kind),
        collected_at: Utc::now().to_rfc3339(),
        message,
        entries,
    }
}

fn host_section(connection: &SavedConnection, identity: &HostIdentity) -> BaselineSection {
    let mut facts = vec![
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
    let identity_complete = facts.len() == 6;
    // Hardware facts are additive: a capture that could not read one simply
    // does not record it, the same way an older capture did not. They never
    // degrade the identity facts the fingerprint check depends on.
    let extra_facts = remote::list_host_facts(connection);
    let extras_complete = extra_facts.as_ref().is_ok_and(|facts| facts.len() == 4);
    for extra in extra_facts.unwrap_or_default() {
        if !facts.iter().any(|existing| existing.name == extra.0) {
            facts.push(BaselineFact {
                name: extra.0,
                value: extra.1,
            });
        }
    }
    let status = if identity_complete && extras_complete {
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
        vec![BaselineEntry {
            identity: "host".into(),
            label: identity.hostname.clone().unwrap_or_else(|| "Host".into()),
            facts,
        }],
    )
}

fn systemd_section(connection: &SavedConnection) -> BaselineSection {
    match remote::list_services(connection) {
        Ok(units) => {
            let entries = units
                .into_iter()
                .map(|unit| BaselineEntry {
                    identity: unit.id.clone(),
                    label: unit.id.clone(),
                    facts: vec![
                        BaselineFact {
                            name: "type".into(),
                            value: unit.unit_type,
                        },
                        BaselineFact {
                            name: "loadState".into(),
                            value: unit.load_state,
                        },
                        BaselineFact {
                            name: "activeState".into(),
                            value: unit.active_state,
                        },
                        BaselineFact {
                            name: "subState".into(),
                            value: unit.sub_state,
                        },
                        BaselineFact {
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

fn containers_section(connection: &SavedConnection, elevation: &Elevation) -> BaselineSection {
    match remote::list_containers(connection, elevation.clone()) {
        Ok(containers) => {
            let entries = containers
                .into_iter()
                .map(|container| BaselineEntry {
                    identity: container.name.clone(),
                    label: container.name.clone(),
                    facts: vec![
                        BaselineFact {
                            name: "image".into(),
                            value: container.image,
                        },
                        BaselineFact {
                            name: "state".into(),
                            value: container.state,
                        },
                        BaselineFact {
                            name: "publishedPorts".into(),
                            value: container.ports,
                        },
                        BaselineFact {
                            name: "composeProject".into(),
                            value: container.compose_project.unwrap_or_else(|| "none".into()),
                        },
                        BaselineFact {
                            name: "composeService".into(),
                            value: container.compose_service.unwrap_or_else(|| "none".into()),
                        },
                        // The runtime ID is what Docker deep links resolve, so
                        // it is recorded as evidence even though it becomes a
                        // new one whenever the container is recreated.
                        BaselineFact {
                            name: "containerId".into(),
                            value: container.id,
                        },
                        BaselineFact {
                            name: "composeContainerNumber".into(),
                            value: container
                                .compose_container_number
                                .map(|number| number.to_string())
                                .unwrap_or_else(|| "unknown".into()),
                        },
                        BaselineFact {
                            name: "composeOneoff".into(),
                            value: container
                                .compose_oneoff
                                .map(|value| value.to_string())
                                .unwrap_or_else(|| "unknown".into()),
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

fn listeners_section(connection: &SavedConnection, elevation: &Elevation) -> BaselineSection {
    match remote::list_ports(connection, elevation.clone()) {
        Ok(sockets) => {
            let unowned = sockets
                .iter()
                .filter(|socket| socket.ownership != "known")
                .count();
            let entries = sockets
                .into_iter()
                .map(|socket| BaselineEntry {
                    identity: format!(
                        "{}/{}/{}:{}",
                        socket.protocol, socket.address_family, socket.local_address, socket.port
                    ),
                    label: format!(
                        "{}:{}/{}",
                        socket.local_address, socket.port, socket.protocol
                    ),
                    facts: vec![
                        BaselineFact {
                            name: "process".into(),
                            value: socket.process_name.unwrap_or_else(|| "unavailable".into()),
                        },
                        BaselineFact {
                            name: "systemdUnit".into(),
                            value: socket.systemd_unit.unwrap_or_else(|| "unavailable".into()),
                        },
                        BaselineFact {
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
                format!("{unowned} ports have no readable owner. Process details need elevation.")
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

fn filesystems_section(connection: &SavedConnection) -> BaselineSection {
    match remote::list_filesystems(connection) {
        Ok(filesystems) => {
            let entries = filesystems
                .into_iter()
                .map(|filesystem| BaselineEntry {
                    identity: filesystem.mount_point.clone(),
                    label: filesystem.mount_point,
                    facts: vec![
                        BaselineFact {
                            name: "type".into(),
                            value: filesystem.filesystem_type,
                        },
                        BaselineFact {
                            name: "sizeKib".into(),
                            value: filesystem.size_kib.to_string(),
                        },
                        BaselineFact {
                            name: "usedPercent".into(),
                            value: filesystem.used_percent.to_string(),
                        },
                    ],
                })
                .collect();
            let entries: Vec<BaselineEntry> = entries;
            let bounded = entries.len() >= 200;
            section(
                SECTION_FILESYSTEMS,
                if bounded {
                    STATUS_PARTIAL
                } else {
                    STATUS_COLLECTED
                },
                bounded.then(|| "Filesystem evidence reached the 200-mount limit.".into()),
                entries,
            )
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

/// Cron evidence: schedules and a privacy-safe command descriptor per source
/// line. Raw command lines never leave the host — cron commands routinely
/// embed credentials. Only the word count and a SHA-256 command fingerprint
/// leave the host; source line movement does not change a job identity.
fn scheduled_jobs_section(connection: &SavedConnection, elevation: &Elevation) -> BaselineSection {
    match remote::list_cron_jobs(connection, elevation.clone()) {
        Ok(jobs) => {
            let mut occurrences = HashMap::<String, u32>::new();
            let mut entries = jobs
                .jobs
                .iter()
                .map(|job| {
                    let signature = format!(
                        "{}/{}/{}",
                        job.source,
                        job.user,
                        job.fingerprint.as_deref().unwrap_or("unrecorded")
                    );
                    let number = occurrences.entry(signature.clone()).or_default();
                    *number += 1;
                    BaselineEntry {
                        identity: format!("{signature}#{number}"),
                        label: format!("{} line {} · {}", job.source, job.line, job.command),
                        facts: vec![
                            BaselineFact {
                                name: "schedule".into(),
                                value: job.schedule.clone(),
                            },
                            BaselineFact {
                                name: "user".into(),
                                value: job.user.clone(),
                            },
                            BaselineFact {
                                name: "command".into(),
                                value: job.command.clone(),
                            },
                            BaselineFact {
                                name: "commandFingerprint".into(),
                                value: job
                                    .fingerprint
                                    .clone()
                                    .unwrap_or_else(|| "not recorded".into()),
                            },
                        ],
                    }
                })
                .collect::<Vec<_>>();
            entries.sort_by(|left, right| left.identity.cmp(&right.identity));
            let status = if jobs.spool_unreadable || jobs.truncated {
                STATUS_PARTIAL
            } else {
                STATUS_COLLECTED
            };
            let mut message = None;
            if jobs.spool_unreadable {
                message = Some(
                    "Per-user crontabs could not be read by this account. System sources are complete."
                        .to_string(),
                );
            }
            if jobs.truncated {
                let truncation = format!(
                    "The host has more cron entries than Control Room records; kept the first {} of them.",
                    jobs.jobs.len()
                );
                message = Some(match message {
                    Some(existing) => format!("{existing} {truncation}"),
                    None => truncation,
                });
            }
            section(SECTION_SCHEDULED_JOBS, status, message, entries)
        }
        Err(error) => section(
            SECTION_SCHEDULED_JOBS,
            STATUS_UNAVAILABLE,
            Some(error),
            Vec::new(),
        ),
    }
}

/// Package inventories are the largest section on most hosts. The collector
/// bounds itself and says so, rather than freezing the read or silently
/// trimming an honest-looking list.
fn packages_section(connection: &SavedConnection) -> BaselineSection {
    match remote::list_packages(connection) {
        Ok(inventory) => {
            let (name, count) = match inventory.manager.as_str() {
                "dpkg" => ("dpkg", inventory.sources_reported),
                "rpm" => ("rpm", inventory.sources_reported),
                _ => {
                    return section(
                        SECTION_PACKAGES,
                        STATUS_UNSUPPORTED,
                        Some("No dpkg or rpm package database was readable.".into()),
                        Vec::new(),
                    );
                }
            };
            let entries = inventory
                .packages
                .into_iter()
                .map(|package| BaselineEntry {
                    identity: format!("{}:{}", package.name, package.architecture),
                    label: package.name,
                    facts: vec![
                        BaselineFact {
                            name: "architecture".into(),
                            value: package.architecture,
                        },
                        BaselineFact {
                            name: "version".into(),
                            value: package.version,
                        },
                    ],
                })
                .collect::<Vec<_>>();
            let capped = entries.len();
            let status = if inventory.truncated {
                STATUS_PARTIAL
            } else {
                STATUS_COLLECTED
            };
            let message = inventory.truncated.then(|| {
                format!(
                    "{name} reported {count} packages; this capture keeps the first {capped} of them."
                )
            });
            section(SECTION_PACKAGES, status, message, entries)
        }
        Err(error) => {
            let status = if error.contains("no package manager") {
                STATUS_UNSUPPORTED
            } else {
                STATUS_UNAVAILABLE
            };
            section(SECTION_PACKAGES, status, Some(error), Vec::new())
        }
    }
}

fn fact(name: &str, value: Option<String>) -> Option<BaselineFact> {
    value.map(|value| BaselineFact {
        name: name.into(),
        value,
    })
}

pub fn normalize_label(label: Option<String>) -> Option<String> {
    label
        .map(|value| value.trim().chars().take(80).collect::<String>())
        .filter(|value| !value.is_empty())
}

pub fn summarize(baseline: &HostBaseline) -> HostBaselineSummary {
    HostBaselineSummary {
        id: baseline.id.clone(),
        connection_id: baseline.connection_id.clone(),
        label: baseline.label.clone(),
        schema_version: baseline.schema_version,
        captured_at: baseline.captured_at.clone(),
        identity: baseline.identity.clone(),
        pinned: baseline.pinned,
        sections: baseline
            .sections
            .iter()
            .map(|section| BaselineSectionSummary {
                kind: section.kind.clone(),
                status: section.status.clone(),
                entry_count: section.entries.len() as u32,
            })
            .collect(),
        changes_since_previous: None,
        routine_since_previous: None,
    }
}

/// Entries that differ between two captures with a meaningful difference,
/// counting only the sections both sides could read. None when nothing was
/// comparable, so a row can say "not comparable" rather than showing a
/// reassuring zero. Routine fact churn is not part of this count; its own
/// number keeps the visible promise separate from the hidden one.
pub fn total_changes(comparison: &BaselineComparison) -> Option<u32> {
    let comparable: Vec<&BaselineSectionDiff> = comparison
        .sections
        .iter()
        .filter(|section| section.comparable)
        .collect();
    if comparable.is_empty() {
        return None;
    }
    Some(
        comparable
            .iter()
            .map(|section| {
                let changed = section
                    .changed
                    .iter()
                    .filter(|entry| {
                        entry
                            .changes
                            .iter()
                            .any(|change| change.classification == CLASSIFICATION_MEANINGFUL)
                    })
                    .count() as u32;
                (if section.base_status == STATUS_PARTIAL {
                    0
                } else {
                    section.added.len()
                } + if section.removals_indeterminate {
                    0
                } else {
                    section.removed.len()
                }) as u32
                    + changed
            })
            .sum(),
    )
}

/// Routine fact changes the visible count hides, so the timeline can say how
/// much churn it suppressed instead of implying the host stood still.
pub fn total_routine(comparison: &BaselineComparison) -> Option<u32> {
    let comparable: Vec<&BaselineSectionDiff> = comparison
        .sections
        .iter()
        .filter(|section| section.comparable)
        .collect();
    if comparable.is_empty() {
        return None;
    }
    Some(comparable.iter().map(|section| section.routine_count).sum())
}

/// Reads one entry across every capture given, newest first. This answers when
/// a value moved, which two-capture comparison cannot.
pub fn trace_entry(baselines: &[HostBaseline], kind: &str, identity: &str) -> BaselineTrace {
    let mut label = identity.to_string();
    let logical = (kind == SECTION_CONTAINERS)
        .then(|| {
            baselines
                .iter()
                .flat_map(|baseline| &baseline.sections)
                .filter(|section| section.kind == kind)
                .flat_map(|section| &section.entries)
                .find(|entry| entry.identity == identity)
                .and_then(logical_container)
        })
        .flatten();
    let points = baselines
        .iter()
        .map(|baseline| {
            let section = baseline
                .sections
                .iter()
                .find(|section| section.kind == kind);
            let entry = section.and_then(|section| {
                section.entries.iter().find(|entry| {
                    entry.identity == identity
                        || logical
                            .as_ref()
                            .is_some_and(|key| logical_container(entry).as_ref() == Some(key))
                })
            });
            if let Some(entry) = entry {
                label = entry.label.clone();
            }
            BaselineTracePoint {
                baseline_id: baseline.id.clone(),
                label: baseline.label.clone(),
                captured_at: baseline.captured_at.clone(),
                section_status: section
                    .map(|section| section.status.clone())
                    .unwrap_or_else(|| STATUS_SKIPPED.into()),
                present: entry.is_some(),
                facts: entry.map(|entry| entry.facts.clone()).unwrap_or_default(),
            }
        })
        .collect();
    BaselineTrace {
        kind: kind.into(),
        identity: identity.into(),
        label,
        points,
    }
}

/// Compares two captures of the same Saved Connection. The result states what
/// it could not compare instead of implying nothing changed there, and it draws
/// no causal conclusion about why a value moved.
pub fn compare(base: &HostBaseline, target: &HostBaseline) -> BaselineComparison {
    compare_inner(base, target, false)
}

/// Compares a saved capture against state just read from the host. The live
/// read is never stored, so this answers "what has changed since then" without
/// adding a capture the user did not ask to keep.
pub fn compare_with_live(base: &HostBaseline, live: &HostBaseline) -> BaselineComparison {
    compare_inner(base, live, true)
}

fn compare_inner(
    base: &HostBaseline,
    target: &HostBaseline,
    target_is_live: bool,
) -> BaselineComparison {
    let sections = SECTION_KINDS
        .iter()
        .map(|kind| compare_section(kind, base, target))
        .collect();
    BaselineComparison {
        base: summarize(base),
        target: summarize(target),
        identity_match: identity_match(&base.identity, &target.identity).into(),
        // Advisory only: sections compare by their own shape, so a capture
        // written by another whole-capture version still yields every
        // comparison both sides recorded in the same section shape.
        schema_compatible: base.schema_version == target.schema_version,
        target_is_live,
        sections,
    }
}

/// Classifies one fact change. Routine means the fact moves on a healthy
/// host — a restarted container, a busier disk, a recreated ID — never that
/// the change is safe or approved. Every classification is deterministic and
/// explainable, and nothing is deleted to achieve it.
fn classify_fact_change(
    kind: &str,
    name: &str,
    base: Option<&str>,
    target: Option<&str>,
) -> (String, Option<String>) {
    let routine = |reason: &str| (CLASSIFICATION_ROUTINE.to_string(), Some(reason.to_string()));
    match (kind, name) {
        (SECTION_SYSTEMD_UNITS, "subState") => {
            routine("Sub-states move on their own between captures.")
        }
        (SECTION_CONTAINERS, "state") if target != Some("dead") => {
            routine("Container states move on their own between captures.")
        }
        (SECTION_CONTAINERS, "containerId") => routine(
            "Containers get a new ID whenever they are recreated; the workload was matched by name.",
        ),
        (SECTION_FILESYSTEMS, "usedPercent") => {
            // Small swings are a busy disk, not drift: space is meant to move.
            // Only a large swing keeps the fact in the meaningful count.
            let parsed = (
                base.unwrap_or_default().parse::<i32>().ok(),
                target.unwrap_or_default().parse::<i32>().ok(),
            );
            match parsed {
                (Some(base), Some(target)) => {
                    let delta = (base - target).abs();
                    if delta <= ROUTINE_USAGE_DELTA {
                        routine(&format!("Space in use moved from {base}% to {target}%."))
                    } else {
                        (
                            CLASSIFICATION_MEANINGFUL.to_string(),
                            Some(format!("Space in use moved from {base}% to {target}%.")),
                        )
                    }
                }
                _ => (CLASSIFICATION_MEANINGFUL.to_string(), None),
            }
        }
        _ => (
            CLASSIFICATION_MEANINGFUL.to_string(),
            Some(format!("The recorded {name} changed.")),
        ),
    }
}

/// How far disk use can move between two captures before the change is worth
/// a meaningful-difference mention. Above it, a jump is a story worth telling.
const ROUTINE_USAGE_DELTA: i32 = 5;

fn compare_section(kind: &str, base: &HostBaseline, target: &HostBaseline) -> BaselineSectionDiff {
    let base_section = base.sections.iter().find(|section| section.kind == kind);
    let target_section = target.sections.iter().find(|section| section.kind == kind);
    // A section a capture's whole version could not have recorded is that
    // capture's vintage, not a failed read: say so instead of inventing an
    // error. A recorded skipped section is still the user's own choice.
    let base_predates = base_section.is_none() && base.schema_version < section_introduced_in(kind);
    let target_predates =
        target_section.is_none() && target.schema_version < section_introduced_in(kind);
    let base_status = base_section
        .map(|section| section.status.clone())
        .unwrap_or_else(|| {
            if base_predates {
                STATUS_SKIPPED.into()
            } else {
                STATUS_UNAVAILABLE.into()
            }
        });
    let target_status = target_section
        .map(|section| section.status.clone())
        .unwrap_or_else(|| {
            if target_predates {
                STATUS_SKIPPED.into()
            } else {
                STATUS_UNAVAILABLE.into()
            }
        });
    let readable = |status: &str| status == STATUS_COLLECTED || status == STATUS_PARTIAL;
    // Each section carries its own version, so a change to one section's facts
    // never blocks comparison of the sections that did not change. The old
    // whole-capture version check stays advisory on the comparison only.
    let section_schema_compatible = base_section.map(|section| section.schema_version)
        == target_section.map(|section| section.schema_version);
    let comparable =
        section_schema_compatible && readable(&base_status) && readable(&target_status);
    if !comparable {
        return BaselineSectionDiff {
            kind: kind.into(),
            note: Some(incomparable_note(
                section_schema_compatible,
                kind,
                base_predates,
                target_predates,
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
            routine_count: 0,
            removals_indeterminate: false,
        };
    }
    let base_partial = base_status == STATUS_PARTIAL;
    let target_partial = target_status == STATUS_PARTIAL;
    let partial = base_partial || target_partial;
    let duplicate_identities =
        [base_section, target_section]
            .into_iter()
            .flatten()
            .any(|section| {
                let mut seen = std::collections::HashSet::new();
                let mut logical_seen = std::collections::HashSet::new();
                section.entries.iter().any(|entry| {
                    !seen.insert(&entry.identity)
                        || (kind == SECTION_CONTAINERS
                            && logical_container(entry)
                                .is_some_and(|key| !logical_seen.insert(key)))
                })
            });
    if duplicate_identities {
        return BaselineSectionDiff {
            kind: kind.into(),
            base_status,
            target_status,
            comparable: false,
            note: Some(
                "Resource identities are ambiguous; this section cannot be matched reliably."
                    .into(),
            ),
            added: vec![],
            removed: vec![],
            changed: vec![],
            unchanged_count: 0,
            routine_count: 0,
            removals_indeterminate: true,
        };
    }
    let base_entries = index_entries(kind, base_section, target_section);
    let target_entries = index_entries(kind, target_section, base_section);
    let mut added = Vec::new();
    let mut removed = Vec::new();
    let mut changed = Vec::new();
    let mut routine_count = 0u32;
    let mut unchanged_count = 0;
    for (identity, entry) in &target_entries {
        match base_entries.get(identity) {
            None => added.push((*entry).clone()),
            Some(previous) => {
                let changes = compare_facts(kind, previous, entry);
                if changes.is_empty() {
                    unchanged_count += 1;
                } else {
                    routine_count += changes
                        .iter()
                        .filter(|change| change.classification == CLASSIFICATION_ROUTINE)
                        .count() as u32;
                    changed.push(BaselineEntryChange {
                        base_entry: Some((*previous).clone()),
                        target_entry: Some((*entry).clone()),
                        identity: entry.identity.clone(),
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
    BaselineSectionDiff {
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
        routine_count,
        // With a partial read on one side, a resource missing from the other
        // capture is unverified, never confidently removed.
        removals_indeterminate: partial,
    }
}

fn incomparable_note(
    section_schema_compatible: bool,
    kind: &str,
    base_predates: bool,
    target_predates: bool,
    base_status: &str,
    target_status: &str,
) -> String {
    if !section_schema_compatible && !base_predates && !target_predates {
        return "These captures recorded this section in different shapes, so it cannot be compared. Other sections are unaffected."
            .into();
    }
    if base_predates && target_predates {
        return format!("Not comparable: neither capture records the {kind} section.");
    }
    if base_predates {
        return format!(
            "Not comparable: the base capture was saved before Control Room recorded the {kind} section."
        );
    }
    if target_predates {
        return format!(
            "Not comparable: the target capture was saved before Control Room recorded the {kind} section."
        );
    }
    let describe = |status: &str| match status {
        STATUS_UNSUPPORTED => "the subsystem was not present",
        STATUS_SKIPPED => "the section was not captured",
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

fn identity_match(base: &HostIdentity, target: &HostIdentity) -> &'static str {
    match (&base.machine_fingerprint, &target.machine_fingerprint) {
        (Some(left), Some(right)) if left == right => "same",
        (Some(_), Some(_)) => "different",
        _ => "unknown",
    }
}

fn logical_container(entry: &BaselineEntry) -> Option<String> {
    let project = find_fact(entry, "composeProject").filter(|value| value != "none")?;
    let service = find_fact(entry, "composeService").filter(|value| value != "none")?;
    let number = find_fact(entry, "composeContainerNumber")?
        .parse::<u32>()
        .ok()
        .filter(|number| *number > 0)?;
    if find_fact(entry, "composeOneoff").as_deref() != Some("false") {
        return None;
    }
    Some(format!("compose:{project:?}/{service:?}/{number}"))
}

fn index_entries<'a>(
    kind: &str,
    section: Option<&'a BaselineSection>,
    other: Option<&BaselineSection>,
) -> BTreeMap<String, &'a BaselineEntry> {
    section
        .map(|section| {
            section
                .entries
                .iter()
                .map(|entry| {
                    let logical = (kind == SECTION_CONTAINERS)
                        .then(|| logical_container(entry))
                        .flatten();
                    let key = logical
                        .filter(|key| {
                            other.is_some_and(|section| {
                                section
                                    .entries
                                    .iter()
                                    .filter(|other| logical_container(other).as_ref() == Some(key))
                                    .count()
                                    == 1
                            })
                        })
                        .unwrap_or_else(|| entry.identity.clone());
                    (key, entry)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn compare_facts(
    kind: &str,
    base: &BaselineEntry,
    target: &BaselineEntry,
) -> Vec<BaselineFactChange> {
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
            (base_value != target_value).then(|| {
                let (classification, reason) = classify_fact_change(
                    kind,
                    name,
                    base_value.as_deref(),
                    target_value.as_deref(),
                );
                BaselineFactChange {
                    name: name.to_string(),
                    base_value,
                    target_value,
                    classification,
                    reason,
                }
            })
        })
        .collect()
}

fn find_fact(entry: &BaselineEntry, name: &str) -> Option<String> {
    entry
        .facts
        .iter()
        .find(|fact| fact.name == name)
        .map(|fact| fact.value.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(identity: &str, facts: &[(&str, &str)]) -> BaselineEntry {
        BaselineEntry {
            identity: identity.into(),
            label: identity.into(),
            facts: facts
                .iter()
                .map(|(name, value)| BaselineFact {
                    name: (*name).into(),
                    value: (*value).into(),
                })
                .collect(),
        }
    }

    fn baseline(
        id: &str,
        fingerprint: Option<&str>,
        sections: Vec<BaselineSection>,
    ) -> HostBaseline {
        HostBaseline {
            id: id.into(),
            pinned: false,
            connection_id: "connection-a".into(),
            label: None,
            schema_version: BASELINE_SCHEMA_VERSION,
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

    fn units(status: &str, entries: Vec<BaselineEntry>) -> BaselineSection {
        section(SECTION_SYSTEMD_UNITS, status, None, entries)
    }

    fn find(comparison: BaselineComparison, kind: &str) -> BaselineSectionDiff {
        comparison
            .sections
            .into_iter()
            .find(|diff| diff.kind == kind)
            .expect("section diff")
    }

    #[test]
    fn diff_reports_typed_additions_removals_and_modifications() {
        let base = baseline(
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
        let target = baseline(
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
        let base = baseline(
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
        let target = baseline(
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
            vec![BaselineFactChange {
                name: "activeState".into(),
                base_value: Some("active".into()),
                target_value: Some("failed".into()),
                classification: CLASSIFICATION_MEANINGFUL.into(),
                reason: Some("The recorded activeState changed.".into()),
            }]
        );
        assert_eq!(diff.unchanged_count, 0);
    }

    #[test]
    fn a_fact_present_on_only_one_side_is_a_change() {
        let base = baseline(
            "base",
            Some("aaaa"),
            vec![units(STATUS_COLLECTED, vec![entry("nginx.service", &[])])],
        );
        let target = baseline(
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
            vec![BaselineFactChange {
                name: "activeState".into(),
                base_value: None,
                target_value: Some("active".into()),
                classification: CLASSIFICATION_MEANINGFUL.into(),
                reason: Some("The recorded activeState changed.".into()),
            }]
        );
    }

    #[test]
    fn unsupported_and_unavailable_sections_never_look_unchanged() {
        let base = baseline(
            "base",
            Some("aaaa"),
            vec![section(
                SECTION_CONTAINERS,
                STATUS_COLLECTED,
                None,
                vec![entry("api", &[])],
            )],
        );
        let target = baseline(
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
        let base = baseline("base", Some("aaaa"), Vec::new());
        let target = baseline("target", Some("aaaa"), Vec::new());
        let comparison = compare(&base, &target);
        assert_eq!(comparison.sections.len(), SECTION_KINDS.len());
        for diff in &comparison.sections {
            assert!(!diff.comparable);
            assert_eq!(diff.base_status, STATUS_UNAVAILABLE);
        }
    }

    #[test]
    fn a_partial_section_still_compares_but_says_so() {
        let base = baseline(
            "base",
            Some("aaaa"),
            vec![section(
                SECTION_LISTENERS,
                STATUS_PARTIAL,
                Some("2 ports have no readable owner.".into()),
                vec![entry(
                    "tcp/ipv4/0.0.0.0:22",
                    &[("ownership", "unavailable")],
                )],
            )],
        );
        let target = baseline(
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
        let base = baseline("base", Some("aaaa"), Vec::new());
        let same = baseline("same", Some("aaaa"), Vec::new());
        let other = baseline("other", Some("bbbb"), Vec::new());
        let unknown = baseline("unknown", None, Vec::new());
        assert_eq!(compare(&base, &same).identity_match, "same");
        assert_eq!(compare(&base, &other).identity_match, "different");
        assert_eq!(compare(&base, &unknown).identity_match, "unknown");
    }

    #[test]
    fn a_newer_whole_capture_version_still_compares_every_recorded_section() {
        let base = baseline(
            "base",
            Some("aaaa"),
            vec![units(
                STATUS_COLLECTED,
                vec![entry("ssh.service", &[("activeState", "active")])],
            )],
        );
        let mut target = baseline(
            "target",
            Some("aaaa"),
            vec![units(
                STATUS_COLLECTED,
                vec![entry("ssh.service", &[("activeState", "failed")])],
            )],
        );
        target.schema_version = BASELINE_SCHEMA_VERSION + 1;
        let comparison = compare(&base, &target);
        // The whole-capture version is advisory. Older snapshots still yield
        // useful comparisons in every section both captures recorded in the
        // same shape; the property is enforced per section below.
        assert!(!comparison.schema_compatible);
        let units_diff = find(comparison, SECTION_SYSTEMD_UNITS);
        assert!(units_diff.comparable);
        assert_eq!(units_diff.changed.len(), 1);
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
        let registry = BaselineCaptureRegistry::default();
        assert!(registry.cancel("missing").is_err());
        let flag = registry.register("capture-1");
        assert!(registry.cancel("capture-1").is_ok());
        assert!(flag.load(Ordering::SeqCst));
        registry.release("capture-1");
        assert!(registry.cancel("capture-1").is_err());
    }

    #[test]
    fn live_comparison_is_marked_live_and_diffs_the_same_way() {
        let base = baseline(
            "base",
            Some("aaaa"),
            vec![units(
                STATUS_COLLECTED,
                vec![entry("ssh.service", &[("activeState", "active")])],
            )],
        );
        let live = baseline(
            "live",
            Some("aaaa"),
            vec![units(
                STATUS_COLLECTED,
                vec![entry("ssh.service", &[("activeState", "failed")])],
            )],
        );

        let comparison = compare_with_live(&base, &live);

        assert!(comparison.target_is_live);
        assert!(!compare(&base, &live).target_is_live);
        let diff = find(comparison, SECTION_SYSTEMD_UNITS);
        assert_eq!(diff.changed.len(), 1);
        assert_eq!(
            diff.changed[0].changes[0].base_value.as_deref(),
            Some("active")
        );
        assert_eq!(
            diff.changed[0].changes[0].target_value.as_deref(),
            Some("failed")
        );
    }

    #[test]
    fn live_comparison_still_reports_a_mismatched_machine_identity() {
        let base = baseline(
            "base",
            Some("aaaa"),
            vec![units(STATUS_COLLECTED, Vec::new())],
        );
        let live = baseline(
            "live",
            Some("bbbb"),
            vec![units(STATUS_COLLECTED, Vec::new())],
        );

        assert_eq!(compare_with_live(&base, &live).identity_match, "different");
    }

    #[test]
    fn a_section_only_blocks_comparison_for_its_own_schema_change() {
        let mut base = baseline(
            "base",
            Some("aaaa"),
            vec![
                units(
                    STATUS_COLLECTED,
                    vec![entry("ssh.service", &[("activeState", "active")])],
                ),
                section(SECTION_CONTAINERS, STATUS_COLLECTED, None, Vec::new()),
            ],
        );
        let target = baseline(
            "target",
            Some("aaaa"),
            vec![
                units(
                    STATUS_COLLECTED,
                    vec![entry("ssh.service", &[("activeState", "failed")])],
                ),
                section(SECTION_CONTAINERS, STATUS_COLLECTED, None, Vec::new()),
            ],
        );
        base.sections[1].schema_version = 9;

        let comparison = compare(&base, &target);

        assert!(!find(comparison.clone(), SECTION_CONTAINERS).comparable);
        let units_diff = find(comparison, SECTION_SYSTEMD_UNITS);
        assert!(units_diff.comparable);
        assert_eq!(units_diff.changed.len(), 1);
    }

    #[test]
    fn a_skipped_section_is_never_reported_as_unchanged() {
        let base = baseline(
            "base",
            Some("aaaa"),
            vec![units(STATUS_COLLECTED, vec![entry("ssh.service", &[])])],
        );
        let target = baseline(
            "target",
            Some("aaaa"),
            vec![skipped_section(
                SECTION_SYSTEMD_UNITS,
                "This section was not part of the capture.",
            )],
        );

        let diff = find(compare(&base, &target), SECTION_SYSTEMD_UNITS);

        assert!(!diff.comparable);
        assert_eq!(diff.unchanged_count, 0);
        assert!(diff.note.unwrap().contains("was not captured"));
    }

    #[test]
    fn a_selection_keeps_every_section_and_marks_the_rest_skipped() {
        assert_eq!(
            resolve_selection(Some(&["listeners".to_string(), "listeners".to_string()])).unwrap(),
            vec![SECTION_LISTENERS]
        );
        assert!(resolve_selection(Some(&[])).is_err());
        assert!(resolve_selection(Some(&["nope".to_string()])).is_err());
        assert_eq!(resolve_selection(None).unwrap(), SECTION_KINDS.to_vec());
    }

    #[test]
    fn total_changes_says_nothing_rather_than_zero_when_no_section_compared() {
        let base = baseline(
            "base",
            Some("aaaa"),
            vec![units(STATUS_UNAVAILABLE, Vec::new())],
        );
        let target = baseline(
            "target",
            Some("aaaa"),
            vec![units(STATUS_UNAVAILABLE, Vec::new())],
        );
        assert_eq!(total_changes(&compare(&base, &target)), None);
        assert_eq!(total_routine(&compare(&base, &target)), None);

        let readable = baseline(
            "readable",
            Some("aaaa"),
            vec![units(STATUS_COLLECTED, vec![entry("ssh.service", &[])])],
        );
        assert_eq!(total_changes(&compare(&readable, &readable)), Some(0));
        assert_eq!(total_routine(&compare(&readable, &readable)), Some(0));
    }

    #[test]
    fn routine_facts_are_explained_not_hidden() {
        let base = baseline(
            "base",
            Some("aaaa"),
            vec![section(
                SECTION_SYSTEMD_UNITS,
                STATUS_COLLECTED,
                None,
                vec![entry(
                    "nginx.service",
                    &[("subState", "running"), ("unitFileState", "enabled")],
                )],
            )],
        );
        let target = baseline(
            "target",
            Some("aaaa"),
            vec![section(
                SECTION_SYSTEMD_UNITS,
                STATUS_COLLECTED,
                None,
                vec![entry(
                    "nginx.service",
                    &[("subState", "dead"), ("unitFileState", "disabled")],
                )],
            )],
        );
        let diff = find(compare(&base, &target), SECTION_SYSTEMD_UNITS);
        assert_eq!(diff.changed.len(), 1);
        let sub_state = &diff.changed[0].changes[0];
        assert_eq!(sub_state.name, "subState");
        assert_eq!(sub_state.classification, CLASSIFICATION_ROUTINE);
        assert!(sub_state.reason.as_deref().is_some());
        let enablement = &diff.changed[0].changes[1];
        assert_eq!(enablement.name, "unitFileState");
        assert_eq!(enablement.classification, CLASSIFICATION_MEANINGFUL);
        assert_eq!(diff.routine_count, 1);
    }

    #[test]
    fn routine_only_entries_leave_the_meaningful_count_but_stay_counted() {
        let base = baseline(
            "base",
            Some("aaaa"),
            vec![
                section(
                    SECTION_SYSTEMD_UNITS,
                    STATUS_COLLECTED,
                    None,
                    vec![entry("nginx.service", &[("subState", "running")])],
                ),
                section(
                    SECTION_CONTAINERS,
                    STATUS_COLLECTED,
                    None,
                    vec![entry("api", &[("image", "nginx:1")])],
                ),
            ],
        );
        let target = baseline(
            "target",
            Some("aaaa"),
            vec![
                section(
                    SECTION_SYSTEMD_UNITS,
                    STATUS_COLLECTED,
                    None,
                    vec![entry("nginx.service", &[("subState", "dead")])],
                ),
                section(
                    SECTION_CONTAINERS,
                    STATUS_COLLECTED,
                    None,
                    vec![entry("api", &[("image", "nginx:2")])],
                ),
            ],
        );
        let comparison = compare(&base, &target);
        // The unit sub-state churn is routine on its own, so it is reported as
        // hidden routine churn rather than a meaningful change; the image tag
        // change is meaningful.
        assert_eq!(total_changes(&comparison), Some(1));
        assert_eq!(total_routine(&comparison), Some(1));
        let units_diff = find(comparison.clone(), SECTION_SYSTEMD_UNITS);
        assert_eq!(units_diff.changed.len(), 1);
        assert_eq!(units_diff.routine_count, 1);
    }

    #[test]
    fn container_recreation_is_routine_but_the_image_is_meaningful() {
        let base = baseline(
            "base",
            Some("aaaa"),
            vec![section(
                SECTION_CONTAINERS,
                STATUS_COLLECTED,
                None,
                vec![entry(
                    "api",
                    &[
                        ("containerId", "1111"),
                        ("image", "api:1"),
                        ("state", "running"),
                    ],
                )],
            )],
        );
        let target = baseline(
            "target",
            Some("aaaa"),
            vec![section(
                SECTION_CONTAINERS,
                STATUS_COLLECTED,
                None,
                vec![entry(
                    "api",
                    &[
                        ("containerId", "2222"),
                        ("image", "api:2"),
                        ("state", "exited"),
                    ],
                )],
            )],
        );
        let diff = find(compare(&base, &target), SECTION_CONTAINERS);
        let classifications: Vec<&str> = diff.changed[0]
            .changes
            .iter()
            .map(|change| change.classification.as_str())
            .collect();
        assert_eq!(classifications, vec!["routine", "meaningful", "routine"]);
        assert_eq!(diff.routine_count, 2);
    }

    #[test]
    fn compose_replica_recreation_matches_without_losing_legacy_name_matching() {
        let facts = [
            ("composeProject", "demo"),
            ("composeService", "web"),
            ("composeContainerNumber", "1"),
            ("composeOneoff", "false"),
            ("containerId", "old"),
        ];
        let old = entry("old-name", &facts);
        let mut new = old.clone();
        new.identity = "new-name".into();
        new.label = "new-name".into();
        new.facts.last_mut().unwrap().value = "new".into();
        let base = baseline(
            "base",
            Some("a"),
            vec![section(
                SECTION_CONTAINERS,
                STATUS_COLLECTED,
                None,
                vec![old],
            )],
        );
        let target = baseline(
            "target",
            Some("a"),
            vec![section(
                SECTION_CONTAINERS,
                STATUS_COLLECTED,
                None,
                vec![new],
            )],
        );
        let diff = find(compare(&base, &target), SECTION_CONTAINERS);
        assert!(diff.added.is_empty() && diff.removed.is_empty());
        assert_eq!(diff.changed[0].identity, "new-name");
        assert_eq!(diff.routine_count, 1);
        let trace = trace_entry(&[target, base], SECTION_CONTAINERS, "new-name");
        assert!(trace.points.iter().all(|point| point.present));
    }

    #[test]
    fn small_disk_moves_are_routine_and_large_moves_are_meaningful() {
        let moved = |base: &str, target: &str| {
            let section_kind = SECTION_FILESYSTEMS;
            let base = baseline(
                "base",
                Some("aaaa"),
                vec![section(
                    section_kind,
                    STATUS_COLLECTED,
                    None,
                    vec![entry("/", &[("usedPercent", base)])],
                )],
            );
            let target = baseline(
                "target",
                Some("aaaa"),
                vec![section(
                    section_kind,
                    STATUS_COLLECTED,
                    None,
                    vec![entry("/", &[("usedPercent", target)])],
                )],
            );
            find(compare(&base, &target), SECTION_FILESYSTEMS).changed[0].changes[0].clone()
        };
        let churn = moved("31", "32");
        assert_eq!(churn.classification, CLASSIFICATION_ROUTINE);
        assert!(churn.reason.as_deref().unwrap().contains("31% to 32%"));
        assert_eq!(moved("31", "42").classification, CLASSIFICATION_MEANINGFUL);
        let surge = moved("12", "94");
        assert_eq!(surge.classification, CLASSIFICATION_MEANINGFUL);
        assert!(surge.reason.as_deref().unwrap().contains("12% to 94%"));
    }

    #[test]
    fn changed_resources_carry_exact_recorded_evidence() {
        let base = baseline(
            "base",
            Some("a"),
            vec![units(
                STATUS_COLLECTED,
                vec![entry(
                    "ssh.service",
                    &[("activeState", "active"), ("unitFileState", "enabled")],
                )],
            )],
        );
        let target = baseline(
            "target",
            Some("a"),
            vec![units(
                STATUS_COLLECTED,
                vec![entry(
                    "ssh.service",
                    &[("activeState", "failed"), ("unitFileState", "enabled")],
                )],
            )],
        );
        let diff = find(compare(&base, &target), SECTION_SYSTEMD_UNITS);
        assert_eq!(
            diff.changed[0].target_entry.as_ref().unwrap().facts.len(),
            2
        );
        assert!(diff.changed[0].changes[0].reason.is_some());
    }

    #[test]
    fn duplicate_resources_are_ambiguous_not_silently_coalesced() {
        let sample = baseline(
            "sample",
            Some("a"),
            vec![units(
                STATUS_COLLECTED,
                vec![entry("same", &[]), entry("same", &[])],
            )],
        );
        let diff = find(compare(&sample, &sample), SECTION_SYSTEMD_UNITS);
        assert!(!diff.comparable);
        assert!(diff.note.unwrap().contains("ambiguous"));
    }

    #[test]
    fn a_partial_side_never_asserts_confident_removal() {
        let base = baseline(
            "base",
            Some("aaaa"),
            vec![section(
                SECTION_LISTENERS,
                STATUS_COLLECTED,
                None,
                vec![entry("tcp/ipv4/0.0.0.0:80", &[("process", "nginx")])],
            )],
        );
        let target = baseline(
            "target",
            Some("aaaa"),
            vec![section(SECTION_LISTENERS, STATUS_PARTIAL, None, Vec::new())],
        );
        let diff = find(compare(&base, &target), SECTION_LISTENERS);
        assert!(diff.comparable);
        assert_eq!(diff.removed.len(), 1);
        // The removal is evidence, but a partial read cannot assert the
        // resource is gone: the comparison says the removal is unverified.
        assert!(diff.removals_indeterminate);
        let clean = find(compare(&base, &base), SECTION_LISTENERS);
        assert!(!clean.removals_indeterminate);
    }

    #[test]
    fn a_legacy_capture_never_records_sections_it_predates() {
        let mut legacy = baseline(
            "legacy",
            Some("aaaa"),
            vec![units(STATUS_COLLECTED, vec![entry("ssh.service", &[])])],
        );
        legacy.schema_version = 1;
        let mut current = baseline(
            "current",
            Some("aaaa"),
            vec![units(STATUS_COLLECTED, vec![entry("ssh.service", &[])])],
        );
        current.schema_version = BASELINE_SCHEMA_VERSION;
        let comparison = compare(&legacy, &current);
        // Every capture reports every section, so the timeline can trust the
        // shape, and the legacy side says which sections it predates.
        let added_sections = comparison
            .sections
            .iter()
            .filter(|diff| {
                diff.kind == SECTION_FIREWALL
                    || diff.kind == SECTION_SCHEDULED_JOBS
                    || diff.kind == SECTION_PACKAGES
            })
            .count();
        assert_eq!(added_sections, 3);
        let firewall = find(comparison.clone(), SECTION_FIREWALL);
        assert!(!firewall.comparable);
        assert_eq!(firewall.base_status, STATUS_SKIPPED);
        assert!(
            firewall
                .note
                .as_deref()
                .unwrap()
                .contains("before Control Room recorded")
        );
        // The section both captures recorded still compares.
        assert!(find(comparison, SECTION_SYSTEMD_UNITS).comparable);
    }

    #[test]
    fn tracing_one_entry_reads_every_capture_and_marks_the_ones_missing_it() {
        let newest = baseline(
            "newest",
            Some("aaaa"),
            vec![units(
                STATUS_COLLECTED,
                vec![entry("ssh.service", &[("activeState", "failed")])],
            )],
        );
        let middle = baseline(
            "middle",
            Some("aaaa"),
            vec![units(STATUS_COLLECTED, Vec::new())],
        );
        let oldest = baseline(
            "oldest",
            Some("aaaa"),
            vec![skipped_section(SECTION_SYSTEMD_UNITS, "not captured")],
        );

        let trace = trace_entry(
            &[newest, middle, oldest],
            SECTION_SYSTEMD_UNITS,
            "ssh.service",
        );

        assert_eq!(trace.label, "ssh.service");
        assert_eq!(trace.points.len(), 3);
        assert!(trace.points[0].present);
        assert_eq!(trace.points[0].facts[0].value, "failed");
        assert!(!trace.points[1].present);
        assert_eq!(trace.points[1].section_status, STATUS_COLLECTED);
        assert!(!trace.points[2].present);
        assert_eq!(trace.points[2].section_status, STATUS_SKIPPED);
    }

    #[test]
    fn capture_is_explicit_and_never_scheduled() {
        let source = include_str!("baselines.rs");
        assert!(!source.contains(concat!("thread", "::spawn")));
        assert!(!source.contains(concat!("set", "_interval")));
        assert!(!source.contains(concat!("sleep", "(")));
    }
}
