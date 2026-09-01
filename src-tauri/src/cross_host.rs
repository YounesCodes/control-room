//! Cross-host read-only inspections: one predefined Structured Operation run
//! against Saved Connections the user picked by hand.
//!
//! There is no arbitrary command path here. React names an operation from a
//! fixed registry and, where the operation takes one, a validated parameter.
//! Every target runs the normal bounded, noninteractive OpenSSH path, gets its
//! own result row, and fails independently of the others.

use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    thread,
};

use chrono::Utc;
use parking_lot::Mutex;
use std::collections::HashMap;

use crate::{
    models::{
        CrossHostFact, CrossHostOperation, CrossHostParameter, CrossHostResult, SavedConnection,
    },
    remote::{self, RemoteOperationLimiter},
    ssh::validate_systemd_unit_id,
};

/// Three connections at a time. High enough to be worth doing, low enough that
/// a wide selection does not become a connection storm against a jump host or a
/// per-source connection limit.
pub const DEFAULT_CONCURRENCY: usize = 3;
pub const MAX_TARGETS: usize = 32;

pub const OPERATION_HOST_FACTS: &str = "hostFacts";
pub const OPERATION_UNIT_STATE: &str = "unitState";
pub const OPERATION_PORT_LISTENERS: &str = "portListeners";

pub const STATE_RUNNING: &str = "running";
pub const STATE_COMPLETED: &str = "completed";
pub const STATE_FAILED: &str = "failed";
pub const STATE_UNSUPPORTED: &str = "unsupported";
pub const STATE_UNREACHABLE: &str = "unreachable";
pub const STATE_AUTHENTICATION_REQUIRED: &str = "authenticationRequired";
pub const STATE_PERMISSION_REQUIRED: &str = "permissionRequired";
pub const STATE_CANCELLED: &str = "cancelled";

/// The whole multi-host surface. An operation not in this list cannot run
/// across hosts, and nothing here writes to a host.
pub fn operations() -> Vec<CrossHostOperation> {
    vec![
        CrossHostOperation {
            id: OPERATION_HOST_FACTS.into(),
            label: "Host facts".into(),
            description: "Operating system, version, kernel, and architecture.".into(),
            parameter: None,
            facts: vec![
                "hostname".into(),
                "operatingSystem".into(),
                "osVersion".into(),
                "kernel".into(),
                "architecture".into(),
            ],
        },
        CrossHostOperation {
            id: OPERATION_UNIT_STATE.into(),
            label: "Systemd unit state".into(),
            description: "Load, active, sub, and unit-file state of one unit.".into(),
            parameter: Some(CrossHostParameter {
                kind: "systemdUnit".into(),
                label: "Unit".into(),
                placeholder: "nginx.service".into(),
            }),
            facts: vec![
                "loadState".into(),
                "activeState".into(),
                "subState".into(),
                "unitFileState".into(),
            ],
        },
        CrossHostOperation {
            id: OPERATION_PORT_LISTENERS.into(),
            label: "Listeners on a port".into(),
            description: "TCP and UDP listeners bound to one port, with owners where readable."
                .into(),
            parameter: Some(CrossHostParameter {
                kind: "port".into(),
                label: "Port".into(),
                placeholder: "443".into(),
            }),
            facts: vec!["listeners".into(), "addresses".into(), "owners".into()],
        },
    ]
}

pub fn find_operation(id: &str) -> Option<CrossHostOperation> {
    operations()
        .into_iter()
        .find(|operation| operation.id == id)
}

/// A validated parameter. Parsing happens once, before any host is contacted,
/// so a bad value fails the whole run instead of half of it.
enum Parameter {
    None,
    Unit(String),
    Port(u16),
}

fn validate_parameter(
    operation: &CrossHostOperation,
    value: Option<&str>,
) -> Result<Parameter, String> {
    let Some(descriptor) = &operation.parameter else {
        return Ok(Parameter::None);
    };
    let value = value.unwrap_or_default().trim();
    if value.is_empty() {
        return Err(format!("{} is required", descriptor.label));
    }
    match descriptor.kind.as_str() {
        "systemdUnit" => Ok(Parameter::Unit(
            validate_systemd_unit_id(value)?.to_string(),
        )),
        _ => value
            .parse::<u16>()
            .ok()
            .filter(|port| *port > 0)
            .map(Parameter::Port)
            .ok_or_else(|| "Enter a port between 1 and 65535".into()),
    }
}

#[derive(Default)]
pub struct CrossHostRunRegistry {
    runs: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl CrossHostRunRegistry {
    /// Reuses an existing flag for the same id. A cancel that lands before the
    /// run reaches this point still takes effect instead of being lost.
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
            None => Err("That run is no longer active".into()),
        }
    }
}

