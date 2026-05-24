$ErrorActionPreference = 'SilentlyContinue'

$nodePath = $env:KUROTAN_WATCHDOG_NODE
$watchdogScript = $env:KUROTAN_WATCHDOG_SCRIPT
$parentPid = $env:KUROTAN_WATCHDOG_PARENT_PID
$refreshScript = $env:KUROTAN_WATCHDOG_REFRESH_SCRIPT
$logPath = $env:KUROTAN_WATCHDOG_LOG
$runtimePath = $env:KUROTAN_WATCHDOG_RUNTIME

function Write-WatchdogLog([string]$message) {
    if ([string]::IsNullOrWhiteSpace($logPath)) { return }
    try {
        Add-Content -Path $logPath -Encoding UTF8 -Value "[$((Get-Date).ToUniversalTime().ToString('o'))] tray-watchdog-launcher $message"
    } catch {
        # Best effort only.
    }
}

if ([string]::IsNullOrWhiteSpace($nodePath)) { $nodePath = 'node.exe' }

if ([string]::IsNullOrWhiteSpace($watchdogScript) -or
    [string]::IsNullOrWhiteSpace($parentPid) -or
    [string]::IsNullOrWhiteSpace($refreshScript)) {
    Write-WatchdogLog 'missing-arguments'
    exit 0
}

$arguments = @(
    $watchdogScript,
    '--parent-pid', $parentPid,
    '--script', $refreshScript,
    '--log', $logPath,
    '--runtime', $runtimePath
)

try {
    $proc = Start-Process -FilePath $nodePath -ArgumentList $arguments -WindowStyle Hidden -PassThru
    Write-WatchdogLog "started pid=$($proc.Id) node=$nodePath parent=$parentPid"
} catch {
    Write-WatchdogLog "start-failed $($_.Exception.Message)"
}
