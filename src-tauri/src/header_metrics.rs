//! Optional, read-only header samples. No history, credentials, or process details leave here.
use crate::{
    models::{HeaderMetric, HeaderMetrics, SavedConnection},
    remote::{self, RemoteCommandExecutor},
};
use chrono::Utc;
use parking_lot::Mutex;

#[derive(Default)]
pub struct HeaderMetricsState(pub Mutex<()>);

fn remote_command(metrics: &[HeaderMetric]) -> String {
    let mut command = String::from("LC_ALL=C; export LC_ALL; ");
    if metrics.contains(&HeaderMetric::Cpu) || metrics.contains(&HeaderMetric::Ram) {
        command.push_str(remote::resource_command());
        command.push_str("; ");
    }
    if metrics.contains(&HeaderMetric::Disk) {
        command.push_str(r#"df -Pk / 2>/dev/null | awk 'NR==2 {printf "disk_total=%s\ndisk_free=%s\n",$2,$4}'; "#);
    }
    if metrics.contains(&HeaderMetric::Uptime) {
        command.push_str(
            r#"if test -r /proc/uptime; then awk '{printf "uptime=%d\n",$1}' /proc/uptime; fi; "#,
        );
    }
    if metrics.contains(&HeaderMetric::Gpu) {
        // timeout bounds a stalled driver query independently of the SSH budget.
        // If timeout is absent, AMD sysfs can still report without spawning a driver tool.
        command.push_str(r#"if command -v nvidia-smi >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then timeout -k 1 2 nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null | awk '/^[[:space:]]*[0-9]+([.][0-9]+)?[[:space:]]*$/ {if(!seen || $1>m) m=$1; seen=1} END {if(seen) printf "gpu=%s\n",m}'; fi; for f in /sys/class/drm/card*/device/gpu_busy_percent; do if test -r "$f"; then printf 'gpu_amd=%s\n' "$(cat "$f" 2>/dev/null)"; fi; done; "#);
    }
    command.push_str("true");
    command
}

pub fn collect_remote(
    connection: &SavedConnection,
    metrics: &[HeaderMetric],
) -> Result<HeaderMetrics, String> {
    if metrics.is_empty() {
        return Ok(HeaderMetrics {
            sampled_at: Utc::now().to_rfc3339(),
            ..HeaderMetrics::default()
        });
    }
    let text =
        RemoteCommandExecutor::execute(connection, "header_metrics", &remote_command(metrics))?
            .success_text()?;
    Ok(parse_remote(&text, metrics))
}

fn percent(value: &str) -> Option<f64> {
    value
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite() && (0.0..=100.0).contains(value))
}

fn parse_remote(text: &str, metrics: &[HeaderMetric]) -> HeaderMetrics {
    let resources = remote::parse_host_resources(text);
    let mut result = HeaderMetrics {
        sampled_at: Utc::now().to_rfc3339(),
        ..HeaderMetrics::default()
    };
    if metrics.contains(&HeaderMetric::Cpu) {
        result.cpu_percent = resources.cpu_percent;
    }
    if metrics.contains(&HeaderMetric::Ram) {
        result.memory_total_kib = resources.memory_total_kib;
        result.memory_available_kib = resources.memory_available_kib;
    }
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key {
            "gpu" | "gpu_amd" if metrics.contains(&HeaderMetric::Gpu) => {
                if let Some(value) = percent(value) {
                    result.gpu_percent = Some(
                        result
                            .gpu_percent
                            .map_or(value, |current| current.max(value)),
                    );
                }
            }
            "disk_total" if metrics.contains(&HeaderMetric::Disk) => {
                result.disk_total_kib = value.parse().ok()
            }
            "disk_free" if metrics.contains(&HeaderMetric::Disk) => {
                result.disk_free_kib = value.parse().ok()
            }
            "uptime" if metrics.contains(&HeaderMetric::Uptime) => {
                result.uptime_seconds = value.parse().ok()
            }
            _ => (),
        }
    }
    if result.disk_total_kib.is_some() {
        result.disk_label = Some("/".into());
    }
    result
}

// Windows reports system-wide CPU counters. Kernel includes idle time.
#[cfg(any(windows, test))]
fn cpu_delta(before: (u64, u64, u64), after: (u64, u64, u64)) -> Option<f64> {
    let idle = after.0.checked_sub(before.0)?;
    let total = after
        .1
        .checked_sub(before.1)?
        .checked_add(after.2.checked_sub(before.2)?)?;
    if total == 0 || idle > total {
        return None;
    }
    Some((total - idle) as f64 / total as f64 * 100.0)
}

