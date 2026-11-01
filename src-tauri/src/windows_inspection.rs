use crate::{
    models::{
        DockerContainer, DockerContainerDetails, EstablishedConnections, FirewallStatus,
        HeaderMetric, HeaderMetrics, ListeningSocket, SavedConnection,
    },
    remote::{self, RemoteCommandExecutor},
    ssh::validate_container_id,
    windows_ssh::powershell_command,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowsService {
    pub id: String,
    pub display_name: String,
    pub description: Option<String>,
    pub state: String,
    pub start_mode: String,
    pub process_id: Option<u32>,
}

fn script(operation: &str, extra: &str) -> String {
    format!(
        "$operation='{operation}'; {extra}\n{}",
        include_str!("windows_inspection.ps1")
    )
}
fn read(
    connection: &SavedConnection,
    operation: &'static str,
    extra: &str,
) -> Result<String, String> {
    RemoteCommandExecutor::execute_with_input(
        connection,
        operation,
        &powershell_command(
            "$script=[Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($script))",
        ),
        script(operation, extra).as_bytes(),
    )?
    .success_text()
}
fn parse<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, String> {
    serde_json::from_str(text.trim_start_matches('\u{feff}').trim())
        .map_err(|error| format!("Windows inspection returned invalid data: {error}"))
}
pub fn diagnostics(
    connection: &SavedConnection,
    workloads: bool,
) -> Result<crate::diagnostics::Diagnostics, String> {
    let script = format!(
        "$overviewWorkloads=${};\n{}",
        if workloads { "true" } else { "false" },
        include_str!("diagnostics.ps1")
    );
    let text = RemoteCommandExecutor::execute_with_input(
        connection,
        "overview_diagnostics",
        &powershell_command(
            "$script=[Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($script))",
        ),
        script.as_bytes(),
    )?
    .success_text()?;
    parse_diagnostics(&text)
}
fn parse_diagnostics(text: &str) -> Result<crate::diagnostics::Diagnostics, String> {
    let mut result: crate::diagnostics::Diagnostics = parse(text)?;
    // Match Linux and header timestamps. Remote wall-clock skew must not make
    // a new reading stale or keep a future-dated reading live indefinitely.
    result.sampled_at = Utc::now().to_rfc3339();
    if let Some(workloads) = result.workloads.as_mut() {
        workloads.collected_at = result.sampled_at.clone();
    }
    Ok(result)
}
pub fn ports(connection: &SavedConnection) -> Result<Vec<ListeningSocket>, String> {
    parse(&read(connection, "ports", "")?)
}
pub fn connections(connection: &SavedConnection) -> Result<EstablishedConnections, String> {
    parse(&read(connection, "connections", "")?)
}
pub fn services(connection: &SavedConnection) -> Result<Vec<WindowsService>, String> {
    parse(&read(connection, "services", "")?)
}
pub fn firewall(connection: &SavedConnection) -> Result<FirewallStatus, String> {
    parse(&read(connection, "firewall", "")?)
}
pub fn metrics(
    connection: &SavedConnection,
    wanted: &[HeaderMetric],
) -> Result<HeaderMetrics, String> {
    let names = wanted
        .iter()
        .map(|metric| {
            format!(
                "'{}'",
                serde_json::to_value(metric)
                    .expect("metric serializes")
                    .as_str()
                    .expect("metric is a string")
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    // HeaderMetrics is deliberately output-only in the common model.
    let value: serde_json::Value = parse(&read(
        connection,
        "metrics",
        &format!("$wanted=@({names});"),
    )?)?;
    Ok(parse_metrics(&value))
}
fn parse_metrics(value: &serde_json::Value) -> HeaderMetrics {
    let number = |key: &str| value.get(key).and_then(serde_json::Value::as_u64);
    let rate = |key: &str| {
        value
            .get(key)
            .and_then(serde_json::Value::as_f64)
            .filter(|v| v.is_finite() && *v >= 0.0)
    };
    let io = rate("diskReadBytesPerSecond").zip(rate("diskWriteBytesPerSecond"));
    HeaderMetrics {
        sampled_at: Utc::now().to_rfc3339(),
        cpu_percent: value
            .get("cpuPercent")
            .and_then(serde_json::Value::as_f64)
            .filter(|value| (0.0..=100.0).contains(value)),
        gpu_percent: value
            .get("gpuPercent")
            .and_then(serde_json::Value::as_f64)
            .filter(|value| (0.0..=100.0).contains(value)),
        memory_total_kib: number("memoryTotalKib"),
        memory_available_kib: number("memoryAvailableKib"),
        disk_total_kib: number("diskTotalKib"),
        disk_free_kib: number("diskFreeKib"),
        disk_label: value
            .get("diskLabel")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned),
        disk_read_bytes_per_second: io.map(|v| v.0),
        disk_write_bytes_per_second: io.map(|v| v.1),
        uptime_seconds: number("uptimeSeconds"),
    }
}
pub fn containers(connection: &SavedConnection) -> Result<Vec<DockerContainer>, String> {
    let values: Vec<serde_json::Value> = parse(&read(connection, "docker-list", "")?)?;
    values
        .iter()
        .map(|value| remote::parse_container(&value.to_string()))
        .collect()
}
pub fn container(connection: &SavedConnection, id: &str) -> Result<DockerContainerDetails, String> {
    let id = validate_container_id(id)?;
    if id.len() != 64 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Docker inspection requires a stable container ID".into());
    }
    let details = remote::parse_container_details(&read(
        connection,
        "docker-inspect",
        &format!("$container='{id}';"),
    )?)?;
    if details.id != id {
        return Err("Docker returned details for an unexpected container".into());
    }
    Ok(details)
}
pub fn docker_log_command(container: &str, lines: u16, follow: bool) -> Result<String, String> {
    let container = validate_container_id(container)?;
    let path = r"$docker=(Get-Command docker.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source; if (!$docker) { $docker=Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe' }; if (!(Test-Path -LiteralPath $docker -PathType Leaf)) { throw 'Docker CLI was not found on this Windows host.' };";
    Ok(powershell_command(&format!(
        "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false); {path} $ErrorActionPreference='Continue'; & $docker logs --tail {lines} {} '{container}' 2>&1 | ForEach-Object {{ [Console]::WriteLine($_.ToString()) }}; exit $LASTEXITCODE",
        if follow { "--follow" } else { "" }
    )))
}

#[cfg(test)]
mod tests {
    #[test]
    fn diagnostics_stamp_uses_client_time_instead_of_remote_clock_skew() {
        let sample = super::parse_diagnostics(r#"{"sampledAt":"2099-01-01T00:00:00Z","workloads":{"collectedAt":"2099-01-01T00:00:00Z"}}"#).unwrap();
        assert!(!sample.sampled_at.starts_with("2099"));
        assert_eq!(sample.workloads.unwrap().collected_at, sample.sampled_at);
    }
    use super::*;
    #[test]
    fn disk_io_reports_rates_independently_of_capacity_and_rejects_partial_pairs() {
        let sample = parse_metrics(
            &serde_json::json!({"diskReadBytesPerSecond":1048576.5,"diskWriteBytesPerSecond":0}),
        );
        assert_eq!(sample.disk_read_bytes_per_second, Some(1048576.5));
        assert_eq!(sample.disk_write_bytes_per_second, Some(0.0));
        assert_eq!(sample.disk_total_kib, None);
        for fields in [
            serde_json::json!({}),
            serde_json::json!({"diskReadBytesPerSecond":1}),
            serde_json::json!({"diskReadBytesPerSecond":-1,"diskWriteBytesPerSecond":0}),
            serde_json::json!({"diskReadBytesPerSecond":"N/A","diskWriteBytesPerSecond":0}),
        ] {
            let sample = parse_metrics(&fields);
            assert_eq!(sample.disk_read_bytes_per_second, None);
            assert_eq!(sample.disk_write_bytes_per_second, None);
        }
        let script = script("metrics", "$wanted=@('diskIo');");
        assert!(script.contains("Win32_PerfFormattedData_PerfDisk_PhysicalDisk"));
        assert!(script.contains("-OperationTimeoutSec 2"));
    }
    fn fixture() -> SavedConnection {
        SavedConnection {
            id: "windows-inspection".into(),
            display_name: "Windows fixture".into(),
            destination: std::env::var("CONTROL_ROOM_WINDOWS_TEST_HOST").expect("Windows host"),
            username: Some(std::env::var("CONTROL_ROOM_WINDOWS_TEST_USER").expect("Windows user")),
            port: None,
            identity_file: None,
            history_enabled: false,
            sudo_enabled: false,
            group_id: None,
            tags: vec![],
            created_at: String::new(),
            updated_at: String::new(),
            last_connected_at: None,
        }
    }
    #[test]
    fn docker_log_arguments_reject_remote_command_injection() {
        assert!(docker_log_command("id'; Start-Process calc; '", 50, true).is_err());
        assert!(
            docker_log_command("abc123", 50, true)
                .unwrap()
                .starts_with("powershell.exe -NoLogo -NoProfile -EncodedCommand ")
        );
        let rows: Vec<ListeningSocket> = parse(r#"[{"id":"tcp|::|22|4","protocol":"tcp","addressFamily":"ipv6","localAddress":"::","port":22,"processName":"sshd","processId":4,"systemdUnit":null,"ownership":"known"}]"#).unwrap();
        assert_eq!(rows[0].port, 22);
        assert_eq!(rows[0].systemd_unit, None);
    }
    #[test]
    #[ignore = "requires an explicitly configured Windows SSH host"]
    fn live_windows_inspection_returns_ports_peers_services_firewall_and_resources() {
        let connection = fixture();
        let listeners = ports(&connection).unwrap();
        assert!(
            listeners
                .iter()
                .any(|socket| socket.protocol == "tcp" && socket.port == 22)
        );
        assert!(listeners.iter().all(|socket| socket.systemd_unit.is_none()));
        let peers = connections(&connection).unwrap();
        assert!(peers.total_established > 0);
        let services = services(&connection).unwrap();
        assert!(
            services.iter().any(
                |service| service.id.eq_ignore_ascii_case("sshd") && service.state == "running"
            )
        );
        let policy = firewall(&connection).unwrap();
        assert_eq!(policy.backend.as_deref(), Some("windows"));
        assert!(!policy.default_incoming.unwrap().is_empty());
        assert!(
            policy.rules.is_empty(),
            "profile evidence must not invent port rules"
        );
        let resources = metrics(
            &connection,
            &[
                HeaderMetric::Cpu,
                HeaderMetric::Ram,
                HeaderMetric::Disk,
                HeaderMetric::Gpu,
                HeaderMetric::Uptime,
            ],
        )
        .unwrap();
        assert!(resources.memory_total_kib.unwrap() > 0);
        assert!(resources.disk_total_kib.unwrap() > 0);
        assert!(resources.uptime_seconds.unwrap() > 0);
        eprintln!(
            "Windows inspection verified: {} listeners, {} service entries, and resource readings",
            listeners.len(),
            services.len()
        );
    }
}
