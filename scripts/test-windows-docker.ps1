$ErrorActionPreference = 'Stop'
$fixture = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\test-results\windows-docker-fixture'))
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\test-results\'))
if (!$fixture.StartsWith($root)) { throw 'Fixture path is outside test-results' }
$originalProgramFiles = $env:ProgramFiles
try {
    $path = Join-Path $fixture 'Docker\Docker\resources\bin\docker.exe'
    New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
    $id = 'c' * 64
    $row = @{ ID = $id; Names = 'fixture-web'; Image = 'fixture:latest'; State = 'running'; Status = 'Up 1 minute'; Ports = '0.0.0.0:8080->8080/tcp'; CreatedAt = '2026-10-12 00:00:00 +0000 UTC' } | ConvertTo-Json -Compress
    $details = @(@{ Id = $id; Name = '/fixture-web'; Image = ('sha256:' + ('d' * 64));
        Config = @{ Image = 'fixture:latest'; Env = @('FIXTURE_ENV=private_fixture_value'); Labels = @{ 'com.docker.compose.project' = 'fixture'; 'com.docker.compose.service' = 'web'; 'com.docker.compose.container-number' = '1'; 'com.docker.compose.oneoff' = 'False' } };
        State = @{ Status = 'running'; Running = $true; ExitCode = 0; StartedAt = '2026-10-12T00:00:00Z' };
        HostConfig = @{ RestartPolicy = @{ Name = 'unless-stopped'; MaximumRetryCount = 0 } };
        NetworkSettings = @{ Ports = @{ '8080/tcp' = @(@{ HostIp = '0.0.0.0'; HostPort = '8080' }) }; Networks = @{} }; Mounts = @()
    })
    $inspect = ConvertTo-Json -InputObject $details -Depth 10 -Compress
    $rowString = $row.Replace('"', '""')
    $inspectString = $inspect.Replace('"', '""')
    $source = @"
using System;
public class FixtureDocker {
    public static void Main(string[] args) {
        if (args.Length == 0) { Environment.Exit(1); }
        if (args[0] == "ps") { Console.WriteLine(@"$rowString"); }
        else if (args[0] == "inspect") { Console.WriteLine(@"$inspectString"); }
        else if (args[0] == "logs") { Console.WriteLine("WINDOWS_DOCKER_LOG_FIXTURE_OK"); Console.Error.WriteLine("WINDOWS_DOCKER_STDERR_FIXTURE_OK"); }
        else if (args[0] == "info") { Console.WriteLine("\"fixture-server\""); }
        else { Environment.Exit(1); }
    }
}
"@
    Add-Type -TypeDefinition $source -OutputAssembly $path -OutputType ConsoleApplication
    $env:ProgramFiles = $fixture
    function Get-Command { $null }
    $operation = 'docker-list'
    $reader = Join-Path $PSScriptRoot '..\src-tauri\src\windows_inspection.ps1'
    $text = & $reader
    $list = @($text | ConvertFrom-Json)
    if ($list.Count -ne 1 -or $list[0].ComposeProject -ne 'fixture' -or $list[0].ComposeService -ne 'web') { throw 'Windows Docker list lost Compose metadata' }
    if ($text.Contains('private_fixture_value')) { throw 'Docker list leaked container environment' }
    $operation = 'docker-inspect'
    $container = $id
    $readDetails = (& $reader) | ConvertFrom-Json
    if ($readDetails[0].Id -ne $id -or $readDetails[0].NetworkSettings.Ports.'8080/tcp'[0].HostPort -ne '8080') { throw 'Windows Docker inspect did not preserve raw container data' }
    $capabilities = ((& (Join-Path $PSScriptRoot '..\src-tauri\src\windows_ssh_probe.ps1')) | ConvertFrom-Json).capabilities
    if (!$capabilities.dockerAvailable -or !$capabilities.dockerAccessible -or $capabilities.dockerVersion -ne 'fixture-server') { throw 'Windows Docker capability probe failed' }
    $script = "`$ErrorActionPreference='Continue'; & '$path' logs --tail 50 '$id' 2>&1 | ForEach-Object { [Console]::WriteLine(`$_.ToString()) }; exit `$LASTEXITCODE"
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
    $log = & powershell.exe -NoProfile -EncodedCommand $encoded
    if ('WINDOWS_DOCKER_LOG_FIXTURE_OK' -notin $log -or 'WINDOWS_DOCKER_STDERR_FIXTURE_OK' -notin $log) { throw 'Encoded Windows Docker log command failed to preserve stdout or stderr' }
    Write-Output 'Windows Docker command, Compose metadata, inspect, and log fixtures passed.'
} finally {
    $env:ProgramFiles = $originalProgramFiles
    Remove-Item -LiteralPath $fixture -Recurse -Force
}
