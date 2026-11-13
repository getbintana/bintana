# Changelog

What changed in each release, in the terms an application author and whoever
runs the runtime care about. The full history is `git log`; this file is the
one-page answer to *what is new since the release I have*.

## Unreleased

### Runtime and IDE

- **A text file saved the way Windows editors save it now loads.** Notepad,
  PowerShell 5.1 and Visual Studio can all save a UTF-8 BOM, and PowerShell
  5.1's `Out-File` and Notepad's older *Unicode* write UTF-16LE with one. A
  `project.btp` or `.form` that arrived that way stopped at
  `Unexpected token '\ufeff'` while a UTF-16 `.js` said `unexpected character`.
  `File.Load` now drops a UTF-8 BOM and decodes UTF-16LE/BE and UTF-32LE/BE
  with one, and the project, `.form`, module and `.po` loaders do the same
  through `bta_read_file`. Bytes with no BOM are still returned unchanged, so a
  Latin-1 source file and `File.LoadBytes` keep their bytes.
  `tests/widgets`' `TextEncodings` holds it with a child project whose `.btp`,
  `.form` and `.js` use those encodings.
- **`File.Watch` reports an atomic save once.** Windows' monitor answers a
  `File.Save` with a deletion followed by a change -- or with a bare `Created`
  for a path that was already there -- so a listener could close the file it
  was just told to reload. A deletion is now held for 200 ms: if the path is
  back, the pair is one `Changed`; if it is still gone, it is one `Deleted`, a
  moment later. A new file still reports `Created`, and the test runs on both
  platforms now.
- **`singleInstance` works on Windows, and a project's id becomes its
  AppUserModelID.** There is no session bus on a normal Windows machine, so
  GLib's `GApplication` left every run its own instance. The first run now owns
  `Local\BintanaSingle-<id>` and serves a named pipe; a second run writes its
  working directory and `Arguments` as one `(sas)` message, exits `0`, and the
  first calls `Application.OnSecondInstance` and raises its window. The same
  `project.btp` id is set with `SetCurrentProcessExplicitAppUserModelID`, so the
  taskbar groups the application rather than `bintanaw.exe`; the toast's
  shortcut already uses that id.
- **Install as user application works on Windows.** The IDE now writes a
  `.lnk` in the user's Start Menu through `Desktop.Shortcut`, with the project's
  id as its AppUserModelID, the project as its argument and working directory,
  and the name/icon the dialog chose; its record lives under
  `%APPDATA%\Bintana\apps`, not beside the shortcut in the menu. A project PNG
  becomes the shortcut's `.ico`, and uninstall removes the shortcut and that
  generated icon. The notification backend no longer overwrites an installed
  application's shortcut with its generic one.
- **`Logger.Target = "EventLog"` on Windows.** `Logger` now writes to the
  Application log that `eventvwr.exe` shows: `Debug` and `Info` as Information,
  `Warning` as Warning and `Error` as Error, with the line as the message.
  Writing needs no administrator. `bintana --register-event-source` from an
  elevated prompt registers the `Bintana` source with this executable as its
  message file, so the viewer describes the event; without it the event is still
  recorded with its data and no description. The message table is compiled into
  the executable from `runtime/src/bintana-events.mc`. On Linux the word is
  refused, as `"Journal"` is on Windows, instead of becoming a file named
  `EventLog`.
