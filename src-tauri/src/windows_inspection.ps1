$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Owner-Name($processId) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($process) { return $process.ProcessName }
    return $null
}
function Docker-Path {
    $command = Get-Command docker.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    $path = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe'
    if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
    throw 'Docker CLI was not found on this Windows host.'
}
function Check-Docker {
    if ($LASTEXITCODE -ne 0) { throw 'Docker could not read the daemon. Check that Docker is running and this SSH account has access.' }
}
switch ($operation) {
    'ports' {
        $rows = New-Object System.Collections.Generic.List[object]
        $tcp = @(Get-NetTCPConnection | Where-Object { $_.State -eq 'Listen' })
        $udp = @(Get-NetUDPEndpoint)
        foreach ($source in @(@{ protocol = 'tcp'; sockets = $tcp }, @{ protocol = 'udp'; sockets = $udp })) {
            foreach ($socket in $source.sockets) {
                $name = Owner-Name $socket.OwningProcess
                $family = 'ipv4'; if ($socket.LocalAddress.Contains(':')) { $family = 'ipv6' }
                $ownership = 'unavailable'; if ($name) { $ownership = 'known' }
                $rows.Add(@{ id = "$($source.protocol)|$($socket.LocalAddress)|$($socket.LocalPort)|$($socket.OwningProcess)";
                    protocol = $source.protocol; addressFamily = $family; localAddress = $socket.LocalAddress;
                    port = [int]$socket.LocalPort; processId = [int]$socket.OwningProcess; processName = $name;
                    systemdUnit = $null; ownership = $ownership })
            }
        }
        ConvertTo-Json -InputObject @($rows.ToArray() | Sort-Object port, localAddress) -Depth 5 -Compress
    }
    'connections' {
        $all = @(Get-NetTCPConnection | Where-Object { $_.State -eq 'Established' })
        $rows = @($all | Select-Object -First 4000)
        $groups = @($rows | Group-Object LocalPort, OwningProcess)
        $result = @($groups | Select-Object -First 200 | ForEach-Object {
            $first = $_.Group[0]
            $remotes = @($_.Group | Group-Object RemoteAddress | Sort-Object Count -Descending)
            @{ key = "tcp|$($first.LocalPort)|$($first.OwningProcess)"; protocol = 'tcp'; localPort = [int]$first.LocalPort;
               processName = (Owner-Name $first.OwningProcess); processId = [int]$first.OwningProcess; systemdUnit = $null;
               established = $_.Count; remoteAddressCount = $remotes.Count;
               remotes = @($remotes | Select-Object -First 20 | ForEach-Object { @{ address = $_.Name; count = $_.Count } }) }
        })
        @{ groups = $result; totalEstablished = $all.Count; truncated = ($all.Count -gt 4000 -or $groups.Count -gt 200); collectedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Depth 7 -Compress
    }
    'services' {
        $rows = @(Get-CimInstance Win32_Service | Sort-Object DisplayName | ForEach-Object {
            $processId = $null; if ($_.ProcessId -gt 0) { $processId = [int]$_.ProcessId }
            @{ id = $_.Name; displayName = $_.DisplayName; description = $_.Description; state = $_.State.ToLowerInvariant(); startMode = $_.StartMode; processId = $processId }
        })
        ConvertTo-Json -InputObject $rows -Depth 4 -Compress
    }
    'firewall' {
        $profiles = @(Get-NetFirewallProfile)
        $enabled = @($profiles | Where-Object { $_.Enabled -eq $true })
        $policies = @($profiles | ForEach-Object { "$($_.Name): enabled=$($_.Enabled), incoming=$($_.DefaultInboundAction)" }) -join '; '
        @{ backend = 'windows'; available = $true; active = ($enabled.Count -gt 0); defaultIncoming = $policies; rules = @(); collectedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Depth 4 -Compress
    }
    'metrics' {
        $result = @{ sampledAt = [DateTime]::UtcNow.ToString('o'); cpuPercent = $null; memoryTotalKib = $null; memoryAvailableKib = $null; gpuPercent = $null; diskTotalKib = $null; diskFreeKib = $null; diskLabel = $null; diskReadBytesPerSecond = $null; diskWriteBytesPerSecond = $null; uptimeSeconds = $null }
        if ('ram' -in $wanted -or 'uptime' -in $wanted) {
            $os = Get-CimInstance Win32_OperatingSystem
            if ('ram' -in $wanted) { $result.memoryTotalKib = [long]$os.TotalVisibleMemorySize; $result.memoryAvailableKib = [long]$os.FreePhysicalMemory }
            if ('uptime' -in $wanted) { $result.uptimeSeconds = [long]([DateTime]::Now - $os.LastBootUpTime).TotalSeconds }
        }
        if ('cpu' -in $wanted) {
            $cpu = @(Get-CimInstance Win32_Processor)
            $values = @($cpu | Where-Object { $null -ne $_.LoadPercentage })
            if ($values.Count) { $result.cpuPercent = [double](($values | Measure-Object LoadPercentage -Average).Average) }
        }
        if ('disk' -in $wanted) {
            $disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Where-Object { $_.Size -gt 0 })
            if ($disks.Count) { $result.diskTotalKib = [long](($disks | Measure-Object Size -Sum).Sum / 1024); $result.diskFreeKib = [long](($disks | Measure-Object FreeSpace -Sum).Sum / 1024); $result.diskLabel = 'Fixed drives' }
        }
        if ('diskIo' -in $wanted) {
            try {
                $io = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'" -OperationTimeoutSec 2 -ErrorAction Stop
                if ($null -ne $io.DiskReadBytesPersec -and $null -ne $io.DiskWriteBytesPersec) {
                    $result.diskReadBytesPerSecond = [double]$io.DiskReadBytesPersec
                    $result.diskWriteBytesPerSecond = [double]$io.DiskWriteBytesPersec
                }
            } catch { $result.diskReadBytesPerSecond = $null; $result.diskWriteBytesPerSecond = $null }
        }
        if ('gpu' -in $wanted) {
            try {
                $engines = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -OperationTimeoutSec 1 -ErrorAction Stop | Where-Object { $_.Name -match 'engtype_3D' })
                if ($engines.Count) {
                    $loads = @($engines | Group-Object { $_.Name -replace '^pid_\d+_', '' } | ForEach-Object { ($_.Group | Measure-Object UtilizationPercentage -Sum).Sum })
                    $result.gpuPercent = [Math]::Min(100, [double](($loads | Measure-Object -Maximum).Maximum))
                }
            } catch { $result.gpuPercent = $null }
        }
        $result | ConvertTo-Json -Compress
    }
    'docker-list' {
        $docker = Docker-Path
        $rows = @(& $docker ps -a --no-trunc --format '{{json .}}'); Check-Docker
        $objects = @($rows | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json } | Select-Object -First 200)
        if (!$objects.Count) { '[]'; break }
        $ids = @($objects | ForEach-Object { $_.ID })
        $raw = & $docker inspect --type container @ids; Check-Docker
        $details = @($raw -join "`n" | ConvertFrom-Json)
        $byId = @{}; foreach ($detail in $details) { $byId[$detail.Id] = $detail }
        $result = @($objects | ForEach-Object {
            $labels = $byId[$_.ID].Config.Labels
            @{ ID = $_.ID; Names = $_.Names; Image = $_.Image; State = $_.State; Status = $_.Status; Ports = $_.Ports; CreatedAt = $_.CreatedAt;
               ComposeProject = $labels.'com.docker.compose.project'; ComposeService = $labels.'com.docker.compose.service';
               ComposeContainerNumber = $labels.'com.docker.compose.container-number'; ComposeOneoff = $labels.'com.docker.compose.oneoff' }
        })
        ConvertTo-Json -InputObject $result -Depth 5 -Compress
    }
    'docker-inspect' {
        $docker = Docker-Path
        & $docker inspect --type container -- $container; Check-Docker
    }
    default { throw 'Unsupported Windows inspection operation.' }
}
