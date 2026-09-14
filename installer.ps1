$ErrorActionPreference = "Stop"

function Fail([string]$Message) {
    Write-Host $Message -ForegroundColor Red
    exit 1
}

if (Get-Process zotero -ErrorAction SilentlyContinue) {
    Fail "Close Zotero first, then run install.cmd again."
}

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$scriptsDir = Join-Path $root "scripts"
$scriptFiles = @(
    "sync-attachments.js",
    "document2md.js"
)
foreach ($name in $scriptFiles) {
    if (-not (Test-Path (Join-Path $scriptsDir $name))) {
        Fail "Missing scripts\$name. Download the complete Release again."
    }
}

$zoteroRoot = Join-Path $env:APPDATA "Zotero\Zotero"
$profilesIni = Join-Path $zoteroRoot "profiles.ini"
if (-not (Test-Path $profilesIni)) {
    Fail "Zotero profile not found. Install and run Zotero once first."
}

$profiles = @()
$current = $null
foreach ($rawLine in [IO.File]::ReadAllLines($profilesIni)) {
    $line = $rawLine.Trim()
    if ($line -match '^\[Profile\d+\]$') {
        if ($current) {
            $profiles += [pscustomobject]$current
        }
        $current = @{}
        continue
    }
    if ($current -and $line -match '^([^=]+)=(.*)$') {
        $current[$matches[1]] = $matches[2]
    }
}
if ($current) {
    $profiles += [pscustomobject]$current
}

$profile = $profiles | Where-Object { $_.Default -eq "1" } | Select-Object -First 1
if (-not $profile -and $profiles.Count -eq 1) {
    $profile = $profiles[0]
}
if (-not $profile) {
    Fail "Cannot determine the default Zotero profile."
}

$profilePath = if ($profile.IsRelative -eq "1") {
    Join-Path $zoteroRoot ($profile.Path -replace '/', '\')
}
else {
    $profile.Path
}
$prefsPath = Join-Path $profilePath "prefs.js"
if (-not (Test-Path $prefsPath)) {
    Fail "Zotero prefs.js not found."
}

$pluginXpi = Join-Path $profilePath "extensions\zoterotag@euclpts.com.xpi"
$pluginDir = Join-Path $profilePath "extensions\zoterotag@euclpts.com"
if (-not (Test-Path $pluginXpi) -and -not (Test-Path $pluginDir)) {
    Fail "Zotero Actions & Tags is not installed."
}

$secureKey = Read-Host "Enter the group API Key" -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
try {
    $apiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
}
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    Fail "API Key cannot be empty."
}

$syncMenu = [Text.Encoding]::UTF8.GetString(
    [Convert]::FromBase64String("5ZCM5q2l6ZmE5Lu2")
)

$hiddenMenu = [ordered]@{
    item = $false
    collection = $false
    tools = $false
    reader = $false
    readerAnnotation = $false
}
$visibleMenu = [ordered]@{
    item = $true
    collection = $true
    tools = $false
    reader = $false
    readerAnnotation = $false
}

$actions = @(
    [pscustomobject]@{
        key = "1786529156738-JlgQvNK5"
        name = "document2md"
        menu = "document2md"
        showInMenu = $hiddenMenu
        file = "document2md.js"
    },
    [pscustomobject]@{
        key = "sync-attachments"
        name = $syncMenu
        menu = $syncMenu
        showInMenu = $visibleMenu
        file = "sync-attachments.js"
    }
)

$backupPath = "$prefsPath.zotero-actions.bak"
Copy-Item $prefsPath $backupPath -Force

$lines = [Collections.Generic.List[string]]::new()
foreach ($line in [IO.File]::ReadAllLines($prefsPath)) {
    [void]$lines.Add($line)
}

foreach ($definition in $actions) {
    $data = [IO.File]::ReadAllText(
        (Join-Path $scriptsDir $definition.file),
        [Text.Encoding]::UTF8
    )
    $action = [ordered]@{
        event = 0
        operation = 4
        data = $data
        shortcut = ""
        enabled = $true
        menu = $definition.menu
        name = $definition.name
        showInMenu = $definition.showInMenu
    }
    $actionJson = ConvertTo-Json -InputObject $action -Depth 10 -Compress
    $prefValue = ConvertTo-Json -InputObject $actionJson -Compress
    $prefName = "extensions.actionsTags.rules.$($definition.key)"
    $prefix = 'user_pref("' + $prefName + '", '
    $newLine = $prefix + $prefValue + ');'

    $matches = @()
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index].StartsWith($prefix)) {
            $matches += $index
        }
    }
    if ($matches.Count -gt 1) {
        Fail "Duplicate Action in prefs.js: $($definition.key)"
    }
    if ($matches.Count -eq 1) {
        $lines[$matches[0]] = $newLine
    }
    else {
        [void]$lines.Add($newLine)
    }
}

$utf8 = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllLines($prefsPath, $lines, $utf8)

[Environment]::SetEnvironmentVariable(
    "DOCUMENT2MD_PROFILE",
    "server",
    [EnvironmentVariableTarget]::User
)
[Environment]::SetEnvironmentVariable(
    "CHEN_GROUP_API_KEY_MEMBER",
    $apiKey,
    [EnvironmentVariableTarget]::User
)

Write-Host "Installed. Reopen Zotero and use the Sync Attachments action." -ForegroundColor Green

