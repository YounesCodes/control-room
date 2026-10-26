//! Bounded, read-only samples from the tools included with macOS.
use super::{HeaderMetric, HeaderMetrics, empty_sample, percent, set_disk_capacity};

pub(crate) fn script(metrics: &[HeaderMetric]) -> String {
    let mut script = String::from("LC_ALL=C; export LC_ALL; ");
    if metrics.contains(&HeaderMetric::Cpu) {
        script.push_str("/usr/bin/top -l 2 -s 1 -n 0 | /usr/bin/awk '/CPU usage:/ {idle=$7} END {print \"cpu_idle=\" idle}'; ");
    }
    if metrics.contains(&HeaderMetric::Ram) {
        script
            .push_str("printf 'memory_total='; /usr/sbin/sysctl -n hw.memsize; /usr/bin/vm_stat; ");
    }
    if metrics.contains(&HeaderMetric::Disk) {
        script.push_str("/bin/df -Pk / | /usr/bin/awk 'NR==2 {printf \"disk_total=%s\\ndisk_free=%s\\n\",$2,$4}'; ");
    }
    if metrics.contains(&HeaderMetric::Uptime) {
        script.push_str("printf 'now='; /bin/date +%s; /usr/sbin/sysctl -n kern.boottime | /usr/bin/awk '{gsub(/,/,\"\",$4); print \"boot=\" $4}'; ");
    }
    script
}

#[cfg(target_os = "macos")]
pub(super) fn collect(metrics: &[HeaderMetric]) -> Result<HeaderMetrics, String> {
    use std::{io::Read, process::Stdio, time::Duration};
    use wait_timeout::ChildExt;
    if metrics.is_empty() {
        return Ok(empty_sample());
    }
    let script = script(metrics);
    // The script contains only fixed commands. Neither paths nor frontend
    // strings become shell source, and each sample has a five-second budget.
    let mut child = crate::platform::background_command("/bin/sh")
        .args(["-c", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Could not sample macOS resources: {e}"))?;
    let status = child
        .wait_timeout(Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    if status.is_none() {
        let _ = child.kill();
        let _ = child.wait();
        return Err("macOS resource sampling timed out.".into());
    }
    let mut output = String::new();
    child
        .stdout
        .take()
        .ok_or("Missing macOS resource output")?
        .take(32 * 1024)
        .read_to_string(&mut output)
        .map_err(|e| e.to_string())?;
    Ok(parse(&output, metrics))
}

pub(crate) fn parse(text: &str, metrics: &[HeaderMetric]) -> HeaderMetrics {
    let mut sample = empty_sample();
    let (mut page_size, mut total, mut free, mut inactive, mut speculative) =
        (None, None, None, None, None);
    let (mut now, mut boot) = (None, None);
    for line in text.lines() {
        if let Some(size) = line.split("page size of ").nth(1) {
            page_size = size
                .split_whitespace()
                .next()
                .and_then(|v| v.parse::<u64>().ok());
        }
        if let Some((key, value)) = line.split_once('=') {
            let value = value.trim();
            match key {
                "cpu_idle" if metrics.contains(&HeaderMetric::Cpu) => {
                    sample.cpu_percent =
                        percent(value.trim_end_matches('%')).map(|idle| 100.0 - idle)
                }
                "memory_total" => total = value.parse::<u64>().ok(),
                "disk_total" if metrics.contains(&HeaderMetric::Disk) => {
                    sample.disk_total_kib = value.parse().ok()
                }
                "disk_free" if metrics.contains(&HeaderMetric::Disk) => {
                    sample.disk_free_kib = value.parse().ok()
                }
                "now" => now = value.parse::<u64>().ok(),
                "boot" => boot = value.parse::<u64>().ok(),
                _ => (),
            }
        }
        if let Some((key, value)) = line.split_once(':') {
            let pages = value.trim().trim_end_matches('.').parse::<u64>().ok();
            match key {
                "Pages free" => free = pages,
                "Pages inactive" => inactive = pages,
                "Pages speculative" => speculative = pages,
                _ => (),
            }
        }
    }
    if metrics.contains(&HeaderMetric::Ram) {
        let available = free
            .zip(inactive)
            .zip(speculative)
            .zip(page_size)
            .and_then(|(((a, b), c), size)| a.checked_add(b)?.checked_add(c)?.checked_mul(size));
        if let Some((total, available)) = total.zip(available).filter(|(t, a)| *t > 0 && a <= t) {
            sample.memory_total_kib = Some(total / 1024);
            sample.memory_available_kib = Some(available / 1024);
        }
    }
    if metrics.contains(&HeaderMetric::Uptime) {
        sample.uptime_seconds = now.zip(boot).and_then(|(now, boot)| now.checked_sub(boot));
    }
    let (total, free) = (sample.disk_total_kib, sample.disk_free_kib);
    set_disk_capacity(&mut sample, total, free, "/");
    // macOS has no stable, unprivileged system-wide GPU percentage API.
    sample
}

#[cfg(test)]
mod tests {
    use super::*;
    const SAMPLE: &str = "cpu_idle=72.5%\nmemory_total=8589934592\nMach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 10000.\nPages inactive: 20000.\nPages speculative: 1000.\ndisk_total=100000\ndisk_free=60000\nnow=1720000300\nboot=1720000000\n";
    #[test]
    fn parses_intel_and_apple_silicon_page_sizes_and_requested_readings() {
        let metrics = [
            HeaderMetric::Cpu,
            HeaderMetric::Ram,
            HeaderMetric::Disk,
            HeaderMetric::Uptime,
            HeaderMetric::Gpu,
        ];
        let sample = parse(SAMPLE, &metrics);
        assert_eq!(sample.cpu_percent, Some(27.5));
        assert_eq!(sample.memory_total_kib, Some(8388608));
        assert_eq!(sample.memory_available_kib, Some(496000));
        assert_eq!(
            parse(&SAMPLE.replace("16384", "4096"), &metrics).memory_available_kib,
            Some(124000)
        );
        assert_eq!(sample.disk_label.as_deref(), Some("/"));
        assert_eq!(sample.uptime_seconds, Some(300));
        assert_eq!(sample.gpu_percent, None);
        let disk = parse(SAMPLE, &[HeaderMetric::Disk]);
        assert_eq!(disk.cpu_percent, None);
        assert_eq!(disk.memory_total_kib, None);
        assert_eq!(disk.uptime_seconds, None);
    }
    #[test]
    fn incomplete_or_impossible_values_stay_unavailable() {
        let sample = parse(
            "cpu_idle=NaN\nmemory_total=1\nPages free: 99999999999999999999.\ndisk_total=10\ndisk_free=11\nboot=20\nnow=10",
            &[
                HeaderMetric::Cpu,
                HeaderMetric::Ram,
                HeaderMetric::Disk,
                HeaderMetric::Uptime,
            ],
        );
        assert_eq!(sample.cpu_percent, None);
        assert_eq!(sample.memory_available_kib, None);
        assert_eq!(sample.disk_total_kib, None);
        assert_eq!(sample.uptime_seconds, None);
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn samples_the_real_mac_without_elevation() {
        let sample = collect(&[
            HeaderMetric::Cpu,
            HeaderMetric::Ram,
            HeaderMetric::Disk,
            HeaderMetric::Uptime,
        ])
        .unwrap();
        assert!(sample.cpu_percent.is_some());
        assert!(sample.memory_total_kib.is_some());
        assert!(sample.disk_free_kib.is_some());
        assert!(sample.uptime_seconds.is_some());
    }
}
