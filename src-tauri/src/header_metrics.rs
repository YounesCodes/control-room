//! Optional, read-only header samples. No history, credentials, or process details leave here.
use crate::{
    models::{HeaderMetric, HeaderMetrics, SavedConnection},
    remote::{self, RemoteCommandExecutor},
};
use chrono::Utc;
use parking_lot::Mutex;

#[derive(Default)]
pub struct HeaderMetricsState(Mutex<std::collections::HashSet<Option<String>>>);

pub struct HeaderReadingPermit<'a> {
    state: &'a HeaderMetricsState,
    target: Option<String>,
}
impl HeaderMetricsState {
    pub fn begin(&self, target: Option<&str>) -> Result<HeaderReadingPermit<'_>, String> {
        let target = target.map(str::to_owned);
        if !self.0.lock().insert(target.clone()) {
            return Err("Previous reading for this host is still finishing".into());
        }
        Ok(HeaderReadingPermit {
            state: self,
            target,
        })
    }
}
impl Drop for HeaderReadingPermit<'_> {
    fn drop(&mut self) {
        self.state.0.lock().remove(&self.target);
    }
}

pub fn empty_sample() -> HeaderMetrics {
    HeaderMetrics {
        sampled_at: Utc::now().to_rfc3339(),
        ..HeaderMetrics::default()
    }
}