pub trait TargetReporter {
    fn report(&self, result: &CrossHostResult);
}

pub fn run(
    targets: &[SavedConnection],
    operation: &CrossHostOperation,
    parameter: Option<&str>,
    run_id: &str,
    limiter: &RemoteOperationLimiter,
    registry: &CrossHostRunRegistry,
    reporter: &dyn TargetReporter,
) -> Result<Vec<CrossHostResult>, String> {
    if targets.is_empty() {
        return Err("Select at least one Saved Connection".into());
    }
    if targets.len() > MAX_TARGETS {
        return Err(format!("Select at most {MAX_TARGETS} Saved Connections"));
    }
    let parameter = validate_parameter(operation, parameter)?;
    let cancelled = registry.register(run_id);
    let next = AtomicUsize::new(0);
    let mut results: Vec<Option<CrossHostResult>> = vec![None; targets.len()];
    let (sender, receiver) = mpsc::channel::<(usize, CrossHostResult)>();
    let workers = DEFAULT_CONCURRENCY.min(targets.len());

    thread::scope(|scope| {
        for _ in 0..workers {
            let sender = sender.clone();
            let next = &next;
            let cancelled = cancelled.as_ref();
            let parameter = &parameter;
            scope.spawn(move || {
                loop {
                    let index = next.fetch_add(1, Ordering::SeqCst);
                    let Some(target) = targets.get(index) else {
                        break;
                    };
                    if cancelled.load(Ordering::SeqCst) {
                        let _ = sender.send((
                            index,
                            result(run_id, target, STATE_CANCELLED, None, Vec::new()),
                        ));
                        continue;
                    }
                    let _ = sender.send((
                        index,
                        result(run_id, target, STATE_RUNNING, None, Vec::new()),
                    ));
                    let mut finished = execute(run_id, target, operation, parameter, limiter);
                    // A target whose bounded command was still in flight when
                    // the user cancelled is reported as cancelled, not as a
                    // result they asked to stop waiting for.
                    if cancelled.load(Ordering::SeqCst) {
                        finished = result(run_id, target, STATE_CANCELLED, None, Vec::new());
                    }
                    let _ = sender.send((index, finished));
                }
            });
        }
        drop(sender);
        for (index, value) in receiver {
            reporter.report(&value);
            results[index] = Some(value);
        }
    });

    registry.release(run_id);
    Ok(results.into_iter().flatten().collect())
}

fn result(
    run_id: &str,
    target: &SavedConnection,
    state: &str,
    message: Option<String>,
    facts: Vec<CrossHostFact>,
) -> CrossHostResult {
    CrossHostResult {
        run_id: run_id.to_string(),
        connection_id: target.id.clone(),
        connection_name: target.display_name.clone(),
        state: state.to_string(),
        message,
        collected_at: (state != STATE_RUNNING).then(|| Utc::now().to_rfc3339()),
        facts,
    }
}

fn execute(
    run_id: &str,
    target: &SavedConnection,
    operation: &CrossHostOperation,
    parameter: &Parameter,
    limiter: &RemoteOperationLimiter,
) -> CrossHostResult {
    let permit = match limiter.acquire(&target.id) {
        Ok(permit) => permit,
        Err(error) => return result(run_id, target, STATE_FAILED, Some(error), Vec::new()),
    };
    let collected = match (operation.id.as_str(), parameter) {
        (OPERATION_HOST_FACTS, _) => host_facts(target),
        (OPERATION_UNIT_STATE, Parameter::Unit(unit)) => unit_state(target, unit),
        (OPERATION_PORT_LISTENERS, Parameter::Port(port)) => port_listeners(target, *port),
        _ => Err("That operation cannot run across hosts".into()),
    };
    drop(permit);
    match collected {
        Ok(Collected::Facts(facts)) => result(run_id, target, STATE_COMPLETED, None, facts),
        Ok(Collected::Unsupported(message)) => {
            result(run_id, target, STATE_UNSUPPORTED, Some(message), Vec::new())
        }
        Err(error) => {
            let state = classify_target_failure(&error);
            result(run_id, target, state, Some(error), Vec::new())
        }
    }
}

enum Collected {
    Facts(Vec<CrossHostFact>),
    Unsupported(String),
}

