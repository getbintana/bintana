# Makes Windows believe there is a touch screen, so a virtual machine with none
# can be touched.  Run it **inside the Windows guest**, in a PowerShell window,
# with the probe's window open and visible:
#
#   .\inject.ps1 tap
#   .\inject.ps1 longpress
#   .\inject.ps1 swipe
#   .\inject.ps1 pinch            # two fingers apart: a zoom in
#   .\inject.ps1 pinch -Closing   # two fingers together: a zoom out
#   .\inject.ps1 pan2             # two fingers moving together
#
# It uses `InitializeTouchInjection` and `InjectTouchInput` (user32, Windows 8
# and later), which add synthetic touch contacts to the session's input -- so
# what an application receives is what a finger on a screen would have sent.
# The contacts are put on the middle of the window titled -Title (default "Touch
# probe"), in screen pixels.
#
# **Nothing here has been run.**  It was written from the API's documentation on a
# machine with no Windows, and a first run is the test of it.  What to watch:
#   - "InjectTouchInput failed: <n>" with 5 (access denied) is the injection being
#     refused to this process; running PowerShell as administrator is the first
#     thing to try, and the documentation's `UIAccess` the second.
#   - A window that is not found is the title being different: pass -Title.
#   - The log (probe.log in the probe's configuration directory) is the answer:
#     see TouchProbe.js for how to read it.
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('tap', 'longpress', 'swipe', 'pinch', 'pan2')]
    [string] $Gesture,
    [string] $Title = 'Touch probe',
    [switch] $Closing,
    [int] $HoldMs = 1200
)

$code = @'
using System;
using System.Runtime.InteropServices;