fn remote_command(metrics: &[HeaderMetric]) -> String {
    let mut command = String::from("LC_ALL=C; export LC_ALL; ");
    if metrics.contains(&HeaderMetric::Cpu) {
        command.push_str(remote::resource_command());
        command.push_str("; ");
    } else if metrics.contains(&HeaderMetric::Ram) {
        command.push_str(r#"if test -r /proc/meminfo; then awk '/^MemTotal:|^MemAvailable:/{key=tolower(substr($1,1,length($1)-1)); printf "%s=%s\n", key, $2}' /proc/meminfo; fi; "#);
    }
    if metrics.contains(&HeaderMetric::Disk) {
        command.push_str(r#"df -Pk / 2>/dev/null | awk 'NR==2 {printf "disk_total=%s\ndisk_free=%s\n",$2,$4}'; "#);
    }
    if metrics.contains(&HeaderMetric::DiskIo) {
        // Whole leaf devices only: partitions and stacked dm/md devices must
        // not count the same transfer twice. No iostat installation is needed.
        command.push_str(r#"header_io_snapshot() { phase=$1; if test -r /proc/uptime; then awk -v p="$phase" '{printf "io_time_%s=%s\n",p,$1}' /proc/uptime; fi; for d in /sys/block/*; do case "${d##*/}" in loop*|ram*|zram*|fd*|sr*) continue;; esac; test -r "$d/stat" || continue; set -- "$d"/slaves/*; test -e "$1" && continue; awk -v p="$phase" -v name="${d##*/}" 'NF>=7 {printf "io_disk_%s=%s %s %s\n",p,name,$3,$7}' "$d/stat"; done; }; header_io_snapshot 1; sleep 1; header_io_snapshot 2; "#);
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
        return Ok(empty_sample());
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
    let mut result = empty_sample();
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
        let (key, value) = (key.trim(), value.trim());
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
    let capacity = (result.disk_total_kib, result.disk_free_kib);
    set_disk_capacity(&mut result, capacity.0, capacity.1, "/");
    if metrics.contains(&HeaderMetric::DiskIo)
        && let Some((read, write)) = disk_io_rates(text)
    {
        result.disk_read_bytes_per_second = Some(read);
        result.disk_write_bytes_per_second = Some(write);
    }
    result
}

/// Linux sectors are always 512 bytes, independent of a disk's sector size.
/// Subtract integer counters before converting to rates, and reject resets,
/// missing devices, or hot-plug changes rather than presenting a false zero.
fn disk_io_rates(text: &str) -> Option<(f64, f64)> {
    use std::collections::BTreeMap;
    let mut times = [None, None];
    let mut disks = [BTreeMap::new(), BTreeMap::new()];
    for line in text.lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "io_time_1" | "io_time_2" => {
                let phase = usize::from(key.trim().ends_with('2'));
                times[phase] = Some(
                    value
                        .parse::<f64>()
                        .ok()
                        .filter(|v| v.is_finite() && *v >= 0.0)?,
                );
            }
            "io_disk_1" | "io_disk_2" => {
                let phase = usize::from(key.trim().ends_with('2'));
                let fields = value.split_whitespace().collect::<Vec<_>>();
                if fields.len() != 3 {
                    return None;
                }
                let counts = (
                    fields[1].parse::<u64>().ok()?,
                    fields[2].parse::<u64>().ok()?,
                );
                if disks[phase].insert(fields[0], counts).is_some() {
                    return None;
                }
            }
            _ => (),
        }
    }
    let elapsed = times[1]? - times[0]?;
    if !elapsed.is_finite()
        || elapsed <= 0.0
        || disks[0].is_empty()
        || disks[0].keys().ne(disks[1].keys())
    {
        return None;
    }
    let (mut read, mut write) = (0_u64, 0_u64);
    for (name, before) in &disks[0] {
        let after = disks[1].get(name)?;
        read = read.checked_add(after.0.checked_sub(before.0)?)?;
        write = write.checked_add(after.1.checked_sub(before.1)?)?;
    }
    Some((
        read as f64 * 512.0 / elapsed,
        write as f64 * 512.0 / elapsed,
    ))
}

fn set_disk_capacity(
    sample: &mut HeaderMetrics,
    total: Option<u64>,
    free: Option<u64>,
    label: &str,
) {
    if let Some((total, free)) = total
        .zip(free)
        .filter(|(total, free)| *total > 0 && free <= total)
    {
        sample.disk_total_kib = Some(total);
        sample.disk_free_kib = Some(free);
        sample.disk_label = Some(label.into());
    } else {
        sample.disk_total_kib = None;
        sample.disk_free_kib = None;
        sample.disk_label = None;
    }
}

#[cfg(any(windows, test))]
fn system_drive(value: Option<&str>) -> String {
    let drive = value.unwrap_or("").trim().trim_end_matches(['\\', '/']);
    let bytes = drive.as_bytes();
    if bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        drive.to_ascii_uppercase()
    } else {
        "C:".into()
    }
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
        let drive = system_drive(std::env::var("SystemDrive").ok().as_deref());
        let path: Vec<u16> = format!("{drive}\\").encode_utf16().chain(Some(0)).collect();
        let mut total = 0;
        let mut free = 0;
        // path is null terminated. Output pointers are valid and we need total
        // free bytes, not the quota-limited availability for this account.
        if unsafe {
            GetDiskFreeSpaceExW(path.as_ptr(), std::ptr::null_mut(), &mut total, &mut free)
        } != 0
        {
            set_disk_capacity(&mut sample, Some(total / 1024), Some(free / 1024), &drive);
        }
    }
    if metrics.contains(&HeaderMetric::Uptime) {
        // This API takes no pointers and returns milliseconds since boot.
        sample.uptime_seconds = Some(unsafe { GetTickCount64() } / 1000);
    }
    if metrics.contains(&HeaderMetric::Gpu) {
        sample.gpu_percent = local_gpu();
    }
    if metrics.contains(&HeaderMetric::DiskIo)
        && let Some((read, write)) = local_disk_io()
    {
        sample.disk_read_bytes_per_second = Some(read);
        sample.disk_write_bytes_per_second = Some(write);
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

#[cfg(windows)]
fn local_disk_io() -> Option<(f64, f64)> {
    use windows_sys::Win32::System::Performance::*;
    // pdh.h flags omitted from windows-sys 0.61's projection. Keep byte
    // rates unscaled and uncapped, as specified by the Windows SDK.
    const PDH_FMT_NOSCALE: u32 = 0x00001000;
    const PDH_FMT_NOCAP100: u32 = 0x00008000;
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
    // Null datasource selects live, system-wide performance counters.
    if unsafe { PdhOpenQueryW(std::ptr::null(), 0, &mut handle) } != 0 {
        return None;
    }
    let query = Query(handle);
    let mut counters = [std::ptr::null_mut(); 2];
    for (index, name) in [
        r"\PhysicalDisk(_Total)\Disk Read Bytes/sec",
        r"\PhysicalDisk(_Total)\Disk Write Bytes/sec",
    ]
    .iter()
    .enumerate()
    {
        let path = name.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        // English names work on localized Windows installations too.
        if unsafe { PdhAddEnglishCounterW(query.0, path.as_ptr(), 0, &mut counters[index]) } != 0 {
            return None;
        }
    }
    // Rate counters need two snapshots at least a second apart.
    if unsafe { PdhCollectQueryData(query.0) } != 0 {
        return None;
    }
    std::thread::sleep(std::time::Duration::from_secs(1));
    if unsafe { PdhCollectQueryData(query.0) } != 0 {
        return None;
    }
    let mut rates = [0.0; 2];
    for (index, counter) in counters.iter().enumerate() {
        let mut value = PDH_FMT_COUNTERVALUE::default();
        // Byte rates are neither scaled nor capped at 100, unlike percentages.
        if unsafe {
            PdhGetFormattedCounterValue(
                *counter,
                PDH_FMT_DOUBLE | PDH_FMT_NOCAP100 | PDH_FMT_NOSCALE,
                std::ptr::null_mut(),
                &mut value,
            )
        } != 0
            || ![PDH_CSTATUS_VALID_DATA, PDH_CSTATUS_NEW_DATA].contains(&value.CStatus)
        {
            return None;
        }
        // PDH_FMT_DOUBLE selects this initialized union member.
        let rate = unsafe { value.Anonymous.doubleValue };
        if !rate.is_finite() || rate < 0.0 {
            return None;
        }
        rates[index] = rate;
    }
    Some((rates[0], rates[1]))
}

#[cfg(not(windows))]
pub fn collect_local(_metrics: &[HeaderMetric]) -> Result<HeaderMetrics, String> {
    Err("Local host metrics require Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disk_io_uses_elapsed_host_time_and_whole_device_sector_deltas() {
        let text = "io_time_1=100\nio_disk_1=sda 100 200\nio_disk_1=nvme0n1 1000 500\nio_time_2=102\nio_disk_2=nvme0n1 1010 540\nio_disk_2=sda 110 220";
        assert_eq!(disk_io_rates(text), Some((5120.0, 15360.0)));
        let sample = parse_remote(text, &[HeaderMetric::DiskIo]);
        assert_eq!(sample.disk_read_bytes_per_second, Some(5120.0));
        assert_eq!(sample.disk_write_bytes_per_second, Some(15360.0));
        assert_eq!(sample.disk_total_kib, None);
        assert_eq!(
            parse_remote(text, &[HeaderMetric::Disk]).disk_read_bytes_per_second,
            None
        );
        assert_eq!(
            disk_io_rates("io_time_1=1\nio_disk_1=sda 0 0\nio_time_2=2\nio_disk_2=sda 0 0"),
            Some((0.0, 0.0))
        );
    }
    #[test]
    fn disk_io_rejects_missing_snapshots_resets_and_changed_device_sets() {
        let before = "io_time_1=100\nio_disk_1=sda 100 200\n";
        for after in [
            "",
            "io_time_2=100\nio_disk_2=sda 110 210",
            "io_time_2=99\nio_disk_2=sda 110 210",
            "io_time_2=NaN\nio_disk_2=sda 110 210",
            "io_time_2=101\nio_disk_2=sda 99 210",
            "io_time_2=101\nio_disk_2=sdb 110 210",
            "io_time_2=101\nio_disk_2=sda 110 210\nio_disk_2=sdb 1 1",
            "io_time_2=101\nio_disk_2=sda N/A 210",
            "io_time_2=101\nio_disk_2=sda 110 210\nio_disk_2=sda 110 210",
        ] {
            assert_eq!(disk_io_rates(&format!("{before}{after}")), None, "{after}");
        }
        assert_eq!(disk_io_rates("io_time_1=1\nio_time_2=2"), None);
    }
    #[test]
    fn io_selection_reads_leaf_disks_without_capacity_queries_or_tools() {
        let command = remote_command(&[HeaderMetric::DiskIo]);
        assert!(command.contains("/sys/block/*"));
        assert!(command.contains("/slaves/*"));
        assert!(command.contains("loop*|ram*|zram*"));
        assert!(command.contains("header_io_snapshot 1; sleep 1; header_io_snapshot 2"));
        for absent in ["df -Pk", "nvidia-smi", "iostat", "sudo"] {
            assert!(!command.contains(absent));
        }
        assert!(!remote_command(&[HeaderMetric::Disk]).contains("io_snapshot"));
    }
    #[test]
    fn pending_host_read_does_not_block_other_targets_and_releases_on_drop() {
        let state = HeaderMetricsState::default();
        let pending = state.begin(Some("slow-ssh")).unwrap();
        assert!(state.begin(Some("slow-ssh")).is_err());
        let local = state.begin(None).unwrap();
        let fast = state.begin(Some("fast-ssh")).unwrap();
        let named_local = state.begin(Some("local")).unwrap();
        assert!(state.begin(None).is_err());
        drop(pending);
        assert!(state.begin(Some("slow-ssh")).is_ok());
        drop((local, fast, named_local));
        assert!(state.0.lock().is_empty());
    }

    #[test]
    fn system_drive_normalizes_root_and_rejects_malformed_values() {
        for value in [
            None,
            Some(""),
            Some("C"),
            Some("\\"),
            Some("C:folder"),
            Some("12:"),
        ] {
            assert_eq!(system_drive(value), "C:");
        }
        for value in ["d:", "d:\\", " d:/ "] {
            assert_eq!(system_drive(Some(value)), "D:");
        }
    }

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
        let command = remote_command(&[HeaderMetric::Ram]);
        assert!(command.contains("/proc/meminfo"));
        assert!(!command.contains("/proc/stat"));
        assert!(!command.contains("sleep"));
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
    fn remote_disk_rejects_incomplete_or_impossible_capacity() {
        for text in [
            "disk_total=0\ndisk_free=0",
            "disk_total=100\ndisk_free=101",
            "disk_total=100",
            "disk_free=50",
            "disk_total=-1\ndisk_free=0",
        ] {
            let sample = parse_remote(text, &[HeaderMetric::Disk]);
            assert_eq!(sample.disk_total_kib, None, "{text}");
            assert_eq!(sample.disk_free_kib, None, "{text}");
            assert_eq!(sample.disk_label, None, "{text}");
        }
        let sample = parse_remote("disk_total=100\ndisk_free=0", &[HeaderMetric::Disk]);
        assert_eq!(sample.disk_free_kib, Some(0));
        assert_eq!(sample.disk_label.as_deref(), Some("/"));
    }

    #[test]
    fn remote_fields_accept_whitespace_consistently() {
        let sample = parse_remote(
            " disk_total = 100 \n disk_free = 40 \n uptime = 59 \n gpu = 12 ",
            &[HeaderMetric::Disk, HeaderMetric::Uptime, HeaderMetric::Gpu],
        );
        assert_eq!(sample.disk_total_kib, Some(100));
        assert_eq!(sample.disk_free_kib, Some(40));
        assert_eq!(sample.uptime_seconds, Some(59));
        assert_eq!(sample.gpu_percent, Some(12.0));
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
            HeaderMetric::DiskIo,
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
        eprintln!(
            "Windows disk I/O bytes/s: read={:?}, write={:?}",
            sample.disk_read_bytes_per_second, sample.disk_write_bytes_per_second
        );
        assert!(
            sample
                .disk_read_bytes_per_second
                .zip(sample.disk_write_bytes_per_second)
                .is_none_or(|(r, w)| r.is_finite() && w.is_finite() && r >= 0.0 && w >= 0.0)
        );
        let gpu = collect_local(&[HeaderMetric::Gpu]).unwrap();
        eprintln!("Windows GPU counter reading: {:?}", gpu.gpu_percent);
        assert!(
            gpu.gpu_percent
                .is_none_or(|value| (0.0..=100.0).contains(&value))
        );
    }
}