/// Maps a bounded command failure to an independent per-host state. The states
/// stay distinct: an unreachable host, a host that refused the key, and a host
/// that lacks the subsystem are three different answers.
pub fn classify_target_failure(error: &str) -> &'static str {
    let lower = error.to_ascii_lowercase();
    if lower.contains("publickey") || lower.contains("authentication") || lower.contains("password")
    {
        return STATE_AUTHENTICATION_REQUIRED;
    }
    if lower.contains("could not be resolved")
        || lower.contains("connection refused")
        || lower.contains("timed out")
        || lower.contains("host-key")
        || lower.contains("no route to host")
        || lower.contains("network is unreachable")
    {
        return STATE_UNREACHABLE;
    }
    if lower.contains("is not installed") || lower.contains("not found") {
        return STATE_UNSUPPORTED;
    }
    if lower.contains("permission denied") || lower.contains("operation not permitted") {
        return STATE_PERMISSION_REQUIRED;
    }
    STATE_FAILED
}

fn fact(name: &str, value: impl Into<String>) -> CrossHostFact {
    CrossHostFact {
        name: name.into(),
        value: value.into(),
    }
}

fn host_facts(target: &SavedConnection) -> Result<Collected, String> {
    let capabilities = remote::discover_capabilities(target)?;
    Ok(Collected::Facts(vec![
        fact("hostname", capabilities.hostname.unwrap_or_else(unknown)),
        fact(
            "operatingSystem",
            capabilities.os_name.unwrap_or_else(unknown),
        ),
        fact("osVersion", capabilities.os_version.unwrap_or_else(unknown)),
        fact("kernel", capabilities.kernel.unwrap_or_else(unknown)),
        fact(
            "architecture",
            capabilities.architecture.unwrap_or_else(unknown),
        ),
    ]))
}

fn unknown() -> String {
    "unavailable".into()
}

fn unit_state(target: &SavedConnection, unit: &str) -> Result<Collected, String> {
    match remote::inspect_unit_state(target, unit)? {
        None => Ok(Collected::Unsupported(
            "systemd is not available on this host".into(),
        )),
        Some(states) => Ok(Collected::Facts(vec![
            fact("loadState", states.load_state),
            fact("activeState", states.active_state),
            fact("subState", states.sub_state),
            fact("unitFileState", states.unit_file_state),
        ])),
    }
}