#[cfg(windows)]
pub fn collect_local(metrics: &[HeaderMetric]) -> Result<HeaderMetrics, String> {
    use windows_sys::Win32::{
        Foundation::FILETIME,
        Storage::FileSystem::GetDiskFreeSpaceExW,
        System::{
            SystemInformation::{GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX},
            Threading::GetSystemTimes,
        },
    };
    fn times() -> Option<(u64, u64, u64)> {
        let mut idle = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        // Each pointer refers to an initialized, writable FILETIME for this call.
        if unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) } == 0 {
            return None;
        }
        let ticks =
            |value: FILETIME| ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64;
        Some((ticks(idle), ticks(kernel), ticks(user)))
    }
    let mut sample = HeaderMetrics::default();
    if metrics.contains(&HeaderMetric::Cpu) {
        let before = times();
        std::thread::sleep(std::time::Duration::from_millis(250));
        sample.cpu_percent = before
            .zip(times())
            .and_then(|(before, after)| cpu_delta(before, after));
    }
    if metrics.contains(&HeaderMetric::Ram) {
        let mut memory = MEMORYSTATUSEX {
            dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
            ..Default::default()
        };
        // dwLength identifies this initialized output structure to Windows.
        if unsafe { GlobalMemoryStatusEx(&mut memory) } != 0 {
            sample.memory_total_kib = Some(memory.ullTotalPhys / 1024);
            sample.memory_available_kib = Some(memory.ullAvailPhys / 1024);
        }
    }
    if metrics.contains(&HeaderMetric::Disk) {
        let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        let path: Vec<u16> = format!("{drive}\\").encode_utf16().chain(Some(0)).collect();
        let mut total = 0;
        let mut free = 0;
        // path is null terminated. Output pointers are valid and we need total
        // free bytes, not the quota-limited availability for this account.
        if unsafe {
            GetDiskFreeSpaceExW(path.as_ptr(), std::ptr::null_mut(), &mut total, &mut free)
        } != 0
        {
            sample.disk_total_kib = Some(total / 1024);
            sample.disk_free_kib = Some(free / 1024);
            sample.disk_label = Some(drive);
        }
    }
    if metrics.contains(&HeaderMetric::Uptime) {
        // This API takes no pointers and returns milliseconds since boot.
        sample.uptime_seconds = Some(unsafe { GetTickCount64() } / 1000);
    }
    if metrics.contains(&HeaderMetric::Gpu) {
        sample.gpu_percent = local_gpu();
    }
    sample.sampled_at = Utc::now().to_rfc3339();
    Ok(sample)
}

#[cfg(any(windows, test))]
fn busiest_engine(readings: impl IntoIterator<Item = (String, f64)>) -> Option<f64> {
    let mut engines = std::collections::HashMap::<String, f64>::new();
    for (name, value) in readings {
        if !value.is_finite() || !(0.0..=100.0).contains(&value) {
            continue;
        }
        // PDH names include one process id plus adapter/physical-engine identity.
        let Some(engine) = name
            .strip_prefix("pid_")
            .and_then(|name| name.split_once('_').map(|(_, engine)| engine))
        else {
            continue;
        };
        *engines.entry(engine.to_string()).or_default() += value;
    }
    engines
        .into_values()
        .reduce(f64::max)
        .map(|value| value.min(100.0))
}

#[cfg(windows)]
fn local_gpu() -> Option<f64> {
    use windows_sys::Win32::System::Performance::*;
    struct Query(PDH_HQUERY);
    impl Drop for Query {
        fn drop(&mut self) {
            // This wrapper owns the successful PdhOpenQueryW handle.
            unsafe {
                PdhCloseQuery(self.0);
            }
        }
    }
    let mut handle = std::ptr::null_mut();
    // Null datasource requests live system counters. The output is writable.
    if unsafe { PdhOpenQueryW(std::ptr::null(), 0, &mut handle) } != 0 {
        return None;
    }
    let query = Query(handle);
    let path: Vec<u16> = r"\GPU Engine(*)\Utilization Percentage"
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut counter = std::ptr::null_mut();
    // English counter names work independently of Windows display language.
    if unsafe { PdhAddEnglishCounterW(query.0, path.as_ptr(), 0, &mut counter) } != 0 {
        return None;
    }
    // Utilization needs two counter snapshots rather than a lifetime average.
    if unsafe { PdhCollectQueryData(query.0) } != 0 {
        return None;
    }
    std::thread::sleep(std::time::Duration::from_millis(250));
    if unsafe { PdhCollectQueryData(query.0) } != 0 {
        return None;
    }
    let mut bytes = 0;
    let mut count = 0;
    // The first call asks for the required buffer size, without dereferencing output.
    if unsafe {
        PdhGetFormattedCounterArrayW(
            counter,
            PDH_FMT_DOUBLE,
            &mut bytes,
            &mut count,
            std::ptr::null_mut(),
        )
    } != PDH_MORE_DATA
    {
        return None;
    }
    if bytes == 0 || bytes > 4 * 1024 * 1024 {
        return None;
    }
    let words = (bytes as usize).div_ceil(std::mem::size_of::<u64>());
    let mut buffer = vec![0_u64; words];
    let capacity = buffer.len() * std::mem::size_of::<u64>();
    bytes = capacity as u32;
    // u64 storage is aligned for PDH's items and initializes every byte,
    // including space for names and structure padding.
    let pointer = buffer.as_mut_ptr().cast::<PDH_FMT_COUNTERVALUE_ITEM_W>();
    if unsafe {
        PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut bytes, &mut count, pointer)
    } != 0
        || count as usize > capacity / std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>()
    {
        return None;
    }
    // PDH initialized count items, bounded above by the allocated byte capacity.
    let items = unsafe { std::slice::from_raw_parts(pointer, count as usize) };
    let start = buffer.as_ptr() as usize;
    let end = start + capacity;
    let mut readings = Vec::new();
    for item in items {
        if ![PDH_CSTATUS_VALID_DATA, PDH_CSTATUS_NEW_DATA].contains(&item.FmtValue.CStatus) {
            continue;
        }
        let name = item.szName as usize;
        if name < start || name >= end || !name.is_multiple_of(2) {
            continue;
        }
        // PDH stores null-terminated UTF-16 names inside the allocated buffer.
        // Bound the slice to that buffer before looking for the terminator.
        let wide = unsafe { std::slice::from_raw_parts(item.szName, (end - name) / 2) };
        let Some(length) = wide.iter().position(|value| *value == 0) else {
            continue;
        };
        // PDH_FMT_DOUBLE selects the doubleValue union member.
        readings.push((String::from_utf16_lossy(&wide[..length]), unsafe {
            item.FmtValue.Anonymous.doubleValue
        }));
    }
    busiest_engine(readings)
}