- **The IDE's export and its Windows paths.** `tar` gets
  `--force-local` on Windows, so a path beginning `C:` is not read as a remote
  host, and the path comparisons in `tests/ide` accept the native separator.
  The terminal test drives `cmd.exe` and reads its prompt; the debugger matches
  a breakpoint's file one component at a time, with `/` and `\` the same on
  Windows; and a branch's upstream comes from `git status --porcelain=v2
  --branch`, since `@{u}` does not survive Git for Windows' MSYS layer. The
  `apps` prefix runs 2732/0 there and the full project 3804/0.
- **`SerialPort` works on Windows.** `Open` is `CreateFileW` on `COM3` (or
  `\\.\COM3`) and a `DCB` for speed, data bits, parity, stop bits, flow control
  and DTR/RTS. A COM handle is not pollable by GLib, so a reader thread does
  the waiting and a writer thread drains `Write`: the window never blocks, and
  every `OnData`/`OnLine`/`OnError` still runs on the main loop. The properties,
  the `.form` round trip and the events are the same as Linux.
  `tests/serial-win.sh` exercises the data path over an HHD virtual port
  (loopback and peer); the peer mode passed five runs in a row on Windows 11
  (2026-11-11).
- **A `SerialPort` handler may close its own port.** `OnData` or `OnLine`
  could close the port and drop the last reference, and the check the delivery
  makes after the handler then read a released wrapper. The delivery holds the
  wrapper across the handler now.
- **`Tray`**, the application's status icon, with a native menu: `Show`/`Hide`,
  `Icon`, `Tooltip`, `Menu` (data with `Text`/`Action`/`Checked`/`Items`),
  `OnClick` and `OnMenu`, plus `Tray.Available`/`CanMenu`. Linux is built on
  `StatusNotifierItem` and `dbusmenu`; Windows is built on `Shell_NotifyIcon`
  with a hidden window and an `HMENU`; macOS is a stub that says so.
- **A `Video` keeps its picture when the audio endpoint cannot open.** The
  first audio-sink failure rebuilds the pipeline once with a `fakesink` and the
  audio branch off, so a virtualized Windows session with no audio device shows
  the clip silently instead of failing whole. A second failure is reported.
- **The Windows installer carries Video and PDF.** The NSIS payload now copies
  GStreamer's plugins, its scanner and its data, and poppler's CMaps, the same
  directories the portable ZIP has. Without them the installed IDE launched but
  answered `Video=false` and `PdfRead=false`; `tests/pack` asserts they travel.
- **`Exec`'s `Control` stream works on Windows.** There is no descriptor 3 to
  inherit there, so `Exec` creates a named pipe and passes its name in the
  child's `BINTANA_CONTROL_PIPE`; `bintana --debug` opens it, which makes the
  IDE's debugger and its breakpoints work on Windows. The callback, the
  one-line-at-a-time protocol, `Write` on stdin and the rule that the control
  stream ending is not the run ending are unchanged. A child of your own opens
  that environment variable and writes lines to it; Unix still gets descriptor
  3.
- **`Terminal` runs a child on Windows.** ConPTY (Windows 10 1809+) gives it a
  real console -- input, output and window size -- and libvterm turns the VT
  stream into a grid drawn by the runtime, with scrollback, colours, selection,
  `LinkPattern` and a scrollbar. `Terminal.Available` is true, the IDE's
  Terminal tab appears, and `ssh` is an ordinary interactive child. The three
  verbs mean what they do on Linux: `Stop` sends the console interrupt and
  `Kill` terminates the process and its job. A build without libvterm behaves
  as before: the class exists, draws, and the three verbs refuse naming the
  package. Linux keeps VTE.
- **A `Task` worker can import a shipped library on Windows.** A worker's
  module map hands an import over as a whole path, and the loader only
  recognized POSIX absolute paths: `C:\...\lib\xlsx\Xlsx.js` was taken for a
  library of that name and refused. A drive-letter or UNC prefix is a path now,
  so the same `import { Xlsx } from "xlsx"` works in a worker on both systems.
- **`Printer.Names` and `Printer.Default` work on Windows.** The Windows
  implementation asks `EnumPrintersW`/`GetDefaultPrinterW` instead of GTK's
  Unix-only `gtk_enumerate_printers`; `Printer.Send`/`ToFile` already used
  `GtkPrintOperation`, whose Win32 backend is the native dialog and printer
  driver. A machine with no printer still answers `[]`/`""`; `null` remains for
  a session that cannot ask.
- **`Keyring` on every platform.** `Available` is gone and `Provider` says
  which store a build uses: `"SecretService"` on Linux with libsecret,
  `"File"` (`0600` under `Application.ConfigDirectory/secrets/`) without it,
  `"CredentialManager"` on Windows and `"Keychain"` on macOS. The same three
  asynchronous verbs, names refused past 255 bytes encoded and a value past
  2560 bytes uniformly.
- **A notification can be clicked and can carry buttons**:
  `Notification.OnActivate = (id, action) => …`, `Buttons: [{ Label, Action }]`,
  and `CanActivate`/`MaxButtons` say what the platform delivers. Linux and macOS
  deliver the click; Windows does too, through a WinRT toast with up to three
  buttons and `Withdraw` -- the first `Send` writes the Start Menu shortcut that
  registers the project's AppUserModelID, which an unpackaged toast needs.
- **`SerialPort`**, a serial device on the main loop: `PortName`, `Speed`,
  `DataBits`, `Parity`, `StopBits`, `FlowControl`, `Line`/`EndOfLine`,
  `Data`/`Line`/`Error`, queued `Write`/`WriteLine`, and the `FormPart`.
  Linux over POSIX `termios`; the Windows half refuses and says so.
- **`Dialog.Font(title, [current], cb)`** is the desktop's font chooser, the
  same asynchronous bargain as `Dialog.Color`: the callback is handed a Pango
  description (`"Cantarell Bold 12"`), exactly what `Widget.Font` takes, and is
  not called when the person cancels.
- **A `Timer` can be declared in a `.form`.** The file carries it in
  `components`, the loader binds it to the form by name, and `Timer1_Tick` is
  the form's handler -- the same rule a control's event follows. `FormPart` is
  the base for a form's non-visual objects; `Timer` is the first one.
- The designer has a **component tray** under the canvas: the palette's
  `Timer`, `Connection`, `Model` and `HttpClient` create one there (or a drop
  on the canvas does), the tree lists it, the property grid edits it, a double
  click opens the handler, and a save writes `components`. A Timer is not
  started while the form is being drawn; a closed form stops its timers and
  closes its connection.
- **A `Connection` is one database file; a `Model` is one record over one
  table.** A form can carry as many Models as it needs and they share the one
  connection -- two tables do not open the same database twice. The Model
  creates its table from the record's shape on first use.
- **`examples/pulse`** puts the three together: a Timer polls a local
  `Http.Server` through an `HttpClient`, and each beat is one row in SQLite
  through a `Connection`.
- **`examples/uptime`** is the other shape of it: every 30 seconds a Timer asks
  a list of URLs through an `HttpClient` and writes one row per site into a
  `Model` over the one `Connection` -- a failure included, with status 0 and
  the reason. `Checks`, `Sites` and `Config` are three Models over the same
  `Db`; `Config` holds the interval and timeout, and the first time the
  database is created `sites.json` is imported into the `sites` table once
  (`Seeded`), then the table is the source. `Config` is edited in a
  `UptimeSettings` component with its own `.form`, shown in a popover behind
  the *Settings* button beside *Check now*: the interval and timeout are
  `DecimalBox` fields with their units inside, and the same popover lists the
  sites with Add/Remove. The `--selftest` half lives in `SelfTest.js` so the
  form reads the same either way. The rows are `Record`/`Table`, not
  hand-built SQL.

## 0.3.0 — 2026-11-04

[Compare with 0.2.1](https://github.com/getbintana/bintana/compare/v0.2.1...v0.3.0)

### Language

- **Modules.** A file with `export` is a module: what it exports reaches every
  other file by its bare name and the rest stays private. A name two modules
  export, used with no `import`, is refused at load; `import` chooses between
  them. `import()` and top-level `await` are refused by name.
- **QuickJS 0.18.0**, the interpreter is two to three times faster in release
  builds, and long string appends and searches are linear.
- `--strict` makes a control refuse a property its class does not have, and
  `bintana check --strict` is the project pass the IDE runs.
- Uncaught errors are shown in a window of Bintana's own with a Copy button,
  and a console program exits 1 instead of 0.
- An error a program catches carries the same sentence on every desktop, not
  GLib's translated one.

### Runtime and libraries

- **`Cancellable`.** A token shared by a `Task` stops every blocking call it
  was handed, is the last argument of the file, directory, `Exec`, `Http`,
  `Hash`, `Gzip` and `Zip` verbs, and a raised token starts nothing. A task's
  `Timeout` and `KillAfter` end a call that was handed no token; `Task.Max`
  refuses what is not a count.
- **`Locale` in a `Task`**, whole: a catalogue per thread, pinned to the
  language at `Start`, with `Compare`, `Matches`, `Number`, `Date`, `Currency`,
  `Parse`, `Text`, `Plural` and `Context`.
- **Networking.** `Network` reports connectivity, metered state and changes,
  `Inhibit` keeps the machine awake, and `Http.Client` gained `Tls: { Ca, Cert }`,
  an `Http1` option per client or call, cancellation while streaming, and a
  server body cap (`MaxBody`).
- **`Directory`** refuses a folder it cannot read with the reason, instead of
  answering an empty list; `File.Join` normalises `.` and `..`; `Dialog.OpenFiles`
  picks several files.
- **Accessibility.** `AccessibleName`, `AccessibleDescription`, `Label.For` and
  `AccessibleInfo` on every control, and an IDE check that reports a field no
  label names, a button with no words and no short tooltip, and a picture with
  no name.
- **Binding.** `Form.Record`, `Control.DataField`, `Bind(record)` and
  `Form.Source` fill a form from a record or a table and write it back, mark a
  refused field with `Error`, and `examples/bound` is the loop-free version of
  `examples/clients`.
- `Record` shapes as `.record` files, XML sequence order (`static Xml.Order`),
  XSD validation, and a `SaveXml` that no longer grows slower with every save.
- `Zip` reads and writes archives, `Xlsx` writes workbooks, `Gzip`, `Random`
  and `Hash.Hmac`/`Verify` arrived.
- `Probe.Image` measures a picture from its header with no window, and a
  drawing with no control draws its ink from the application's first window.

### Controls

- **`TableView`** filters (`Filter`, `Refilter`), reorders columns
  (`Reorderable`, `ColumnOrder`, `MoveColumn`), hides one without moving the
  numbers, declares a cell's editor (`Text`, `Number`, `Date`, `Check`, `Combo`,
  `Custom`), carries a tree's expander in a chosen column, adds rows in one
  batch, and publishes its row and heading geometry.
- `ComboBox.AllowEmpty`, `RowList.Index` waiting for its rows, and a form's
  `Activate`, `Deactivate` and `StateChange`.
- **Touch and gestures.** `MouseCancel` when a second finger arrives,
  `LongPress` with the context menu, `Screen.Touch`, and `Swipe`/`Transform`
  behind the opt-in `Gestures` property.
- A form with no frame (`Decorated`, `DragToMove`), `Popover.Show`/`Close`,
  commands as a class of their own, and menu labels in the catalogue.
- `Media.Element` builds GStreamer elements by name, links them, configures
  and subscribes to them; `Notification.Send` and `Withdraw` are there too.

### IDE

- **The IDE is modules**, every file exporting what another uses, and its
  workspace is per tab: palette, tree, canvas or editor and property grid.
- A View menu for the panels and the editor's look; snippets, folding and the
  minimap; a Problems panel that repairs what it can; the outline, completion
  and rename follow what a module exports.
- **The debugger** opens an object's values a level at a time (`expand`), stops
  where a field changes (`watch`), runs to the cursor, records logpoints, and
  *Project → Run with profiling* writes a Sysprof capture.
- **The Changes page** is a tree of ticks per file, with stage, unstage,
  discard and commit.
- **`bintana check`** runs the project pass from a shell, with `--components`
  and `--strict`; the IDE runs the same implementation.
- An about box (`lib/dialog`'s `AboutBox`), the IDE's Spanish catalogue, and a
  project's own accessibility severity.
- A project can be single-instance: a second run hands its arguments to the
  first.

### Packaging and installation

- The runtime, the IDE, the examples and the libraries install into a prefix;
  `bintana-0.3.0-linux-<arch>.tar.gz` is that tree, and the Windows job builds
  the portable zip and the per-user setup. The Windows tree now wears the
  system's title bar, starts without a console, and carries its registry and
  the Vulkan loader.
- Flatpak: the BaseApp is `0.3`, the IDE and `examples/hello` are built on it,
  and the repository publishes static deltas.
- `tests/pack.sh` holds the Flatpak manifests and this version to the one
  number in `CMakeLists.txt`.

### Documentation

- The audit was pruned to what is still owed; the answered findings are gone
  and the comparison table was checked against the tree.
- `api.json` is the public surface as data, and `tests/api.sh` holds it, the
  member descriptions and the documentation links to the code.
- `llms-full.txt` is regenerated from the pages `llm.txt` lists.
