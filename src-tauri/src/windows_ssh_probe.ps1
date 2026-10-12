$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$os = Get-CimInstance Win32_OperatingSystem
$defaultShell = (Get-ItemProperty 'HKLM:\SOFTWARE\OpenSSH' -ErrorAction SilentlyContinue).DefaultShell
if (!$defaultShell) { $defaultShell = Join-Path $env:WINDIR 'System32\cmd.exe' }
$shells = New-Object System.Collections.Generic.List[object]
$seen = @{}
function Add-Shell($id, $label, $path, $arguments) {
    if (!$path -or !(Test-Path -LiteralPath $path -PathType Leaf)) { return }
    $key = $path.ToLowerInvariant()
    if ($seen.ContainsKey($key)) { return }
    $seen[$key] = $true
    $shells.Add(@{ id = $id; label = $label; executable = $path; arguments = @($arguments) })
}
function Find-Shell($name) {
    $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
}
Add-Shell 'powershell' 'Windows PowerShell' (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') @('-NoLogo')
$pwsh = Find-Shell 'pwsh.exe'
if (!$pwsh) { $pwsh = Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe' }
Add-Shell 'powershell-7' 'PowerShell 7' $pwsh @('-NoLogo')
Add-Shell 'cmd' 'Command Prompt' (Join-Path $env:WINDIR 'System32\cmd.exe') @('/Q')
$gitPaths = @(
    (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe'),
    (Join-Path $env:USERPROFILE 'scoop\apps\git\current\bin\bash.exe')
)
$git = Find-Shell 'git.exe'
if ($git) { $gitPaths += Join-Path (Split-Path (Split-Path $git)) 'bin\bash.exe' }
foreach ($path in $gitPaths) {
    if (Test-Path -LiteralPath $path -PathType Leaf) { Add-Shell 'git-bash' 'Git Bash' $path @('--login', '-i'); break }
}
foreach ($entry in @(
    @{ name = 'nu.exe'; id = 'nushell'; label = 'Nushell'; args = @() },
    @{ name = 'fish.exe'; id = 'fish'; label = 'Fish'; args = @('-l', '-i') },
    @{ name = 'zsh.exe'; id = 'zsh'; label = 'Zsh'; args = @('-l', '-i') },
    @{ name = 'elvish.exe'; id = 'elvish'; label = 'Elvish'; args = @() },
    @{ name = 'xonsh.exe'; id = 'xonsh'; label = 'Xonsh'; args = @('-i') }
)) { Add-Shell $entry.id $entry.label (Find-Shell $entry.name) $entry.args }
# Offer the configured OpenSSH shell even when it lives outside the usual paths.
Add-Shell 'ssh-default' 'SSH default shell' $defaultShell @()
$wslError = $null
$wsl = Find-Shell 'wsl.exe'
if ($wsl) {
    # wsl.exe writes UTF-16 on older Windows 10 builds, leaving NULs in PS strings.
    try {
        $distributions = @(& $wsl --list --quiet 2>$null)
        if ($LASTEXITCODE -ne 0) { throw 'WSL listing failed' }
        foreach ($line in $distributions) {
            $name = ($line -replace "`0", '').Trim()
            if ($name) { $shells.Add(@{ id = "wsl:$name"; label = "WSL: $name"; executable = $wsl; arguments = @('--distribution', $name) }) }
        }
    } catch { $wslError = 'WSL is installed, but its distribution list could not be read.' }
}
$terminalPaths = @(
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\wt.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows Terminal\settings.json')
)
$terminalAvailable = [bool](Find-Shell 'wt.exe')
foreach ($path in $terminalPaths) { if (Test-Path -LiteralPath $path) { $terminalAvailable = $true } }
$settingsFiles = @(Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.WindowsTerminal*\LocalState\settings.json') -ErrorAction SilentlyContinue)
$unpackaged = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows Terminal\settings.json'
if (Test-Path -LiteralPath $unpackaged) { $settingsFiles += Get-Item -LiteralPath $unpackaged }
$profileError = $null
foreach ($file in $settingsFiles) {
    $terminalAvailable = $true
    try {
        # Remove JSON comments and trailing commas while preserving quoted strings.
        $json = Get-Content -Raw -LiteralPath $file.FullName
        $json = [regex]::Replace($json, '(?s)"(?:\\.|[^"\\])*"|//[^\r\n]*|/\*.*?\*/', {
            param($match) if ($match.Value.StartsWith('"')) { $match.Value } else { '' }
        })
        $json = [regex]::Replace($json, '(?s)"(?:\\.|[^"\\])*"|,\s*(?=[}\]])', {
            param($match) if ($match.Value.StartsWith('"')) { $match.Value } else { '' }
        })
        $settings = $json | ConvertFrom-Json
        $profiles = $settings.profiles.list
        if (!$profiles) { $profiles = $settings.profiles }
        foreach ($profile in $profiles) {
            if ($profile.hidden -or !$profile.commandline -or !$profile.name) { continue }
            $line = [Environment]::ExpandEnvironmentVariables($profile.commandline)
            $tokens = @([regex]::Matches($line, '"([^"\r\n]*)"|([^\s"]+)') | ForEach-Object {
                if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value }
            })
            if (!$tokens.Count) { continue }
            $path = $tokens[0]
            if (!(Test-Path -LiteralPath $path -PathType Leaf)) { $path = Find-Shell $path }
            if (!$path -or !(Test-Path -LiteralPath $path -PathType Leaf)) { continue }
            # A Terminal profile must launch a command-line shell, not wt or SSH.
            $basename = [IO.Path]::GetFileName($path).ToLowerInvariant()
            if ($basename -notin @('powershell.exe', 'pwsh.exe', 'cmd.exe', 'bash.exe', 'zsh.exe', 'fish.exe', 'nu.exe', 'elvish.exe', 'xonsh.exe', 'wsl.exe')) { continue }
            $arguments = @()
            if ($tokens.Count -gt 1) { $arguments = @($tokens[1..($tokens.Count-1)]) }
            $id = 'terminal:' + $file.Directory.Parent.Name + ':' + $profile.name
            $shells.Add(@{ id = $id; label = 'Windows Terminal: ' + $profile.name; executable = $path; arguments = $arguments })
        }
    } catch { $profileError = 'Some Windows Terminal profiles could not be read. Detected shells remain available.' }
}
@{
    capabilities = @{
        hostname = $env:COMPUTERNAME; osId = 'windows'; osFamily = 'windows';
        osName = $os.Caption; osVersion = $os.Version; kernel = $os.Version;
        architecture = $os.OSArchitecture; defaultShell = $defaultShell
    }
    shells = @($shells.ToArray()); windowsTerminalAvailable = $terminalAvailable; wslError = $wslError; profileError = $profileError
} | ConvertTo-Json -Depth 6 -Compress
