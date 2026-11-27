# activate-dsh.ps1 — bring the DeepSeek Harness main window to the foreground.
# Called by pet-service when a "waiting for you" event fires (KuroCat mode), reusing the
# same window-enumeration approach as companion.py (title ends with "DeepSeek Harness").
# Exit codes: 0 = activated (or already foreground), 1 = window not found.
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class DshWin {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    public static IntPtr Find() {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) => {
            if (IsWindowVisible(h) && GetWindowTextLength(h) > 0) {
                var sb = new StringBuilder(GetWindowTextLength(h) + 1);
                GetWindowText(h, sb, sb.Capacity);
                if (sb.ToString().EndsWith("DeepSeek Harness")) { found = h; return false; }
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
}
"@
$h = [DshWin]::Find()
if ($h -eq [IntPtr]::Zero) { exit 1 }
[DshWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)  # Alt down: unlocks SetForegroundWindow
try {
    if ([DshWin]::IsIconic($h)) { [DshWin]::ShowWindow($h, 9) | Out-Null }  # SW_RESTORE
    [DshWin]::SetForegroundWindow($h) | Out-Null
} finally {
    [DshWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)  # Alt up
}
exit 0