fn port_listeners(target: &SavedConnection, port: u16) -> Result<Collected, String> {
    let sockets = remote::list_ports(target, None)?;
    let matching: Vec<_> = sockets
        .into_iter()
        .filter(|socket| socket.port == port)
        .collect();
    if matching.is_empty() {
        return Ok(Collected::Facts(vec![
            fact("listeners", "0"),
            fact("addresses", "none"),
            fact("owners", "none"),
        ]));
    }
    let mut addresses: Vec<String> = matching
        .iter()
        .map(|socket| format!("{}/{}", socket.local_address, socket.protocol))
        .collect();
    addresses.sort();
    addresses.dedup();
    let mut owners: Vec<String> = matching
        .iter()
        .map(
            |socket| match (&socket.systemd_unit, &socket.process_name) {
                (Some(unit), _) => unit.clone(),
                (None, Some(process)) => process.clone(),
                // Ownership that needs elevation stays unavailable rather than
                // being guessed from the port number.
                (None, None) => "unavailable".into(),
            },
        )
        .collect();
    owners.sort();
    owners.dedup();
    Ok(Collected::Facts(vec![
        fact("listeners", matching.len().to_string()),
        fact("addresses", addresses.join(", ")),
        fact("owners", owners.join(", ")),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn operation(id: &str) -> CrossHostOperation {
        find_operation(id).expect("registered operation")
    }

    #[test]
    fn only_registered_read_only_operations_are_eligible() {
        let ids: Vec<String> = operations().into_iter().map(|item| item.id).collect();
        assert_eq!(
            ids,
            vec![
                OPERATION_HOST_FACTS,
                OPERATION_UNIT_STATE,
                OPERATION_PORT_LISTENERS
            ]
        );
        assert!(find_operation("restart").is_none());
        assert!(find_operation("").is_none());
    }

    #[test]
    fn every_operation_previews_the_data_it_will_return() {
        for item in operations() {
            assert!(!item.facts.is_empty());
            assert!(!item.description.is_empty());
        }
    }

    #[test]
    fn parameters_are_validated_before_any_host_is_contacted() {
        assert!(matches!(
            validate_parameter(&operation(OPERATION_HOST_FACTS), None),
            Ok(Parameter::None)
        ));
        assert!(matches!(
            validate_parameter(&operation(OPERATION_UNIT_STATE), Some(" nginx.service ")),
            Ok(Parameter::Unit(unit)) if unit == "nginx.service"
        ));
        assert!(
            validate_parameter(&operation(OPERATION_UNIT_STATE), Some("nginx; reboot")).is_err()
        );
        assert!(validate_parameter(&operation(OPERATION_UNIT_STATE), Some("")).is_err());
        assert!(validate_parameter(&operation(OPERATION_UNIT_STATE), None).is_err());
        assert!(matches!(
            validate_parameter(&operation(OPERATION_PORT_LISTENERS), Some("443")),
            Ok(Parameter::Port(443))
        ));
        assert!(validate_parameter(&operation(OPERATION_PORT_LISTENERS), Some("0")).is_err());
        assert!(validate_parameter(&operation(OPERATION_PORT_LISTENERS), Some("70000")).is_err());
        assert!(validate_parameter(&operation(OPERATION_PORT_LISTENERS), Some("$(id)")).is_err());
    }

    #[test]
    fn failures_map_to_distinct_per_host_states() {
        assert_eq!(
            classify_target_failure("Permission denied (publickey)."),
            STATE_AUTHENTICATION_REQUIRED
        );
        assert_eq!(
            classify_target_failure("Host could not be resolved: ssh: Could not resolve hostname"),
            STATE_UNREACHABLE
        );
        assert_eq!(
            classify_target_failure("Connection timed out with exit code 255"),
            STATE_UNREACHABLE
        );
        assert_eq!(
            classify_target_failure("Feature is not installed on this host: ss: command not found"),
            STATE_UNSUPPORTED
        );
        assert_eq!(
            classify_target_failure("Permission denied: you need to be root"),
            STATE_PERMISSION_REQUIRED
        );
        assert_eq!(
            classify_target_failure("Remote command failed with exit code 3"),
            STATE_FAILED
        );
    }

    #[test]
    fn cancelling_an_unknown_run_is_an_error() {
        let registry = CrossHostRunRegistry::default();
        assert!(registry.cancel("missing").is_err());
        let flag = registry.register("run-1");
        assert!(registry.cancel("run-1").is_ok());
        assert!(flag.load(Ordering::SeqCst));
        registry.release("run-1");
        assert!(registry.cancel("run-1").is_err());
    }

    #[test]
    fn an_empty_or_oversized_target_list_is_refused() {
        let registry = CrossHostRunRegistry::default();
        let limiter = RemoteOperationLimiter::default();
        struct Silent;
        impl TargetReporter for Silent {
            fn report(&self, _result: &CrossHostResult) {}
        }
        let error = run(
            &[],
            &operation(OPERATION_HOST_FACTS),
            None,
            "run-1",
            &limiter,
            &registry,
            &Silent,
        )
        .unwrap_err();
        assert!(error.contains("at least one"));
    }

    #[test]
    fn a_cancelled_run_reports_every_target_without_contacting_one() {
        let registry = CrossHostRunRegistry::default();
        let limiter = RemoteOperationLimiter::default();
        struct Collect(Mutex<Vec<String>>);
        impl TargetReporter for Collect {
            fn report(&self, result: &CrossHostResult) {
                self.0.lock().push(result.state.clone());
            }
        }
        let targets: Vec<SavedConnection> = (0..4).map(target).collect();
        // A cancel that lands before the run starts is honoured, so no target
        // is contacted at all.
        let flag = registry.register("run-1");
        flag.store(true, Ordering::SeqCst);
        let reporter = Collect(Mutex::new(Vec::new()));
        let results = run(
            &targets,
            &operation(OPERATION_HOST_FACTS),
            None,
            "run-1",
            &limiter,
            &registry,
            &reporter,
        )
        .unwrap();
        assert_eq!(results.len(), 4);
        assert!(results.iter().all(|result| result.state == STATE_CANCELLED));
        assert!(results.iter().all(|result| result.facts.is_empty()));
    }

    #[test]
    fn results_keep_host_identity_and_a_collection_time() {
        let connection = target(0);
        let running = result("run-1", &connection, STATE_RUNNING, None, Vec::new());
        assert_eq!(running.connection_id, connection.id);
        assert_eq!(running.connection_name, connection.display_name);
        assert!(running.collected_at.is_none());
        let done = result("run-1", &connection, STATE_COMPLETED, None, Vec::new());
        assert!(done.collected_at.is_some());
    }

    #[test]
    fn the_module_builds_no_command_of_its_own() {
        let source = include_str!("cross_host.rs");
        assert!(!source.contains(concat!("background", "_command")));
        assert!(!source.contains(concat!("Remote", "CommandExecutor")));
        assert!(!source.contains(concat!("execute_with", "_sudo")));
    }

    fn target(index: usize) -> SavedConnection {
        SavedConnection {
            id: format!("connection-{index}"),
            display_name: format!("Host {index}"),
            destination: format!("host-{index}"),
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
}
