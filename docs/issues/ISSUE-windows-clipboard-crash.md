# ISSUE: on Windows, replacing text on the clipboard can crash the program

## What the application needed

To put text on the clipboard and then something else -- an image -- and stay
up while other programs on the machine read the clipboard, which on Windows
they do all the time (clipboard history, clipboard managers, any program that
watches it). `tests/widgets`' `testClipboard` does exactly that: `Copy("palabra")`,
then `CopyImage(png)` a moment later.

## What I wrote instead

`testClipboard` skips its round trip on Windows and keeps only the refusals.
An application has no workaround: the crash is in GTK, outside anything a
program can catch, and it ends the process with `0xC0000005` and no dialog.

`Clipboard.Copy("")` had the same crash on demand and is covered: on Windows
it empties the clipboard instead of offering empty text (`sys_clip_copy`).

## The code I wish I could have written

```js
Clipboard.Copy("palabra");
Clipboard.CopyImage(png);      // and the program is still running afterwards
```

## Why the existing words do not cover it

Nothing in the runtime is missing. GTK 4.24.1's Win32 clipboard code is the
cause, measured 2026-11-12 on Windows 11 with MSYS2 UCRT64's packages:

- GDK promises formats and renders them when another process asks. The render
  writes the clipboard's *current* content into a `GdkWin32HDataOutputStream`.
- If the write fails (the content is an image now, the request is for text), the
  failure branch in `clipboard_render_hdata_ready` still closes the stream, and
  `close()` converts a buffer that was never allocated: `g_utf8_to_utf16(NULL)`
  returns NULL with no `GError`, and `transmute_utf8_string_to_cf_unicodetext`
  reads `wcptr[0]`. The log says `g_utf8_to_utf16: assertion 'str != NULL'
  failed` just before the access violation.
- A native stack taken at that critical: the main loop completing a `GTask` ->
  the render's ready callback -> `g_output_stream_close` -> the converter. No
  window procedure, no application frame.
- `tests/widgets` crashed three native runs in three, and none with the round
  trip skipped. It ran clean under gdb, which is slow enough to miss the
  window. `Copy("")` plus one `Get-Clipboard` from PowerShell crashed two in
  two (zero bytes leave the same buffer NULL).

The clipboard belongs to the window station, so the suite's private desktop
does not isolate it -- the suite also writes to the developer's real clipboard.

## Prior art

Upstream GTK: not reported yet. Two things would close it there: not
converting when the write failed, and a NULL check in the converter. A GTK
patched with that in the Windows bundle would close it here.

## How much it mattered

It works, but a part of it is noticeably worse: the window is short and needs
another program reading at the wrong moment, so an application that copies
text and later an image will rarely meet it -- but when it does, it crashes
with nothing to catch. On the suite it was every run, and it kept
`tests/widgets` from finishing on Windows.
