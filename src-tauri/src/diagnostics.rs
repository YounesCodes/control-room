//! On-demand Overview reads. No sampler, history, or persistence lives here.
use crate::{models::SavedConnection, remote::RemoteCommandExecutor};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Diagnostics {
    pub sampled_at: String,
    pub cpu_percent: Option<f64>,
    pub cores: Vec<CoreUsage>,
    pub load: Vec<f64>,
    pub uptime_seconds: Option<u64>,
    pub memory: Memory,
    pub filesystems: Option<Vec<FilesystemUsage>>,
    pub disks: Option<Vec<DiskUsage>>,
    pub interfaces: Option<Vec<InterfaceUsage>>,
    pub processes: Option<Vec<ProcessUsage>>,
    pub workloads: Option<Workloads>,
    pub warnings: Vec<String>,
}
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Memory {
    pub total_kib: Option<u64>,
    pub available_kib: Option<u64>,
    pub buffers_kib: Option<u64>,
    pub cache_kib: Option<u64>,
    pub swap_total_kib: Option<u64>,
    pub swap_free_kib: Option<u64>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreUsage {
    pub name: String,
    pub percent: Option<f64>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesystemUsage {
    pub device: String,
    pub mount: String,
    pub total_kib: u64,
    pub used_kib: u64,
    pub available_kib: u64,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub name: String,
    pub read_bytes_per_second: Option<f64>,
    pub write_bytes_per_second: Option<f64>,
    pub operations_per_second: Option<f64>,
    pub busy_percent: Option<f64>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceUsage {
    pub name: String,
    pub receive_bytes_per_second: Option<f64>,
    pub transmit_bytes_per_second: Option<f64>,
    pub errors: Option<u64>,
    pub drops: Option<u64>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessUsage {
    pub pid: u32,
    pub name: String,
    pub cpu_percent: Option<f64>,
    pub memory_kib: u64,
}
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Workloads {
    pub collected_at: String,
    pub services: Option<Vec<StateCount>>,
    pub containers: Option<Vec<StateCount>>,
    pub listeners: Option<Vec<StateCount>>,
    pub warnings: Vec<String>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateCount {
    pub state: String,
    pub count: u64,
}

pub fn collect(connection: &SavedConnection, workloads: bool) -> Result<Diagnostics, String> {
    let command = format!(
        "overview_workloads={};\n{}",
        u8::from(workloads),
        include_str!("diagnostics.sh")
    );
    let text = RemoteCommandExecutor::execute(connection, "overview_diagnostics", &command)?
        .success_text()?;
    Ok(parse_linux(&text, workloads))
}

fn counters(line: &str) -> Option<Vec<u64>> {
    line.split_whitespace().map(|v| v.parse().ok()).collect()
}
fn cpu_delta(before: &[u64], after: &[u64]) -> Option<(f64, u64)> {
    // guest and guest_nice are already included in user and nice.
    if before.len() < 4 || after.len() < 4 {
        return None;
    }
    let deltas: Vec<u64> = before
        .iter()
        .take(8)
        .zip(after.iter().take(8))
        .map(|(a, b)| b.checked_sub(*a))
        .collect::<Option<_>>()?;
    let total = deltas
        .iter()
        .try_fold(0_u64, |sum, v| sum.checked_add(*v))?;
    let idle = deltas[3].checked_add(*deltas.get(4).unwrap_or(&0))?;
    (total > 0 && idle <= total).then(|| ((total - idle) as f64 * 100.0 / total as f64, total))
}
fn rate(before: &[u64], after: &[u64], index: usize, elapsed: f64, scale: f64) -> Option<f64> {
    if !elapsed.is_finite() || elapsed <= 0.0 {
        return None;
    }
    Some(after.get(index)?.checked_sub(*before.get(index)?)? as f64 * scale / elapsed)
}

fn parse_linux(text: &str, include_workloads: bool) -> Diagnostics {
    let mut sections: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    let mut section = "";
    for line in text.lines() {
        if line.starts_with('[') && line.ends_with(']') {
            section = &line[1..line.len() - 1];
            sections.entry(section).or_default();
        } else {
            sections.entry(section).or_default().push(line);
        }
    }
    let lines = |name: &str| sections.get(name).cloned().unwrap_or_default();
    let named = |name: &str| -> BTreeMap<String, Vec<u64>> {
        lines(name)
            .iter()
            .filter_map(|line| {
                let (name, values) = line.trim().split_once(char::is_whitespace)?;
                Some((name.trim_end_matches(':').into(), counters(values)?))
            })
            .collect()
    };
    let mut result = Diagnostics {
        sampled_at: Utc::now().to_rfc3339(),
        ..Default::default()
    };
    let before = named("cpu1");
    let after = named("cpu2");
    let total_ticks = before
        .get("cpu")
        .zip(after.get("cpu"))
        .filter(|_| before.keys().eq(after.keys()))
        .and_then(|(a, b)| cpu_delta(a, b));
    result.cpu_percent = total_ticks.map(|v| v.0);
    result.cores = after
        .iter()
        .filter(|(name, _)| *name != "cpu")
        .map(|(name, values)| CoreUsage {
            name: name.clone(),
            percent: before
                .get(name)
                .and_then(|a| cpu_delta(a, values))
                .map(|v| v.0),
        })
        .collect();
    result.cores.sort_by_key(|core| {
        core.name
            .trim_start_matches("cpu")
            .parse::<u32>()
            .unwrap_or(0)
    });
    result.cores.truncate(1024);
    result.load = lines("load")
        .join(" ")
        .split_whitespace()
        .take(3)
        .filter_map(|v| v.parse::<f64>().ok().filter(|v| v.is_finite() && *v >= 0.0))
        .collect();
    let time = |key: &str| {
        lines(key)
            .first()
            .and_then(|line| line.split_whitespace().next())
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v >= 0.0)
    };
    result.uptime_seconds = time("time2").map(|v| v as u64);
    let elapsed = time("time2")
        .zip(time("time1"))
        .map(|(b, a)| b - a)
        .unwrap_or(0.0);
    // meminfo includes a trailing kB unit.
    let mem: BTreeMap<_, _> = lines("memory")
        .iter()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some((
                fields.next()?.trim_end_matches(':'),
                fields.next()?.parse::<u64>().ok()?,
            ))
        })
        .collect();
    result.memory = Memory {
        total_kib: mem.get("MemTotal").copied(),
        available_kib: mem.get("MemAvailable").copied(),
        buffers_kib: mem.get("Buffers").copied(),
        cache_kib: mem
            .get("Cached")
            .copied()
            .zip(mem.get("SReclaimable").copied())
            .and_then(|(a, b)| a.checked_add(b)),
        swap_total_kib: mem.get("SwapTotal").copied(),
        swap_free_kib: mem.get("SwapFree").copied(),
    };
    if sections.contains_key("filesystems-ok") {
        result.filesystems = Some(
            lines("filesystems")
                .iter()
                .filter_map(|line| {
                    let fields: Vec<_> = line.split_whitespace().collect();
                    if fields.len() < 6 {
                        return None;
                    }
                    let total = fields[1].parse::<u64>().ok()?;
                    let used = fields[2].parse::<u64>().ok()?;
                    let available = fields[3].parse::<u64>().ok()?;
                    if total == 0 || used > total || available > total {
                        return None;
                    }
                    Some(FilesystemUsage {
                        device: fields[0].into(),
                        mount: fields[5..].join(" "),
                        total_kib: total,
                        used_kib: used,
                        available_kib: available,
                    })
                })
                .take(256)
                .collect(),
        );
    }
    let disk_before = named("disk1");
    let disk_after = named("disk2");
    let same_disks = disk_before.keys().eq(disk_after.keys());
    if !disk_after.is_empty() {
        result.disks = Some(
            disk_after
                .iter()
                .take(256)
                .map(|(name, b)| {
                    let a = disk_before.get(name).filter(|_| same_disks);
                    let r = |i, s| a.and_then(|a| rate(a, b, i, elapsed, s));
                    DiskUsage {
                        name: name.clone(),
                        read_bytes_per_second: r(2, 512.0),
                        write_bytes_per_second: r(6, 512.0),
                        operations_per_second: r(0, 1.0).zip(r(4, 1.0)).map(|(a, b)| a + b),
                        busy_percent: r(9, 0.1).map(|v| v.min(100.0)),
                    }
                })
                .collect(),
        );
    }
    let net_before = named("net1");
    let net_after = named("net2");
    let same_interfaces = net_before.keys().eq(net_after.keys());
    if sections.contains_key("net-ok") {
        result.interfaces = Some(
            net_after
                .iter()
                .take(256)
                .map(|(name, b)| {
                    let a = net_before.get(name).filter(|_| same_interfaces);
                    InterfaceUsage {
                        name: name.clone(),
                        receive_bytes_per_second: a.and_then(|a| rate(a, b, 0, elapsed, 1.0)),
                        transmit_bytes_per_second: a.and_then(|a| rate(a, b, 8, elapsed, 1.0)),
                        errors: b.get(2).zip(b.get(10)).and_then(|(a, b)| a.checked_add(*b)),
                        drops: b.get(3).zip(b.get(11)).and_then(|(a, b)| a.checked_add(*b)),
                    }
                })
                .collect(),
        );
    }
    // PID, start tick, CPU ticks, RSS KiB, command name. Start tick rejects PID reuse.
    let processes = |name| -> BTreeMap<u32, (u64, u64, u64, String)> {
        lines(name)
            .iter()
            .filter_map(|line| {
                let fields: Vec<_> = line.splitn(5, '\t').collect();
                Some((
                    fields.first()?.parse().ok()?,
                    (
                        fields.get(1)?.parse().ok()?,
                        fields.get(2)?.parse().ok()?,
                        fields.get(3)?.parse().ok()?,
                        fields.get(4)?.to_string(),
                    ),
                ))
            })
            .collect()
    };
    if sections.contains_key("processes-ok") {
        let first = processes("process1");
        let mut rows: Vec<_> = processes("process2")
            .into_iter()
            .map(|(pid, (start, ticks, memory, name))| {
                let cpu = first
                    .get(&pid)
                    .filter(|a| a.0 == start)
                    .and_then(|a| ticks.checked_sub(a.1))
                    .zip(total_ticks)
                    .map(|(delta, (_, total))| (delta as f64 * 100.0 / total as f64).min(100.0));
                ProcessUsage {
                    pid,
                    name,
                    cpu_percent: cpu,
                    memory_kib: memory,
                }
            })
            .collect();
        rows.sort_by(|a, b| {
            b.cpu_percent
                .unwrap_or(-1.0)
                .total_cmp(&a.cpu_percent.unwrap_or(-1.0))
        });
        let mut top: Vec<_> = rows.iter().take(20).map(|p| p.pid).collect();
        rows.sort_by_key(|p| std::cmp::Reverse(p.memory_kib));
        top.extend(rows.iter().take(20).map(|p| p.pid));
        rows.retain(|p| top.contains(&p.pid));
        result.processes = Some(rows);
    }
    if include_workloads {
        let counts = |section, marker| {
            sections.contains_key(marker).then(|| {
                lines(section)
                    .iter()
                    .filter_map(|line| {
                        let (state, count) = line.split_once('\t')?;
                        Some(StateCount {
                            state: state.into(),
                            count: count.parse().ok()?,
                        })
                    })
                    .collect()
            })
        };
        result.workloads = Some(Workloads {
            collected_at: result.sampled_at.clone(),
            services: counts("services", "services-ok"),
            containers: counts("containers", "containers-ok"),
            listeners: counts("listeners", "listeners-ok"),
            warnings: lines("workload-warnings")
                .iter()
                .map(|s| s.to_string())
                .collect(),
        });
    }
    if result.cpu_percent.is_none() {
        result.warnings.push("CPU counters unavailable".into());
    }
    if result.memory.total_kib.is_none() {
        result.warnings.push("Memory counters unavailable".into());
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disk_and_network_rates_use_host_elapsed_time_and_reject_topology_changes() {
        let text = "[time1]\n10\n[time2]\n12\n[disk1]\nsda 10 0 100 0 20 0 200 0 0 100 0\n[disk2]\nsda 14 0 120 0 26 0 240 0 0 200 0\n[net1]\neth0 100 0 1 2 0 0 0 0 200 0 3 4 0 0 0 0\n[net2]\neth0 300 0 2 3 0 0 0 0 600 0 4 5 0 0 0 0\n[net-ok]\n";
        let sample = parse_linux(text, false);
        let disk = &sample.disks.unwrap()[0];
        assert_eq!(disk.read_bytes_per_second, Some(5120.0));
        assert_eq!(disk.write_bytes_per_second, Some(10240.0));
        assert_eq!(disk.operations_per_second, Some(5.0));
        assert_eq!(disk.busy_percent, Some(5.0));
        let interface = &sample.interfaces.unwrap()[0];
        assert_eq!(interface.receive_bytes_per_second, Some(100.0));
        assert_eq!(interface.transmit_bytes_per_second, Some(200.0));
        assert_eq!(interface.errors, Some(6));
        assert_eq!(interface.drops, Some(8));
        let changed = parse_linux(
            &text
                .replace("[disk2]", "sdb 0 0 0 0 0 0 0 0 0 0 0\n[disk2]")
                .replace("[net2]", "other 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n[net2]"),
            false,
        );
        assert_eq!(changed.disks.unwrap()[0].read_bytes_per_second, None);
        assert_eq!(
            changed.interfaces.unwrap()[0].receive_bytes_per_second,
            None
        );
    }
    #[test]
    fn filesystems_accept_spaces_and_reject_invalid_capacity() {
        let sample = parse_linux(
            "[filesystems-ok]\n[filesystems]\n/dev/sda 100 20 75 21% /media/with space\n/dev/sdb 100 101 0 101% /invalid\n",
            false,
        );
        let rows = sample.filesystems.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].mount, "/media/with space");
    }
    #[cfg(unix)]
    #[test]
    fn linux_collector_reads_real_counters_without_optional_tools() {
        let output = std::process::Command::new("sh")
            .arg("-c")
            .arg(format!(
                "overview_workloads=0;\n{}",
                include_str!("diagnostics.sh")
            ))
            .output()
            .unwrap();
        assert!(output.status.success());
        let sample = parse_linux(&String::from_utf8_lossy(&output.stdout), false);
        assert!(sample.memory.total_kib.is_some_and(|v| v > 0));
        assert!(sample.cpu_percent.is_some());
        assert!(!sample.cores.is_empty());
        assert!(sample.processes.is_some_and(|v| !v.is_empty()));
        assert!(sample.interfaces.is_some());
    }
    #[cfg(windows)]
    #[test]
    fn windows_collector_returns_typed_real_counters_and_partial_workloads() {
        use std::{io::Write, process::Stdio};
        let mut child = crate::ssh::background_command("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$script=[Console]::In.ReadToEnd(); & ([ScriptBlock]::Create($script))",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let script = format!(
            "$overviewWorkloads=$true;\n{}",
            include_str!("diagnostics.ps1")
        );
        child
            .stdin
            .take()
            .unwrap()
            .write_all(script.as_bytes())
            .unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let sample: Diagnostics = serde_json::from_slice(&output.stdout).unwrap_or_else(|e| {
            panic!(
                "Invalid Windows sample: {e}; stderr: {}",
                String::from_utf8_lossy(&output.stderr)
            )
        });
        assert!(sample.memory.total_kib.is_some_and(|v| v > 0));
        assert!(sample.uptime_seconds.is_some());
        assert!(sample.workloads.is_some());
        assert!(sample.load.is_empty());
        assert_eq!(sample.memory.buffers_kib, None);
    }
    #[test]
    fn deltas_reject_resets_and_do_not_double_count_guest_time() {
        assert_eq!(
            cpu_delta(
                &[100, 0, 0, 100, 0, 0, 0, 0, 50],
                &[120, 0, 0, 180, 0, 0, 0, 0, 60]
            ),
            Some((20.0, 100))
        );
        assert_eq!(cpu_delta(&[2, 0, 0, 4], &[1, 0, 0, 6]), None);
        assert_eq!(rate(&[10], &[9], 0, 1.0, 1.0), None);
        assert_eq!(rate(&[10], &[20], 0, 0.0, 1.0), None);
    }
    #[test]
    fn partial_readings_keep_missing_values_and_empty_inventory_distinct() {
        let sample = parse_linux(
            "[cpu1]\ncpu 100 0 0 100\n[time1]\n10\n[cpu2]\ncpu 125 0 0 175\n[time2]\n12\n[memory]\nMemTotal: 1000 kB\nMemAvailable: 400 kB\nCached: 100 kB\nSReclaimable: 20 kB\n[containers-ok]\n[containers]\n",
            true,
        );
        assert_eq!(sample.cpu_percent, Some(25.0));
        assert_eq!(sample.memory.cache_kib, Some(120));
        assert!(sample.disks.is_none());
        let workloads = sample.workloads.unwrap();
        assert!(workloads.containers.unwrap().is_empty());
        assert!(workloads.services.is_none());
    }
    #[test]
    fn process_sampling_rejects_reused_pids_and_keeps_memory_consumers() {
        let sample = parse_linux(
            "[cpu1]\ncpu 100 0 0 100\n[cpu2]\ncpu 120 0 0 180\n[process1]\n1\t10\t20\t40\tinit\n2\t30\t5\t100\tworker\n[process2]\n1\t10\t30\t40\tinit\n2\t99\t10\t200\tnew worker\n[processes-ok]\n",
            false,
        );
        let rows = sample.processes.unwrap();
        assert_eq!(
            rows.iter().find(|p| p.pid == 1).unwrap().cpu_percent,
            Some(10.0)
        );
        assert_eq!(rows.iter().find(|p| p.pid == 2).unwrap().cpu_percent, None);
    }
}