public static class Touch {
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int left, top, right, bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct POINTER_INFO {
        public uint pointerType, pointerId, frameId, pointerFlags;
        public IntPtr sourceDevice, hwndTarget;
        public POINT ptPixelLocation, ptHimetricLocation, ptPixelLocationRaw, ptHimetricLocationRaw;
        public uint dwTime, historyCount;
        public int InputData;
        public uint dwKeyStates;
        public ulong PerformanceCount;
        public int ButtonChangeType;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct POINTER_TOUCH_INFO {
        public POINTER_INFO pointerInfo;
        public uint touchFlags, touchMask;
        public RECT rcContact, rcContactRaw;
        public uint orientation, pressure;
    }

    [DllImport("user32.dll", SetLastError = true)] static extern bool InitializeTouchInjection(uint maxCount, uint mode);
    [DllImport("user32.dll", SetLastError = true)] static extern bool InjectTouchInput(uint count, [In] POINTER_TOUCH_INFO[] contacts);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    const uint PT_TOUCH = 2;
    const uint INRANGE = 0x2, INCONTACT = 0x4, DOWN = 0x10000, UPDATE = 0x20000, UP = 0x40000;
    const uint MASK_CONTACTAREA = 1, MASK_ORIENTATION = 2, MASK_PRESSURE = 4;

    public static void Init() {
        SetProcessDPIAware();      // physical pixels, or the numbers are scaled behind our back
        if (!InitializeTouchInjection(10, 1))
            throw new Exception("InitializeTouchInjection failed: " + Marshal.GetLastWin32Error());
    }

    /* The middle of a window, as { x, y }, or null when there is none. */
    public static int[] Centre(string title) {
        IntPtr h = FindWindow(null, title);
        RECT r;
        if (h == IntPtr.Zero || !GetWindowRect(h, out r)) return null;
        return new int[] { (r.left + r.right) / 2, (r.top + r.bottom) / 2 };
    }

    /* One frame: every contact that is down, in the phase it is in (0 down,
     * 1 move, 2 up).  A contact missing from a frame is a contact that vanished,
     * so a two-finger gesture sends both fingers in every frame. */
    public static void Frame(int[] ids, int[] xs, int[] ys, int[] phases) {
        var list = new POINTER_TOUCH_INFO[ids.Length];
        for (int i = 0; i < ids.Length; i++) {
            uint flags = phases[i] == 0 ? (DOWN | INRANGE | INCONTACT)
                       : phases[i] == 1 ? (UPDATE | INRANGE | INCONTACT)
                       :                  UP;
            var c = new POINTER_TOUCH_INFO();
            c.pointerInfo.pointerType = PT_TOUCH;
            c.pointerInfo.pointerId = (uint)ids[i];
            c.pointerInfo.pointerFlags = flags;
            c.pointerInfo.ptPixelLocation.x = xs[i];
            c.pointerInfo.ptPixelLocation.y = ys[i];
            c.touchMask = MASK_CONTACTAREA | MASK_ORIENTATION | MASK_PRESSURE;
            c.orientation = 90;
            c.pressure = 32000;
            c.rcContact.left = xs[i] - 4; c.rcContact.right = xs[i] + 4;
            c.rcContact.top = ys[i] - 4;  c.rcContact.bottom = ys[i] + 4;
            list[i] = c;
        }
        if (!InjectTouchInput((uint)list.Length, list))
            throw new Exception("InjectTouchInput failed: " + Marshal.GetLastWin32Error());
    }
}
'@

Add-Type -TypeDefinition $code -Language CSharp
[Touch]::Init()

$centre = [Touch]::Centre($Title)
if ($null -eq $centre) { throw "no window titled '$Title' -- open the probe, or pass -Title" }
$cx = $centre[0]
$cy = $centre[1]

# The frames, a few milliseconds apart: a finger is a sequence, not a point.
function Step([int[]] $ids, [int[]] $xs, [int[]] $ys, [int[]] $phases, [int] $ms = 15) {
    [Touch]::Frame($ids, $xs, $ys, $phases)
    Start-Sleep -Milliseconds $ms
}

switch ($Gesture) {
    'tap' {
        Step @(0) @($cx) @($cy) @(0) 60
        Step @(0) @($cx) @($cy) @(2)
    }
    'longpress' {
        Step @(0) @($cx) @($cy) @(0)
        # A contact that stops reporting is one Windows may drop: keep it alive.
        for ($t = 0; $t -lt $HoldMs; $t += 100) { Step @(0) @($cx) @($cy) @(1) 100 }
        Step @(0) @($cx) @($cy) @(2)
    }
    'swipe' {
        $from = $cx - 150
        Step @(0) @($from) @($cy) @(0)
        for ($i = 1; $i -le 12; $i++) { Step @(0) @($from + 25 * $i) @($cy) @(1) 10 }
        Step @(0) @($from + 300) @($cy) @(2)
    }
    'pinch' {
        $r0 = 40; $r1 = 160
        if ($Closing) { $r0 = 160; $r1 = 40 }
        Step @(0, 1) @(($cx - $r0), ($cx + $r0)) @($cy, $cy) @(0, 0)
        for ($i = 1; $i -le 20; $i++) {
            $r = [int]($r0 + ($r1 - $r0) * $i / 20)
            Step @(0, 1) @(($cx - $r), ($cx + $r)) @($cy, $cy) @(1, 1) 20
        }
        Step @(0, 1) @(($cx - $r1), ($cx + $r1)) @($cy, $cy) @(2, 2)
    }
    'pan2' {
        Step @(0, 1) @(($cx - 30), ($cx + 30)) @($cy, $cy) @(0, 0)
        for ($i = 1; $i -le 20; $i++) {
            $d = 10 * $i
            Step @(0, 1) @(($cx - 30 + $d), ($cx + 30 + $d)) @($cy, $cy) @(1, 1) 20
        }
        Step @(0, 1) @(($cx - 30 + 200), ($cx + 30 + 200)) @($cy, $cy) @(2, 2)
    }
}
Write-Host "$Gesture injected at $cx,$cy"
