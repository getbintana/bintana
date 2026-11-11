# Serial ports

The traps and decisions of `SerialPort`. [`AGENTS.md`](../../AGENTS.md) has the
rules that apply to every change; this file is the evidence behind the ones
that only a COM handle teaches.

`bta_serial.c` owns the JS surface, the line buffer and the events, and the
POSIX half; `bta_serial_win32.c` owns the COM handle, the DCB, the two threads
and their queue. `bta_serial_internal.h` is the private contract between them
and is not installed.

## Windows has no pollable serial HANDLE

A POSIX serial port is an fd, so `g_unix_fd_add_full` puts it on the main loop
with no thread. **There is no `GSerialPort` in GIO and no `GSource` for a COM
HANDLE.** A reader thread is not an optimization; it is the only way to wait
for bytes without blocking the window.

The handle is opened **synchronous**, not `FILE_FLAG_OVERLAPPED`. Overlapped
I/O would force every `ReadFile` and `WriteFile` to carry an `OVERLAPPED` and
an event, and the reader would have to wait on two objects for every chunk.
The blocking call is on a thread that does nothing else, and
`CancelSynchronousIo` is what ends it on `Close` -- the same shape
`bta_terminal_win32.c` uses for a pipe. The writer is a second thread because
one thread cannot wait in `ReadFile` and take a write at the same time.

## The `COMMTIMEOUTS` mode that behaves like a byte source

The reader thread is not polled. These three values are the special case
[`COMMTIMEOUTS`](https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-commtimeouts)
documents:

```c
ReadIntervalTimeout        = MAXDWORD;
ReadTotalTimeoutMultiplier = MAXDWORD;
ReadTotalTimeoutConstant   = 1000;
```

`ReadFile` returns immediately with whatever is buffered; with nothing
buffered it waits until the first byte arrives and returns that. The one-second
constant is only a floor so the loop notices `stop` if a cancel misses. A
plain `ReadIntervalTimeout = 50` would add 50 ms to every small answer, which
is what a scale or a fiscal printer notices; a zero constant returns
immediately with zero bytes and spins.

## Two threads, one idle, and a reference count

Neither thread touches a `JSValue`. They append tagged events to a mutexed
queue and schedule **one** idle; every `OnData`, `OnLine` and `OnError` runs on
the main loop. The first event schedules the idle, the idle drains until the
queue is empty, and `idle_scheduled` is cleared under the same lock as the
pop so a producer cannot append between the last pop and the clear.

`SerialIo` is reference counted by the owner, the two threads and the
scheduled idle. `Close` stops and joins the threads, then drops the owner's
reference; an idle already queued keeps its own, sees `owner == NULL`, and
frees the events without reaching into the finalized wrapper. `s->keep` is the
strong reference that keeps the wrapper alive while the port is open.

## What `Open` asserts

`DCB.fDtrControl` and `fRtsControl` are set to `ENABLE` for
`FlowControl: "None"`, so DTR and RTS are asserted as a tty driver does. A
device that resets when DTR drops (an Arduino) sees the reset on `Open`, not on
the first byte. `Hardware` switches `fOutxCtsFlow` on and `fRtsControl` to
`RTS_CONTROL_HANDSHAKE`; `Software` sets `fOutX`/`fInX` with XON 0x11 and XOFF
0x13.

`COM3` and `\\.\COM3` are the same port. `CreateFileW` wants the second form
for everything above COM9, so a bare `COM` + digits is prefixed and anything
else is passed through. A `Speed` the driver does not accept is refused by
`SetCommState`, which names the port -- Windows does not have the finite
`speed_t` table Linux has.

## The test driver Windows refuses, and the one it accepts

The Windows data-path test needs a real pair. **com0com 3.0.0.0's "signed"
package is signed by CyberCircuits with a certificate that expired in 2018;
its catalog verifies, but Windows 11 with Secure Boot refuses to start the
device** (measured 2026-11-11 on this QEMU/EDK II machine):

```
dvi: Device 'ROOT\COM0COM\0000' not started:
     Device has problem: 0x34 (CM_PROB_UNSIGNED_DRIVER), status: 0xc0000428
```

The driver was signed after the July 2015 cutoff, so it is not a Microsoft
cross-signed driver Windows 11 accepts. Test signing is not available with
Secure Boot on, so the com0com route needs the firmware changed first. **HHD
Software's Virtual Serial Port Tools driver is signed by "Microsoft Windows
Hardware Compatibility Publisher" (Attested) and loads under Secure Boot.**
Its **script port** running `Loopback Serial Port (Push Model).ts` is a single
COM that echoes everything, which is `BINTANA_SERIAL_LOOPBACK=1`; its bridge
pair with `tests/serial/peer.ps1` on the other end is the peer mode.

**The HHD driver blocks the second write on one handle.** Measured: the first
`PING` echoes, and the next `WriteFile` stays pending until `Close` cancels it
with `ERROR_OPERATION_ABORTED` (995). The test therefore opens the line on one
handle and the bytes on a second, with 250 ms after the close and after the
reopen. A real UART does not need that; the test does. With it, the peer mode
passed five runs in a row (19 assertions each, 2026-11-11); HHD's script-port
loopback is flakier on its trial and passed four of five in later repeats. A
real adapter is the definitive check.

`ERROR_OPERATION_ABORTED` is silent only when `Close` set `stop`; if the
driver aborts a read or write while the port is open, it is an `OnError` and
the port closes. Treating every 995 as a clean stop left the writer thread
dead and the program waiting for an answer that could never come.

`tests/serial-win.sh` says what is missing and installs nothing.
`BINTANA_SERIAL_OPTIONAL=1` runs the option refusals and the `Open` of a
nonexistent `COM999` without a port, which is what the `windows` job does.
