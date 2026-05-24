param(
    [int]$CapturePid = 0,
    [string]$DeleteHwnds = ''
)

$ErrorActionPreference = 'SilentlyContinue'

$code = @"
using System;
using System.Runtime.InteropServices;

public static class TrayRefreshNative {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", SetLastError=true)]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll", SetLastError=true)]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError=true)]
    public static extern bool SendNotifyMessage(IntPtr hWnd, uint Msg, UIntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern uint RegisterWindowMessageW(string lpString);

    [DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);

    [DllImport("shell32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    public static extern bool Shell_NotifyIcon(uint dwMessage, ref NOTIFYICONDATA lpData);

    public static readonly IntPtr HWND_BROADCAST = new IntPtr(0xFFFF);

    public const uint NIM_DELETE = 0x00000002;
    public const uint NIF_MESSAGE = 0x00000001;
    public const uint NIF_ICON = 0x00000002;
    public const uint NIF_TIP = 0x00000004;
    public const uint NIF_GUID = 0x00000020;

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct NOTIFYICONDATA {
        public uint cbSize;
        public IntPtr hWnd;
        public uint uID;
        public uint uFlags;
        public uint uCallbackMessage;
        public IntPtr hIcon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=128)]
        public string szTip;
        public uint dwState;
        public uint dwStateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)]
        public string szInfo;
        public uint uTimeoutOrVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)]
        public string szInfoTitle;
        public uint dwInfoFlags;
        public Guid guidItem;
        public IntPtr hBalloonIcon;
    }
}
"@

Add-Type -TypeDefinition $code

$WM_MOUSEMOVE = 0x0200

function Get-ProcessWindowHandles([uint32]$targetPid) {
    $handles = New-Object System.Collections.Generic.List[string]
    $callback = [TrayRefreshNative+EnumWindowsProc]{
        param([IntPtr]$hwnd, [IntPtr]$lparam)
        $pid = 0
        [void][TrayRefreshNative]::GetWindowThreadProcessId($hwnd, [ref]$pid)
        if ($pid -eq $targetPid) {
            $handles.Add($hwnd.ToInt64().ToString())
        }
        return $true
    }
    [void][TrayRefreshNative]::EnumWindows($callback, [IntPtr]::Zero)
    return $handles
}

if ($CapturePid -gt 0) {
    Get-ProcessWindowHandles ([uint32]$CapturePid)
    exit 0
}

function Remove-NotifyIconsByHwnd([string]$hwnds) {
    if ([string]::IsNullOrWhiteSpace($hwnds)) { return }

    foreach ($raw in $hwnds.Split(',')) {
        $trimmed = $raw.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed)) { continue }

        $hwndValue = 0L
        if (-not [long]::TryParse($trimmed, [ref]$hwndValue)) { continue }
        $hwnd = [IntPtr]::new($hwndValue)

        for ($uid = 0; $uid -le 64; $uid++) {
            $data = New-Object TrayRefreshNative+NOTIFYICONDATA
            $data.cbSize = [uint32][System.Runtime.InteropServices.Marshal]::SizeOf([type][TrayRefreshNative+NOTIFYICONDATA])
            $data.hWnd = $hwnd
            $data.uID = [uint32]$uid
            [void][TrayRefreshNative]::Shell_NotifyIcon([TrayRefreshNative]::NIM_DELETE, [ref]$data)
        }
    }
}

function New-LParam([int]$x, [int]$y) {
    $value = (($y -band 0xffff) -shl 16) -bor ($x -band 0xffff)
    return [IntPtr]::new($value)
}

function Get-ClassName([IntPtr]$hwnd) {
    $builder = New-Object System.Text.StringBuilder 256
    [void][TrayRefreshNative]::GetClassName($hwnd, $builder, $builder.Capacity)
    return $builder.ToString()
}

function Invoke-ToolbarSweep([IntPtr]$toolbar) {
    if ($toolbar -eq [IntPtr]::Zero) { return }

    $rect = New-Object TrayRefreshNative+RECT
    if (-not [TrayRefreshNative]::GetClientRect($toolbar, [ref]$rect)) { return }

    $width = [Math]::Max(1, $rect.Right - $rect.Left)
    $height = [Math]::Max(1, $rect.Bottom - $rect.Top)

    for ($y = 0; $y -le $height; $y += 8) {
        for ($x = 0; $x -le $width; $x += 8) {
            [void][TrayRefreshNative]::SendMessage($toolbar, $WM_MOUSEMOVE, [IntPtr]::Zero, (New-LParam $x $y))
        }
    }
}

function Invoke-TraySweep([IntPtr]$root) {
    if ($root -eq [IntPtr]::Zero) { return }

    $callback = [TrayRefreshNative+EnumWindowsProc]{
        param([IntPtr]$hwnd, [IntPtr]$lparam)
        if ((Get-ClassName $hwnd) -eq 'ToolbarWindow32') {
            Invoke-ToolbarSweep $hwnd
        }
        return $true
    }

    [void][TrayRefreshNative]::EnumChildWindows($root, $callback, [IntPtr]::Zero)
}

Remove-NotifyIconsByHwnd $DeleteHwnds

$shellTray = [TrayRefreshNative]::FindWindow('Shell_TrayWnd', $null)
Invoke-TraySweep $shellTray

$secondaryTray = [TrayRefreshNative]::FindWindow('Shell_SecondaryTrayWnd', $null)
Invoke-TraySweep $secondaryTray

$overflow = [TrayRefreshNative]::FindWindow('NotifyIconOverflowWindow', $null)
Invoke-TraySweep $overflow

$taskbarCreated = [TrayRefreshNative]::RegisterWindowMessageW('TaskbarCreated')
if ($taskbarCreated -ne 0) {
    [void][TrayRefreshNative]::SendNotifyMessage([TrayRefreshNative]::HWND_BROADCAST, $taskbarCreated, [UIntPtr]::Zero, [IntPtr]::Zero)
}