#[cfg(not(windows))]
pub fn collect_local(_metrics: &[HeaderMetric]) -> Result<HeaderMetrics, String> {
    Err("Local host metrics require Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selected_reads_only_and_driver_tool_is_bounded() {
        let command = remote_command(&[HeaderMetric::Uptime]);
        assert!(!command.contains("nvidia-smi"));
        assert!(!command.contains("/proc/stat"));
        assert!(!command.contains("df -Pk"));
        let command = remote_command(&[HeaderMetric::Gpu]);
        assert!(command.contains("timeout -k 1 2 nvidia-smi"));
        assert!(command.contains("gpu_busy_percent"));
        assert!(!command.contains("sudo"));
    }
    #[test]
    fn gpu_uses_busiest_valid_device_and_missing_is_not_zero() {
        let sample = parse_remote(
            "gpu=23\ngpu_amd=58\ngpu_amd=NaN\ngpu=101\ndisk_total=1000\ndisk_free=350\nuptime=3600",
            &[HeaderMetric::Gpu, HeaderMetric::Disk, HeaderMetric::Uptime],
        );
        assert_eq!(sample.gpu_percent, Some(58.0));
        assert_eq!(sample.disk_total_kib, Some(1000));
        assert_eq!(sample.disk_free_kib, Some(350));
        assert_eq!(sample.uptime_seconds, Some(3600));
        assert_eq!(
            parse_remote("gpu=N/A", &[HeaderMetric::Gpu]).gpu_percent,
            None
        );
        assert_eq!(
            parse_remote("gpu=40", &[HeaderMetric::Cpu]).gpu_percent,
            None
        );
    }
    #[test]
    fn gpu_sums_processes_on_one_engine_without_adding_independent_engines() {
        let readings = [
            ("pid_1_luid_a_phys_0_eng_0".into(), 20.0),
            ("pid_2_luid_a_phys_0_eng_0".into(), 30.0),
            ("pid_1_luid_a_phys_0_eng_1".into(), 40.0),
            ("pid_1_luid_b_phys_0_eng_0".into(), 10.0),
        ];
        assert_eq!(busiest_engine(readings), Some(50.0));
        assert_eq!(busiest_engine([("invalid".into(), 50.0)]), None);
        assert_eq!(busiest_engine([("pid_1_luid_a".into(), f64::NAN)]), None);
    }

    #[test]
    fn cpu_subtracts_idle_and_rejects_reset_or_zero_window() {
        assert_eq!(cpu_delta((10, 30, 10), (20, 60, 20)), Some(75.0));
        assert_eq!(cpu_delta((10, 30, 10), (10, 30, 10)), None);
        assert_eq!(cpu_delta((10, 30, 10), (9, 60, 20)), None);
    }
    #[cfg(windows)]
    #[test]
    fn windows_sample_reports_real_capacity_and_boot_time() {
        let sample = collect_local(&[
            HeaderMetric::Cpu,
            HeaderMetric::Ram,
            HeaderMetric::Disk,
            HeaderMetric::Uptime,
        ])
        .unwrap();
        assert!(sample.memory_total_kib.unwrap() > 0);
        assert!(sample.memory_available_kib.unwrap() <= sample.memory_total_kib.unwrap());
        assert!(sample.disk_total_kib.unwrap() > 0);
        assert!(sample.disk_free_kib.unwrap() <= sample.disk_total_kib.unwrap());
        assert!(
            sample
                .cpu_percent
                .is_some_and(|value| (0.0..=100.0).contains(&value))
        );
        assert!(sample.uptime_seconds.is_some());
        assert_eq!(sample.gpu_percent, None);
        let gpu = collect_local(&[HeaderMetric::Gpu]).unwrap();
        eprintln!("Windows GPU counter reading: {:?}", gpu.gpu_percent);
        assert!(
            gpu.gpu_percent
                .is_none_or(|value| (0.0..=100.0).contains(&value))
        );
    }
}
