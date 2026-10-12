$ErrorActionPreference = 'Stop'
$fixture = Join-Path $PSScriptRoot '..\test-results\windows-shell-probe'
$fixture = [IO.Path]::GetFullPath($fixture)
if (!$fixture.StartsWith([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\test-results\')))) { throw 'Fixture path is outside test-results' }
$original = @{}
foreach ($name in @('WINDIR', 'LOCALAPPDATA', 'ProgramFiles', 'USERPROFILE')) { $original[$name] = [Environment]::GetEnvironmentVariable($name) }
try {
    $env:WINDIR = Join-Path $fixture 'Windows'
    $env:LOCALAPPDATA = Join-Path $fixture 'Local'
    $env:ProgramFiles = Join-Path $fixture 'Programs'
    $env:USERPROFILE = Join-Path $fixture 'User'
    $executables = @(
        (Join-Path $env:WINDIR 'System32\cmd.exe'),
        (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'),
        (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'),
        (Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'),
        (Join-Path $env:ProgramFiles 'Nu shell\nu.exe')
    )
    foreach ($path in $executables) {
        New-Item -ItemType Directory -Force (Split-Path $path) | Out-Null
        [IO.File]::WriteAllText($path, '')
    }
    function Get-CimInstance { @{ Caption = 'Windows 11 fixture'; Version = '10.0.26100'; OSArchitecture = '64-bit' } }
    function Get-ItemProperty { $null }
    function Get-Command { $null }
    $settings = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows Terminal\settings.json'
    New-Item -ItemType Directory -Force (Split-Path $settings) | Out-Null
    $custom = $executables[-1]
    $json = @{ profiles = @{ list = @(
        @{ name = 'Custom Nu'; commandline = ('"' + $custom + '" --login'); hidden = $false },
        @{ name = 'Hidden'; commandline = ('"' + $custom + '"'); hidden = $true },
        @{ name = 'Missing'; commandline = 'missing.exe' }
    ) } } | ConvertTo-Json -Depth 8
    $json = "// comment`n" + $json -replace '(\s*)}$', ', $1}'
    [IO.File]::WriteAllText($settings, $json)
    $probe = Join-Path $PSScriptRoot '..\src-tauri\src\windows_ssh_probe.ps1'
    $result = (& $probe) | ConvertFrom-Json
    $ids = @($result.shells | ForEach-Object { $_.id })
    foreach ($id in @('powershell', 'powershell-7', 'cmd', 'git-bash')) { if ($id -notin $ids) { throw "Expected shell $id" } }
    $profile = $result.shells | Where-Object { $_.label -eq 'Windows Terminal: Custom Nu' }
    if (!$profile -or $profile.executable -ne $custom -or $profile.arguments[0] -ne '--login') { throw 'Custom Terminal profile was not resolved correctly' }
    if (@($result.shells | Where-Object { $_.label -match 'Hidden|Missing' }).Count) { throw 'Unavailable or hidden profiles were offered' }
    if (!$result.windowsTerminalAvailable -or $result.profileError -or $result.capabilities.osId -ne 'windows') { throw 'Invalid host discovery result' }
    [IO.File]::WriteAllText($settings, '{invalid json')
    $result = (& $probe) | ConvertFrom-Json
    if (!$result.profileError -or @($result.shells).Count -ne 4) { throw 'Malformed profiles prevented normal shell discovery' }
    Write-Output 'Windows shell discovery fixtures passed.'
} finally {
    foreach ($name in $original.Keys) { [Environment]::SetEnvironmentVariable($name, $original[$name]) }
    Remove-Item -LiteralPath $fixture -Recurse -Force
}
