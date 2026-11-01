$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$result = @{ sampledAt = [DateTime]::UtcNow.ToString('o'); cpuPercent = $null; cores = @(); load = @(); uptimeSeconds = $null;
    memory = @{ totalKib = $null; availableKib = $null; buffersKib = $null; cacheKib = $null; swapTotalKib = $null; swapFreeKib = $null };
    filesystems = $null; disks = $null; interfaces = $null; processes = $null; workloads = $null; warnings = @() }
function Read-Cim($class) { @(Get-CimInstance -ClassName $class -OperationTimeoutSec 2 -ErrorAction Stop) }
try {
    $os = (Read-Cim 'Win32_OperatingSystem')[0]
    $result.memory.totalKib = [long]$os.TotalVisibleMemorySize
    $result.memory.availableKib = [long]$os.FreePhysicalMemory
    $result.uptimeSeconds = [long]([DateTime]::Now - $os.LastBootUpTime).TotalSeconds
} catch { $result.warnings += 'Memory and uptime unavailable' }
try {
    $cpu = Read-Cim 'Win32_PerfFormattedData_PerfOS_Processor'
    $total = $cpu | Where-Object { $_.Name -eq '_Total' } | Select-Object -First 1
    if ($null -ne $total.PercentProcessorTime) { $result.cpuPercent = [Math]::Min(100, [double]$total.PercentProcessorTime) }
    $result.cores = @($cpu | Where-Object { $_.Name -ne '_Total' } | Select-Object -First 1024 | ForEach-Object {
        $percent = $null; if ($null -ne $_.PercentProcessorTime) { $percent = [Math]::Min(100, [double]$_.PercentProcessorTime) }
        @{ name = "cpu$($_.Name)"; percent = $percent }
    })
} catch { $result.warnings += 'CPU counters unavailable' }
try { $cache = (Read-Cim 'Win32_PerfFormattedData_PerfOS_Memory')[0]; if ($null -ne $cache.CacheBytes) { $result.memory.cacheKib = [long]($cache.CacheBytes / 1024) } } catch {}
try {
    $pages = Read-Cim 'Win32_PageFileUsage'
    $total = [long](($pages | Measure-Object AllocatedBaseSize -Sum).Sum * 1024)
    $used = [long](($pages | Measure-Object CurrentUsage -Sum).Sum * 1024)
    $result.memory.swapTotalKib = $total; $result.memory.swapFreeKib = [Math]::Max(0, $total - $used)
} catch {}
try {
    $result.filesystems = @(Read-Cim 'Win32_LogicalDisk' | Where-Object { $_.DriveType -eq 3 -and $_.Size -gt 0 } | ForEach-Object {
        @{ device = $_.DeviceID; mount = "$($_.DeviceID)\"; totalKib = [long]($_.Size / 1024); usedKib = [long](($_.Size - $_.FreeSpace) / 1024); availableKib = [long]($_.FreeSpace / 1024) }
    })
} catch { $result.warnings += 'Filesystems unavailable' }
try {
    $result.disks = @(Read-Cim 'Win32_PerfFormattedData_PerfDisk_PhysicalDisk' | Where-Object { $_.Name -ne '_Total' } | Select-Object -First 256 | ForEach-Object {
        $busy = $null; if ($null -ne $_.PercentDiskTime) { $busy = [Math]::Min(100, [double]$_.PercentDiskTime) }
        @{ name = $_.Name; readBytesPerSecond = $_.DiskReadBytesPersec; writeBytesPerSecond = $_.DiskWriteBytesPersec;
           operationsPerSecond = $_.DiskTransfersPersec; busyPercent = $busy }
    })
} catch { $result.warnings += 'Disk counters unavailable' }
try {
    $result.interfaces = @(Read-Cim 'Win32_PerfFormattedData_Tcpip_NetworkInterface' | Select-Object -First 256 | ForEach-Object {
        $errors = $null; $drops = $null
        if ($null -ne $_.PacketsReceivedErrors -and $null -ne $_.PacketsOutboundErrors) { $errors = [long]$_.PacketsReceivedErrors + [long]$_.PacketsOutboundErrors }
        if ($null -ne $_.PacketsReceivedDiscarded -and $null -ne $_.PacketsOutboundDiscarded) { $drops = [long]$_.PacketsReceivedDiscarded + [long]$_.PacketsOutboundDiscarded }
        @{ name = $_.Name; receiveBytesPerSecond = $_.BytesReceivedPersec; transmitBytesPerSecond = $_.BytesSentPersec;
           errors = $errors; drops = $drops }
    })
} catch { $result.warnings += 'Network counters unavailable' }
try {
    $cores = [Math]::Max(1, $result.cores.Count)
    $rows = @(Read-Cim 'Win32_PerfFormattedData_PerfProc_Process' | Where-Object { $_.IDProcess -gt 0 -and $_.Name -ne '_Total' })
    $top = @($rows | Sort-Object PercentProcessorTime -Descending | Select-Object -First 20)
    $top += @($rows | Sort-Object WorkingSetPrivate -Descending | Select-Object -First 20)
    $result.processes = @($top | Sort-Object IDProcess -Unique | ForEach-Object {
        $percent = $null; if ($null -ne $_.PercentProcessorTime) { $percent = [Math]::Min(100, [double]$_.PercentProcessorTime / $cores) }
        @{ pid = [int]$_.IDProcess; name = $_.Name; cpuPercent = $percent; memoryKib = [long]($_.WorkingSetPrivate / 1024) }
    })
} catch { $result.warnings += 'Process counters unavailable' }
if ($overviewWorkloads) {
    $work = @{ collectedAt = [DateTime]::UtcNow.ToString('o'); services = $null; containers = $null; listeners = $null; warnings = @() }
    try { $work.services = @(Read-Cim 'Win32_Service' | Group-Object State | ForEach-Object { @{ state = $_.Name.ToLowerInvariant(); count = $_.Count } }) } catch { $work.warnings += 'Services unavailable' }
    try {
        $tcp = @(Get-NetTCPConnection -State Listen -ErrorAction Stop)
        $udp = @(Get-NetUDPEndpoint -ErrorAction Stop)
        $work.listeners = @(@{ state = 'tcp listeners'; count = $tcp.Count }, @{ state = 'udp listeners'; count = $udp.Count })
        $work.listeners += @($tcp | Sort-Object LocalPort | Select-Object -First 8 | ForEach-Object { @{ state = "tcp $($_.LocalAddress):$($_.LocalPort)"; count = 1 } })
    } catch { $work.warnings += 'Listening sockets unavailable' }
    try {
        $docker = (Get-Command docker.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
        $start = New-Object System.Diagnostics.ProcessStartInfo
        $start.FileName = $docker; $start.Arguments = 'ps -a --format "{{.State}}|{{.Status}}"'
        $start.UseShellExecute = $false; $start.CreateNoWindow = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
        $process = New-Object System.Diagnostics.Process
        try {
            $process.StartInfo = $start; [void]$process.Start()
            $output = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
            if (!$process.WaitForExit(2000)) { $process.Kill(); throw 'Docker timed out' }
            if ($process.ExitCode -ne 0) { throw 'Docker daemon unavailable' }
            $states = @{}
            foreach ($line in ($output.Result -split "`n")) {
                $parts = $line.Trim() -split '\|', 2
                if ($parts.Count -ne 2) { continue }
                $states[$parts[0]]++
                if ($parts[1] -match '\(unhealthy\)') { $states['unhealthy']++ }
                elseif ($parts[1] -match '\(healthy\)') { $states['healthy']++ }
                elseif ($parts[1] -match 'health: starting') { $states['health starting']++ }
            }
            $work.containers = @($states.GetEnumerator() | ForEach-Object { @{ state = $_.Key; count = $_.Value } })
        } finally { $process.Dispose() }
    } catch { $work.warnings += 'Docker unavailable or daemon access denied' }
    $result.workloads = $work
}
$result.sampledAt = [DateTime]::UtcNow.ToString('o')
$result | ConvertTo-Json -Depth 8 -Compress
