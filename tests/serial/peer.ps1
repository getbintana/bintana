# The other end of a com0com pair, for tests/serial-win.sh.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tests/serial/peer.ps1 `
#       -Port COM4 -Ready C:\Temp\serial-ready
#
# It answers the two requests in tests/serial/Main.js: `PING\n` gets `PONG\n`,
# and `BIN\n` gets the two bytes 0x00 and 0xFF.  System.IO.Ports is the .NET
# Framework's own serial implementation, so the runtime is tested against a
# stack it does not share.  Windows PowerShell 5.1 has it built in; PowerShell
# 7 needs the System.IO.Ports package, which this does not.
param(
    [Parameter(Mandatory = $true)][string]$Port,
    [string]$Ready = "",
    [string]$Log = ""
)

$ErrorActionPreference = "Stop"

function Note([string]$text) {
    if ($Log -ne "") {
        Add-Content -Path $Log -Value $text
    }
}

Note "start"

$sp = New-Object System.IO.Ports.SerialPort
$sp.PortName  = $Port
$sp.BaudRate  = 115200
$sp.Parity    = [System.IO.Ports.Parity]::None
$sp.DataBits  = 8
$sp.StopBits  = [System.IO.Ports.StopBits]::One
$sp.Handshake = [System.IO.Ports.Handshake]::None
$sp.DtrEnable = $true
$sp.RtsEnable = $true
$sp.ReadTimeout  = 200
$sp.WriteTimeout = 2000

$sp.Open()
Note "opened"
# A virtual bridge can still hold the previous run's bytes on this side.
$sp.DiscardInBuffer()
$sp.DiscardOutBuffer()
# Let the bridge connect both sides before the test starts writing.
Start-Sleep -Milliseconds 250
if ($Ready -ne "") {
    Set-Content -Path $Ready -Value "ready" -Encoding ASCII
}

$answered = $false
$sawPing  = $false
$sawBin   = $false
$closeAt  = [DateTime]::MinValue
try {
    $pending  = New-Object System.Collections.Generic.List[byte]
    $deadline = [DateTime]::UtcNow.AddSeconds(30)

    while ([DateTime]::UtcNow -lt $deadline -and
           ($closeAt -eq [DateTime]::MinValue -or [DateTime]::UtcNow -lt $closeAt)) {
        try {
            $b = $sp.ReadByte()
        } catch [System.TimeoutException] {
            continue
        } catch {
            Note ("read error: " + $_.Exception.Message)
            break
        }
        if ($b -lt 0) {
            continue
        }
        $pending.Add([byte]$b)

        $text = -join ($pending | ForEach-Object { [char]$_ })
        if ($text.EndsWith("PING`n")) {
            $pending.Clear()
            $sawPing = $true
            $sp.Write("PONG`n")
        } elseif ($text.EndsWith("BIN`n")) {
            $pending.Clear()
            $sawBin = $true
            $binary = [byte[]](0x00, 0xFF)
            $sp.Write($binary, 0, $binary.Length)
            # The bridge needs the port to stay open long enough to carry the
            # last two bytes; closing here immediately dropped them.  Keep it
            # open for a retry, too: the bridge can lose a request when both
            # sides write at once.
            Start-Sleep -Milliseconds 250
            if (-not $answered) {
                $closeAt = [DateTime]::UtcNow.AddSeconds(2)
            }
            $answered = $true
        }
    }
} finally {
    try { $sp.Close() } catch { }
    Note "closed"
    if ($Ready -ne "") {
        Remove-Item -Path $Ready -ErrorAction SilentlyContinue
    }
}

Note "done sawPing=$sawPing sawBin=$sawBin"
if (-not $answered) {
    exit 1
}
