// Window geometry for the mascot's roam mode: where the other apps' windows
// are, front to back, so a roaming companion can stand on their top edges
// and duck behind the ones in front.
//
// Windows only, from Win32 itself — the same source every desktop pet that
// walks on windows uses (Shimeji-ee walks GetWindow/GetWindowRect, eSheep
// and MateEngine call EnumWindows). Rather than a native Node module (one
// more thing to rebuild per Electron ABI and to package for three
// platforms), a small C# helper is compiled into a PowerShell process that
// stays alive while roaming and prints a JSON line whenever the picture
// changes. Polled at 8 Hz: MateEngine's idle rate for the same job.
// macOS and Linux get no window list (the companion roams the bottom edge of
// the screen there): macOS needs the Screen Recording permission even for
// window names, and Wayland gives no window positions at all by design.

const { spawn } = require("child_process");

const POLL_MS = 125;

// Kept C# 5 (Windows PowerShell 5.1 compiles Add-Type with the old
// CodeDom compiler). Bounds are DWMWA_EXTENDED_FRAME_BOUNDS: the visible
// frame without the invisible resize borders GetWindowRect includes, in
// physical pixels; the shell converts them to DIP. Skipped: invisible,
// minimized and cloaked windows (another virtual desktop, suspended UWP),
// untitled ones, tool windows, click-through overlays (WS_EX_TRANSPARENT),
// the desktop and taskbar, and every window of the calling process.
const CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class RxRoamWindows {
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int size);

    const int GWL_EXSTYLE = -20;
    const int WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80;
    const int DWMWA_EXTENDED_FRAME_BOUNDS = 9, DWMWA_CLOAKED = 14;
    static readonly string[] SkipClasses = { "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd" };

    static string Esc(string s) {
        var b = new StringBuilder();
        foreach (char c in s) {
            if (c == '"' || c == '\\') { b.Append('\\'); b.Append(c); }
            else if (c < ' ') b.Append(' ');
            else b.Append(c);
        }
        return b.ToString();
    }

    public static string Snapshot(uint skipPid) {
        var rows = new List<string>();
        IntPtr fg = GetForegroundWindow();
        EnumWindows(delegate (IntPtr h, IntPtr l) {
            if (!IsWindowVisible(h)) return true;
            // Minimized: listed by id only (a minimize is told from a close).
            if (IsIconic(h)) { rows.Add("{\"id\":\"" + h.ToInt64() + "\",\"min\":true}"); return true; }
            int cloaked;
            if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out cloaked, 4) == 0 && cloaked != 0) return true;
            int ex = GetWindowLong(h, GWL_EXSTYLE);
            if ((ex & (WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW)) != 0) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (pid == skipPid) return true;
            var cls = new StringBuilder(256);
            GetClassName(h, cls, 256);
            if (Array.IndexOf(SkipClasses, cls.ToString()) >= 0) return true;
            var title = new StringBuilder(512);
            if (GetWindowText(h, title, 512) == 0) return true;
            RECT r;
            if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, 16) != 0) return true;
            if (r.R - r.L < 120 || r.B - r.T < 80) return true;
            rows.Add("{\"id\":\"" + h.ToInt64() + "\",\"l\":" + r.L + ",\"t\":" + r.T + ",\"r\":" + r.R + ",\"b\":" + r.B
                + ",\"max\":" + (IsZoomed(h) ? "true" : "false") + ",\"title\":\"" + Esc(title.ToString()) + "\"}");
            return true;
        }, IntPtr.Zero);
        return "{\"fg\":\"" + fg.ToInt64() + "\",\"windows\":[" + string.Join(",", rows.ToArray()) + "]}";
    }

    public static bool Alive(int pid) {
        try { System.Diagnostics.Process.GetProcessById(pid); return true; } catch (Exception) { return false; }
    }
}
`;

function script(pid) {
    // Exits on its own once the shell is gone (checked every ~5 s), so a
    // crashed app never leaves it polling forever.
    return `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
${CSHARP}
'@
$last = ''
$n = 0
while ($true) {
    $s = [RxRoamWindows]::Snapshot(${pid})
    if ($s -ne $last) { [Console]::Out.WriteLine($s); [Console]::Out.Flush(); $last = $s }
    $n++
    if ($n % 40 -eq 0 -and -not [RxRoamWindows]::Alive(${pid})) { exit }
    Start-Sleep -Milliseconds ${POLL_MS}
}
`;
}

/** Start the feed: `onSnapshot({fg, windows:[{id, l, t, r, b, max, title}
 *  | {id, min: true}]})` in physical screen pixels, front window first
 *  (minimized ones only by id), each time it changes.
 *  Returns a stop function. A no-op off Windows. */
function startWindowFeed(onSnapshot) {
    if (process.platform !== "win32") return () => {};
    const encoded = Buffer.from(script(process.pid), "utf16le").toString("base64");
    let child;
    try {
        child = spawn("powershell.exe",
            ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
            { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
        console.warn("[roam] window feed unavailable:", e.message);
        return () => {};
    }
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try { onSnapshot(JSON.parse(line)); } catch (e) { /* a torn line: the next one replaces it */ }
        }
    });
    let errText = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { errText = (errText + chunk).slice(-2000); });
    child.on("exit", (code) => {
        if (code) console.warn(`[roam] window feed exited (${code}):`, errText.trim().slice(0, 400));
    });
    child.on("error", (e) => console.warn("[roam] window feed failed:", e.message));
    return () => {
        try { child.kill(); } catch (e) { /* already gone */ }
    };
}

module.exports = { startWindowFeed };
