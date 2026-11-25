# Changelog

What changed in each release, in the terms an application author and whoever
runs the runtime care about. The full history is `git log`; this file is the
one-page answer to *what is new since the release I have*.

## Unreleased

### Runtime and libraries

- **Every project that runs declares an `id`, and the runtime does not start
  one that does not.** It was optional, and a project that grew reached the
  installer, the metainfo, `singleInstance` or a Windows toast and was
  refused there, late, after its name was everywhere. Both hosts now refuse
  at load with a sentence that says what to add (`"id":
  "io.github.you.App"`), `bintana check` reports it first, and the IDE's New
  project proposes one from the name. Project settings refuses to clear it,
  and `bintana check` holds a 255-byte id to the limit the platform applies.
  A library (no `startup`, no `main`) has none: it is loaded with `uses`, not
  run, and an id on one is a warning. `bintana test` runs a library under the
  test host's id, `io.github.getbintana.Test`, so its tests have a real
  `Application.Id` and directories without inventing one for the library. A
  library with a display half runs them in the graphical host, since those
  tests may build controls; one without runs in the console.
  **Breaking**: a project without an id must add one.
- **`Application.ConfigDirectory` is `~/.config/<id>`, and the new
  `Application.DataDirectory` is `~/.local/share/<id>`**, both created at
  startup and both named by the id, as a native program's or a Flatpak's are.
  Configuration goes in the first and what the application makes -- a
  database, a saved document -- in the second. On Windows both are
  `%LOCALAPPDATA%\<id>`. **Breaking**: `ConfigDirectory` was
  `~/.config/bintana/<name>`, and what was saved there is not moved. A
  `Task` worker sees `Application.Id` and `DataDirectory` too, and the
  examples that keep a database or a document use `DataDirectory`.
- **`Application.CacheDirectory`, the third: `~/.cache/<id>`**, created at
  startup, for what can be thrown away and made again -- thumbnails, a
  downloaded copy, an index. On Windows it is `%LOCALAPPDATA%\<id>\Cache`,
  since GLib's cache directory there is the browser's. A `Task` sees it too.
- **`bintana check` refuses an id that is not an application id**, as the
  runtime does: it only said *missing* before, and the id is a folder name
  now, so `"../x"` would be a path out of the config.
- **`bintana check` sees a member a global does not have**: `Database.Open`
  says `Database has no Open: it has Odbc, Sqlite`, and `File.Lod` offers
  `File.Load`. The IDE's live pass said it; the console check could not ask
  the globals and was silent until the first run. It reads them from the
  `api.json` now installed beside `widgets.json`.
- **A new id leaves the old folders, and says so.** Project settings shows it
  under the id while the one typed is new, and `bintana apps remove` names the
  config, data and cache folders it leaves (`Kept` in `--json`).
- **A failed call says what it called.** The engine threw `TypeError: not a
  function` and named nothing, so a line with three calls left the reader to
  guess which. It now reads the caller's bytecode for what put the function on
  the stack and says `Database has no function Open` for a member that is not
  there, or `grid.rows.add is a number, not a function` and `local is
  undefined, not a function` for a value that is there and cannot be called.
  A call's own result (`f()()`) and a callback a native function calls keep
  the old sentence, since neither has a name. Nothing is added to the ordinary
  call: the walk happens only on the way to the error.
- **`Zone`, a new global: the IANA time zones.** `Day` is a date and `Time` a
  time of day, neither with a zone; `Zone` turns an instant into the `Day` and
  `Time` a place reads, and back. `Zone.At(id, when)` is the offset (minutes
  east of Greenwich), the abbreviation and whether it is daylight saving time;
  `Zone.Next` the next time the clocks move, with both readings;
  `Zone.Day`/`Zone.Time` the wall clock there; `Zone.Instant(id, day, time)`
  the reverse, with an hour that happens twice read as the first and one the
  clocks skipped moved forward; `Zone.List` and `Zone.Info` the zones that are
  places, with country and coordinates; `Zone.Local` this machine's zone as
  an IANA id, on Windows too. QuickJS has no `Intl`, so until now
  `toLocaleString({ timeZone })` silently answered the local zone.
- **The runtime reads the TZif files itself**, on every platform:
  `/usr/share/zoneinfo` on Linux and macOS (or `TZDIR`), and on Windows a copy
  the portable tree and the setup now carry in `share/zoneinfo` (about 0.9 MB,
  from MSYS2's `tzdata`). GLib was measured on Windows and takes no IANA id
  there, and the ICU in `System32` carries tzdata 2022g, which answers wrong
  today for Cairo, Almaty, Asunción and Nuuk. The reader was checked against
  Python's zoneinfo and `zdump` over 418 zones, 1850-2099, the second before
  and the second of every transition, in the fat and the slim TZif forms.
- **A window on Windows starts no session bus.** GApplication asks for the
  session bus while registering, whatever its flags, and GLib on Windows
  autolaunches one: a `gdbus.exe` daemon beside every window program, for as
  long as it ran, in an MSYS2 tree, and `win32 session dbus binary not found`
  on stderr in the portable tree and the setup. Nothing here uses the bus on
  Windows, so the runtime registers with an address GLib refuses at once
  (`disabled:`), only for that call and only when `DBUS_SESSION_BUS_ADDRESS`
  is not set. The `widgets` test counts the `gdbus.exe` children of a window
  child and of the suite itself, which is what an MSYS2 tree shows: GLib
  reuses a bus it autolaunched, so the suite's own was the one to see.
- **A popover that stays goes away with its window's turn.** On X11 a popover
  is a surface of its own above every window, and one that does not hide
  itself -- the SourceEditor's completion list, a `TextBox`'s, a
  `Popover.Show(..., { Autohide: false })` -- went on floating over whatever
  application the person moved to. When a form's window stops being the active
  one they are put away: the completion lists for good (the next key offers
  them again), the program's own popovers parked and shown again when the
  window is active -- with no `Closed` and `IsOpen` still true; a `Close` while
  parked is a close. `tests/windowing.sh` checks it on Xvfb with xfwm4.
- **`Locale.Date` on Windows writes what Windows writes.** GLib does not ask
  Windows for `%x`, `%A` or `%B`: with no `nl_langinfo` it takes them from its
  own catalogue, so every Windows date was `11/22/26` -- month first, two
  digits, in any language -- and with the catalogue a Spanish desktop read
  `22/11/26` and `Domingo`, while the regional format the person chose was never
  read. Windows now writes them itself (`GetDateFormatEx`, `GetTimeFormatEx`):
  the short date with the year widened to four digits, the day's and the
  month's names, in the user's regional format, or in the locale `LC_ALL`,
  `LC_TIME` or `LANG` names, `C` being the invariant one -- so a Spanish
  desktop reads `31/08/2026`, `lunes`, `agosto` on Windows and on Linux alike.
  `Weekday` and `Month` are the Gregorian calendar's names in every locale --
  they go in a sentence with a day and a year the program holds -- where ar-SA,
  whose Windows calendar is the Hijri, named 31 August `ربيع الأول`; `Date`,
  `Time` and `DateTime` stay in the person's calendar, as Windows writes them.
- **Windows speaks the desktop's language in GLib's and GTK's words.** The
  portable tree and the setup carry the `glib20`, `gtk40` and
  `gtksourceview-5` catalogues, every language (about 7 MB compressed): a
  Spanish Windows got `Monday` from `Locale.Date(day, "Weekday")` -- the names
  are GLib's there, with no glibc -- and GTK's own menus and dialogs in
  English. Only those domains: MSYS2's `share/locale` is every package's.
- **A partial `Painter.Font` keeps the surface's family.** `p.Font = "Bold 11"`
  replaced the whole description, so the missing family went to Pango's own
  default and drew serif beside a sans interface; it is said over the font
  the painter starts with now -- the control's, or the desktop's under
  `Drawing` -- and each assignment over that start, not over the last.
  `Text.Width` and the rest measure a partial font the same way. And every
  frame starts at the control's font: the layout was kept across frames, so a
  frame that set no `Font` drew in the last frame's, and a `Font`, theme or
  text scale given to the control after its first frame never reached it.
- **`Field.Bool` takes its default as the others do, and refuses the rest.**
  `Field.Bool({ def: true, as: "on" })` is read now, beside `Field.Bool(true)`
  and `Field.Bool(false, { as: "on" })`. Before, options handed first were
  taken for the default and lost -- `as` and all, so the field read a key
  nobody wrote -- and a `def` among the options was overwritten by the absent
  first argument, both in silence. A default given both ways, or one that is
  not `true` or `false`, is a `TypeError` where the field is declared.
- **`bintana check` knows `singleInstance`.** The key the runtime reads to
  hand a second run to the first was reported as one "nothing reads", because
  `ProjectFile` never declared it -- so a project that used it could not pass
  `--strict`. It is a field now, and for a window project the check says as
  errors the two manifests the runtime refuses to start: a value that is not
  `true` or `false`, and `true` with no `id`. On a `main` project the key does
  nothing -- there is no window to bring forward -- and the check says so as a
  warning.
- **`Directory.Delete(path, true)` takes the tree, as .NET's does.** The second
  argument is recursive, and the way is **platform-normal**: a read-only file
  on Windows, or a folder without write permission on POSIX, is refused.
  `Directory.Delete(path, false, stop)` and `Directory.Delete(path, true,
  stop)` take a `Cancellable` last. `DeleteTree` remains the **force** verb:
  it takes read-only files on Windows and gives the owner write permission to
  folders on POSIX.
- **`Directory.DeleteTree` takes a read-only file on Windows and a read-only
  folder on POSIX**, and names the entry that would not go. Windows refused one
  and the error said *invalid argument* about the folder the walk began at --
  which is how the IDE's installer threw after writing a setup, its build
  folder holding MSYS2's read-only time-zone files. On POSIX, a `0555` folder
  stopped every child it held; the force verb now adds the owner's write bit
  before walking.
- **The first HTTP request on Windows no longer waits 2.4-3 s.** GIO's proxy
  resolver discovered on its own what Windows already knows -- to
  `127.0.0.1` too. The runtime asks Windows now: `HTTP_PROXY`, `HTTPS_PROXY`
  and `NO_PROXY` first, then the user's Internet settings (a fixed proxy and
  its exceptions, or automatic detection and a configuration script, through
  WinHTTP). On every platform the machine's own addresses go direct.
  Measured: 3133 ms to 8 ms for the first request to a LAN address.
- **An `Http.Client` built with options uses the system's proxy.** It went
  direct whatever the system said, while `Http.Get` used it: libsoup 3 reads
  the resolver the client was given as *no proxy*.
- **The member check says what the line does.** `this.MnuSave.Emit("Click")`
  was reported as an assignment that would do nothing; a call is now a
  TypeError when it runs, a read gives undefined, and the nearest member is
  offered when one is close (`did you mean Text?`).

### IDE

- **A control from the palette lands where nothing else is.** A click on the
  palette put the control at the form's corner and stepped it diagonally only
  past a control with the very same corner, so a Label, a TextBox and a Button
  clicked in a row sat half on top of each other -- the first thing a new
  project does, and the first thing it had to undo. They now go down a column
  from the corner, 8 px apart, and to the next column when the form is full;
  dragging from the palette still drops where the pointer is.
- **Designing after a rename is saved.** Renaming a control saves its `.form`
  from the designer, and the tab was not told: its watch took the IDE's own
  write for somebody else's, said the file had changed on disk, and Save All
  refused to write it -- so every caption and property set after naming the
  controls was lost at the next save. The designer now tells the tab what it
  wrote, whoever calls it.
- **A new form goes where the suggestion says.** File > New form offers
  `forms/Form2` with only the name selected, so typing a name keeps the folder;
  it used to select all of it, and a second form named by typing landed beside
  `project.btp`. The same for a new module and a new component.
- **A text field from the palette starts empty.** A `TextBox`, `TextEditor` or
  `SourceEditor` used to start holding its own name, which is data and not a
  caption: a search box filtered by `TextBox1` and a new application's list
  came up empty with its rows in the database. Captions (`Label`, `Button`
  ...) still start as the control's name.
- **Export project works with the tar Windows has.** It passed GNU tar's
  `--force-local` on every Windows, and the `tar` in `System32` is bsdtar,
  which refuses it -- so Export failed everywhere but under MSYS or Git's
  shell. The option now goes only to a tar that says it is GNU's.
- **The Windows installer asks for an id before a file.** A new project
  usually has none, and the installer offered `bintana-app-0.0-windows-x86_64.exe`
  and refused only after a file was chosen. It now says so first and opens
  Project settings on the id.
- **An error while the program runs goes to its line then.** A handler that
  throws does not end a form project -- the runtime prints the traceback and
  the window stays up -- and the IDE read the traceback only at the exit, so
  the click that failed said where in the output pane and nowhere else until
  the program was closed. Each traceback is now read as it arrives: a row in
  Problems and the editor at the line, while the program is still running.
  The same error is said once per run, however often it is thrown.
- **The editor underlines a member a runtime global does not have.**
  `Database.Open(path)`, `File.Read(p)`, `Message.Show(t)` -- the name another
  library taught -- went through every check and failed at the first run as
  `TypeError: not a function`, with no word of which (the run names it now,
  above, but only once the line runs). The live pass now says
  `Database has no Open: it has Odbc, Sqlite`, or `Timer has no Aftr: did you
  mean Timer.After?`, from the same `Widget.Members` completion offers after the
  dot. The language's own globals (`Date`, `Math`, `JSON` ...), a class the
  project declares under the same name, and a member the file defines or asks
  about with `typeof` are left alone. `bintana check` does not report it yet:
  its console host knows the widget classes' members and not the globals'.

- **The palette offers the libraries a project does not use yet.** Its last
  tab, *More*, names each library this machine has with the controls it brings
  (`report: Report`); a click adds it to `uses` and shows its tab. `Report`,
  `Chart` and `DataGrid` were nowhere in the palette until a library was named
  in Project settings, and nothing said so.
- **The menu editor has a *Menu* button**, which adds a menu at the end of the
  bar whatever is selected. *Submenu* goes inside a selected menu, and a tree
  with rows always has a selection, so a second menu on the bar could not be
  made.
- **A report with no bands opens its designer with a page header and a
  detail**, the detail selected. A `Report` off the palette opened with an
  empty band list and an Add that refused.
- **The Windows installer logs a build folder it could not delete** instead of
  throwing after the setup was written.
- **On Windows, a write, rename or delete of a file just made waits out a
  program that holds it a moment.** Defender, the search indexer and OneDrive
  open a file as it is closed, and Windows refuses to write, rename or delete a
  file open elsewhere: a `SaveTo` download, `ZipWriter.Finish` or `Gzip`
  failed now and then with *permission denied*, and a cancelled download left
  its `.part`. Such a refusal is tried again for up to a second
  (`bta_graceful.c`). `File.Save`, `File.SaveBytes`, `Locale.Write`, `Zip`'s
  extraction, `Desktop.Entries`, `File.Rename`, `File.Delete`,
  `Directory.DeleteTree` and `PdfDocument`'s form fields and encryption all do
  the same, while a read-only path is refused at once -- `File.Save` no
  longer spends 315 ms discovering it. **A read-only directory is refused
  too**: Windows 11 26H2 does not honor its own "not honored on directories"
  sentence, as `RemoveHeld` found; `Directory.DeleteTree` now clears the bit
  for folders as well as files.
- **`PdfDocument.AddFields`, `Encrypt` and `Sign` replace a PDF's own file on
  Windows.** PoDoFo kept the document open while the finished file was renamed
  over it, and poppler kept the reading half open, so the rename (or the
  in-place signing) was refused with *permission denied* after the whole
  retry -- a report's form, a same-file encryption and an in-place field write
  all failed. Both handles are closed before the replacement, and the reading
  half is opened again afterwards.
- **`Keyring` on Windows uses the Credential Manager even when an MSYS2
  libsecret is installed.** CMake found that port and the binary imported the
  Secret Service calls while `Keyring.Provider` named the Credential Manager,
  so every store answered false. libsecret is looked for on Linux only, and the
  provider's `#if` order puts the platform first. The suite now drives a
  Windows Credential Manager round trip with a name unique to the process.
- **The Windows Apps page shows the application's icon, publisher and
  size.** The uninstall key had no `DisplayIcon` without a project icon, no
  `Publisher` without a developer in the metainfo, and never an
  `EstimatedSize`: the icon falls back to the runtime's, the size is measured
  after the copy, and a new metainfo names a developer (the id's prefix and
  the user's name, editable in *Application info*).
- **A new project starts at version 0.1.0**, the release its metainfo already
  named; it had none, and its installer said `0.0`.
- **Uninstalling from *Installed applications* says which folders stay**, as
  `bintana apps remove` does.
- **A report on a form says it is shown when the program runs**, and that
  `Visible = false` keeps it off the window while it still prints and saves.
- **The IDE's Spanish catalogue is complete again**: 926 of 926, the dialogs
  of these days included, every one read and not taken from msgmerge's
  guesses.
- **A setup is named after the application**: `Cotizaciones-0.1.0-setup.exe`
  where it was `bintana-cotizaciones-0.0-windows-x86_64.exe`, the Linux
  command's spelling. `Nsis.Script` answers the name in `Setup`, and the IDE's
  chooser and `tools/pack --nsis` both use it.
- **A `sources` entry may be an absolute path.** The loader joined every
  entry to the project folder, so on Windows `C:/shared/x.js` became
  `C:\proj\C:/shared/x.js` and the program stopped with `cannot read`; and
  `bintana check` reported such a file as missing.
- **The installer and `tools/pack` name the databases they carry**
  (`Package.dataFiles`, and `Data` in what `Package.Write` answers). Run starts
  a program in its project folder, so a relative `Database.Sqlite("x.db")`
  leaves the file there, and the package copies everything in it. Named and
  not left out: a project may ship a database on purpose.

## 0.4.1 — 2026-11-22

[Compare with 0.4.0](https://github.com/getbintana/bintana/compare/v0.4.0...v0.4.1)

### Runtime and libraries

- **`SourceEditor.ShowCompletion()` answers whether it asked.** It answered
  `true` whenever the editor had a window, and `gtk_source_completion_show` is
  `void` and returns silently when the library considers the completion
  blocked -- no focus, a selection, a paste in flight. So a program (and the
  suite's round-trip test) was told "asked" for a show that never happened. It
  answers `false` for the states this side can see: no window, not visible, no
  focus, a selection. The popover is still built on its own time, so `true` is
  *asked*, not *shown*. The test had been skipping twelve assertions whenever
  the window was inactive -- which on a display with no window manager is the
  ordinary state -- and now waits on the verb instead.

- **A stalled `Http` download times out again when the program never lets the
  loop go idle.** The confirmation a `Timeout` gets before it cancels was a
  `G_PRIORITY_DEFAULT_IDLE` source, and an always-ready source -- a `Timer` of
  0 ms -- starves it: the server's stall ended, the whole answer arrived, and a
  download silent for six `Timeout`s completed instead of timing out (CI's
  sanitizer run on 0.4.0). It is a 100 ms timeout now, which priority cannot
  starve. Measured with nothing else in the program: a 0 ms `Timer` and a
  stalled download finished with its 100000 bytes before and times out now;
  `tests/widgets`' `HttpSave` holds it with `starved.bin`.

- **A `Resize` on a form that is already on screen is no longer lost.** GTK
  writes a configure's size back into the window's default size -- that is how
  a person's own resize is remembered -- so a configure still in flight for the
  size *before* the request (a form growing to fit what it holds, or two
  `Resize` calls a frame apart) landed after it and replaced it, and the next
  layout computed the old size. GTK 4 removed `gtk_window_resize` and has no
  way to ask again. The request is repeated over the next frames now, until the
  window has it or ten frames pass: bounded, so a person's own drag is not
  fought for longer than a moment. Measured on GTK 4.14.5 with two CPUs,
  `tests/widgets`' "survives a resize" went red 4 runs in 26 with the window at
  574 where 648 was asked; with the retry it does not, and this machine's 4.22
  never lost it.

### IDE

- **The designer's undo history is bounded by memory, not only by a step
  count.** It kept 200 JSON snapshots of the whole form, and a snapshot is the
  form: measured with the runtime's own serializer, 34,726 characters for a form
  of 300 controls and 355,298 for one of 3,000 -- 68 MB of history, 135 MB with
  the redo stack beside it. Each stack stops at 16 MB now and always keeps the
  newest; 200 stays the depth, so a form of ordinary size is unchanged.

## 0.4.0 — 2026-11-20

[Compare with 0.4.0-rc2](https://github.com/getbintana/bintana/compare/v0.4.0-rc2...v0.4.0)

**0.4.0 is 0.4.0-rc2 with what follows.** Everything new since 0.3.0 -- the
two hosts, and the rest -- is in the 0.4.0-rc1 and 0.4.0-rc2 sections below,
and this release carries all of it.

**What changed since 0.4.0-rc2:**

- **`Desktop.OpenUri(uri)`** hands an address to whatever the desktop opens it
  with -- a browser for `https:`, the mail program for `mailto:` -- through
  `GtkUriLauncher`, so it goes through the portal where there is one. There was
  no verb for it: `File.Open` is for files, and `LinkButton` opens only its own
  `Uri`. It answers once the request is made; an address with no scheme is
  refused (a path is `File.Open`'s), and so is any address under a `main`.
  With no session bus it goes to GIO directly: GTK 4.14's launcher crashes
  looking for the portal there (an upstream issue in `docs/issues/`).
- **An `Http` `Timeout` no longer fires because the program was busy.** A
  program that held its own main loop longer than the `Timeout` -- a long
  handler, a blocking call -- could come back to a download cut as silent while
  its blocks were waiting in the socket. The guard now lets what already
  arrived be read first, and a download's silence is counted from when a block
  arrives, not from when it is written to disk.
- **A Windows setup's `.cmd` launcher starts the host the project asks for.**
  `bintana.exe` for a project with a `main`, whose output is the window the
  `.cmd` is run in, and `bintana-gui.exe` through `start ""` for one that opens
  a form -- so the IDE's own launcher no longer opens with a console behind it
  for as long as it runs. The rule is the core's own (`bta_project_has_main`),
  and the Start Menu shortcut was already the graphical host.
- **The reference the runtime builds lists the libraries a project uses**, and
  its links to the long form open on Windows. `Application.Globals()` cannot
  see a library's class (a lexical binding), so the fallback reference had no
  Libraries section; and `Doc_Link` knew only `xdg-open`, so *More detail* was a
  dead address in the corner on a Windows install. It opens through
  `Desktop.OpenUri` now.
- On Windows, a window maximized from the system title bar stays maximized when
  a menu or any other restyle asks for a layout: the runtime keeps GTK's
  toplevel layout in step with the state the desktop set.
- `Widget.Members` refuses a qualified name that resolves to nothing
  (`Nope.Thing`, `Desktop.Nope`) as it refuses a bare one, instead of answering
  `[]`. The empty answer made the graphical host's `check` -- the one the IDE's
  Problems panel shows -- report a false error on a component of a namespace
  (`class: "Gadgets.Stepper"`) that the console `bintana check` passed.
- **The IDE lists and removes the applications it installed.** *Project →
  Installed applications…* is the other half of *Install as user
  application…*: it lists the entries that carry the project path -- a packaged
  application's are not listed and not touched -- says where each one points,
  and removes the selected entry after asking. An entry whose project had been
  moved, renamed or deleted could only be removed from that project, which is
  what left it in the menu for good. It shows the files the entry installed --
  the menu entry, and the `.ico` on Windows -- and **`bintana apps` is the same
  list from a terminal**: `bintana apps`, `files <id>`, `remove <id>…`, with
  `--json` for a script. Both refuse an entry a packager exported, because the
  folder is the desktop's and not this project's. The three of them are
  `lib/apps`, one answer: `Apps.List`, `Apps.Files`, `Apps.Uninstall`.

## 0.4.0-rc2 — 2026-11-18

[Compare with 0.4.0-rc1](https://github.com/getbintana/bintana/compare/v0.4.0-rc1...v0.4.0-rc2)

**What changed since 0.4.0-rc1:**

- `cmake --install` lays down `LICENSE-QuickJS`, and the Windows zip and setup
  carry the licences of the third-party binaries they bundle under
  `share/licenses/bintana`, with the version of every MSYS2 package the tree
  was built from. `THIRD-PARTY-NOTICES.md` maps them, and says plainly that a
  release does not attach the third-party source and that every GStreamer
  plugin is copied, FFmpeg, the DVD libraries and FDK AAC included.
- **`MenuItem.Visible`**: a hidden item leaves the menu and takes its
  shortcut with it, and keeps its `Enabled` for when it comes back. The IDE
  uses it to show *Windows installer…* only on Windows: elsewhere it wrote an
  `.nsi` with no payload beside it, which nothing could compile.
- **`lib/package` refuses an `id` that is not an application id** before it
  writes anything. It went unquoted into the Flatpak build commands and into
  file names, so a hand-edited `project.btp` with `../x` wrote outside the
  output folder and one with `a.b;c` ran `c` in the build.
- `cmake --install` no longer copies `docs/` -- the contributors' notes,
  plans and audit -- into `share/doc/bintana`; it installs the README, this
  CHANGELOG and the notices. The reference is the `bintana-docs` package.
- `bintana check` asks the `.form`'s own runtime class about a name collision
  instead of always asking `Form`; `lib/` and `ide/` are part of the check now.
- The Windows executables carry a version resource, so Explorer, Task Manager
  and the UAC prompt show `0.4.0` instead of a blank.
- The setup refuses a non-empty folder it did not install, and its uninstaller
  leaves a folder without the marker alone rather than deleting it.
- `bintana --help` lists the whole command line, not four usage lines.
- Release assets carry a `.sha256`, and the package/windows jobs wait for the
  suite, the sanitizer and the submodule pin before they publish.
- **The final 0.4.0 is the repository's *latest***: the CI took any letter in
  the tag for a pre-release, and the `v` of `v0.4.0` is one. A tag is now
  checked before anything is built (`tools/release-tag.sh`): `vX.Y.Z` or
  `vX.Y.Z-rcN` matching `CMakeLists.txt`, or nothing is published.
- The quickstart names `RelWithDebInfo`; the build is no longer silently
  three times slower for a first-time reader.
- **A path is text.** `Video.Save(undefined)`, `Painter.Image(42)` and
  `Environment.CurrentDirectory = 42` are refused (`… expects a path, as a
  string`) instead of writing `./undefined`, reading a file called `42` or
  entering `./42`. `Picture.File = null` takes the picture off, like `""`,
  instead of looking for a file called `null`.
- `TableView.SetCell`, `SetIcon` and `SetStyle` report a value whose
  conversion throws, and leave the cell as it was; they used to empty it and
  leave the exception pending for the next call.
- **`Http.Get`, `GetWait`, `Request` and `RequestWait` take `SaveTo: path`**:
  the answer is written to that file as it arrives, one 64 KiB block in memory
  whatever its size, through a `.part` beside it that is renamed at the end and
  removed on any other end. The record says `Saved` and `Length`; a non-2xx is
  answered into `Body` with no file made. `Progress(received, total, handle)`
  reports it at most ten times a second and once at the end, and with `SaveTo`
  **`Timeout` is the silence allowed, not the length**, so a download that keeps
  arriving is never cut -- a blocking one used to die at 30 s, and held the
  whole answer in memory twice.
- **An answer read into memory has a ceiling, which can break a program that
  downloads more than 256 MiB into `Body`**: `MaxSize` (per request or on
  `Http.Client`, 256 MiB unless asked, `0` for none). A declared length past it
  is refused before the body is read, anything else once it passes it --
  counted decoded, so a small gzip that inflates is held to it too -- with the
  new `Kind: "TooLarge"` and the status the server answered. A `Stream` line
  may be 1 MiB; one with no end past that ends the stream as `TooLarge` instead
  of growing until the process dies. `SaveTo` is not counted.
- **A `TableView` cell setter has a ceiling**: `SetCell`, `SetIcon`, `SetUri`,
  `SetStyle` and `SetEditable` reach a declared column or a cell the row
  already holds, and `SetCell` the one right after its last, which adds it.
  Anything further is a `RangeError` naming the two numbers; it used to grow
  the row to reach it, so `SetCell(0, 2e9, …)` took the process down and a
  swapped row and column wrote a cell no column shows.
- A refusal that quotes a path or a zip entry is no longer cut at 255 bytes
  (`File`, `Directory`, `Zip`, `Database.Sqlite`, `PdfDocument`, desktop
  entries, a drawing's `Save`).
- `WebSocket` and `SerialPort` failures are in the runtime's own words, like
  every other failure, instead of the desktop's language.
- **The IDE:** *Recover* keeps the copy of a file that could not be reopened
  and offers it again, instead of deleting the only copy. *Save all* does not
  write over a file that changed on disk while its tab was in the background;
  it names it and leaves it to be answered from its tab. Quitting asks about
  catalogues open in the translation editor, and *Save all and quit* saves
  them. Discarding from the Git window counts only what is there to throw
  away. A few report designer hints and the breakpoint dialog's title stay in
  the IDE's language.

## 0.4.0-rc1 — 2026-11-16

[Compare with 0.3.0](https://github.com/getbintana/bintana/compare/v0.3.0...v0.4.0-rc1)

### Two hosts: `bintana` and `bintana-gui`

- **`bintana` is the core, and it links no GTK.** It answers `--version` and
  `check`, runs a project's `main` and `bintana test` for it, and execs
  `bintana-gui` for a project that declares `startup` -- and for that
  project's tests -- with the whole command line. `bintana-gui` is the host
  that opens windows, and `bintana-ide` execs it. A command that worked before
  works the same way through the dispatch: `bintana examples/hello` still opens
  the window, and `--form`, `--theme`, `--text-scale` and `--rtl` go to the
  graphical host. A `main` maps 17 libraries instead of 153. **On Windows the
  split is the same two hosts**: `bintana.exe` is the console core (CUI) and
  `bintana-gui.exe` the graphical host (GUI subsystem), with
  `bintana-drawing.dll` for a `main` that draws. A shortcut starts the GUI
  host, so no console follows the window; `bintana-gui.exe --version` and
  `--help` open a small message box when there is no console to print to.
  **`Exec` starts every child through `bintana-exec.exe`**, a GUI-subsystem
  helper that passes `CREATE_NO_WINDOW` and the pipes `Exec` made, so a console
  tool a windowed application runs -- `git` while the IDE opens a project, a
  compiler -- has no window of its own: the same no-terminal contract as
  Linux. The runtime ships the helper beside both hosts. An empty argument
  reaches the child (GLib's spawn dropped it), a quoted one ending in a
  backslash keeps its closing quote, and a `.cmd` or `.bat` runs by its bare
  name. A bare name is looked up on the PATH the child is given -- the call's
  own `Environment` PATH in any spelling of the name (`PATH`, `Path`), or the
  program's -- and only there, a relative entry read from the call's
  `Directory`: one that is not on it is `Exec failed: no such file or
  directory`, as on Linux, instead of System32's program of that name or an
  `ExitCode` of 127. The child's `argv[0]` is the name it was called by, as on
  Linux. An empty PATH entry is skipped rather than read as the current
  folder, so `Environment: { PATH: "" }` finds nothing on Windows, where Linux
  reads it as the current folder; and `PATH: null` searches System32 and the
  Windows folder, where Linux's default (`/bin:/usr/bin:.`) also has the
  current folder.
- **The core is the same language as the graphical host.** It closes the same
  names, runs `rad.js` the same way and links the same console globals --
  `Http`, `Database`, `Task`, `Zip`, sockets, `SerialPort`, `Keyring`,
  `Message`, `Logger` with `Level`/`Target`/`Handler` -- with
  `Application.OnError`, `Id`, `ProtectPrototype`, `LibraryPath`,
  `Libraries`, the desktop's locale and the same report for an uncaught error.
  `Application.Quit` sets the exit status, and `--profile` works on a `main`.
- **Drawing with no display.** `Painter`, `Drawing`, `Bitmap` and `Text`'s
  measurements live in `bintana-drawing.so`, installed in `<libdir>/bintana`.
  The core loads it the first time one of them is used, or at the start when
  `uses` names `drawing`, so a `main` that never draws loads no cairo or Pango.
  `Drawing.Save`, `ToPng` and `SavePdf` write a picture or a PDF with no window.
  `Painter.Color` reads one written colour syntax in both hosts and on any GTK
  (`hsl()` included) instead of whatever GDK's parser answered.
- **`ReportDocument` and `ChartDocument` run in a `main`.** `lib/report` and
  `lib/charts` are each a document module and a control module, and the core
  loads the document without the control. `Printer.Papers` answers in both
  hosts (A4, Letter and A5, in points). `examples/ledger` reads a CSV, draws a
  chart and writes a PDF report -- `bintana examples/ledger out.pdf`, with no
  display.
- **A library's `project.btp` may name `uses` too.** The list resolves
  transitively, dependencies first, and always from the project, so a project
  that carries its own copy of a library gets exactly one copy per name.
  `uses: ["report"]` brings `charts` and `drawing`. `Application.Uses([project])`
  answers the resolved list, and `bintana check` and the IDE's palette follow
  it. A library marks itself graphical with `"display": true`, or lists the
  files that are graphical; the core refuses such a library by name before any
  of it runs, where it used to fail later with a `ReferenceError`.
- **Native plugins load in the core**, before `rad.js`, with the same host
  table the graphical host hands them. A `main` can use `TagLib` with no
  display, and a plugin that cannot load is a sentence and exit 2.

### Changes that can break a program or a package

- **A package installs two binaries and a module**: `bin/bintana`,
  `bin/bintana-gui` and `<libdir>/bintana/bintana-drawing.so`. A package that
  ships only `bin/bintana` runs `check` and `main` projects and cannot open a
  window. `cmake --install` lays all three down.
- **`Keyring.Available` is gone**; `Keyring.Provider` says which store a build
  uses (see below).
- **`lib/report` and `lib/charts` are modules.** They export `Report`,
  `ReportDocument`, `Chart` and `ChartDocument`. The constants 0.3.0 left in
  the global scope (`PALETTE`, `KINDS`, `FORMATS`, `ALIGNS` and the rest) are
  private now.
- **The helpers in `forms.js` are no longer globals.** `mixIn`, `applyNode`,
  `savableValue`, `showError`, `rememberWindow` and the rest were
  undocumented, but a program could call or replace them.
- **`Exec` looks a bare name up on the PATH the child is given, on Linux
  too.** A call with `Environment: { PATH: … }` used to have its command
  searched on the *program's* PATH there: a tool only the call's PATH named
  was `no such file or directory`, and of two tools of one name the program's
  ran. Now the call's PATH decides on every platform, a relative entry is
  read from `Directory`, and a call with no PATH of its own is unchanged.
- **`File.Relative` answers with `/` on Windows**, as on every other platform:
  the answer names something inside a tree, and Windows accepts `/`.

### Language and IDE

- **The project manifest is `project.btp`.** `project.json` becomes
  `project.btp` across the tree; a project written before the rename still runs
  from the old name, and nothing new writes it. The type is registered, a double
  click opens the project in the IDE, and `bintana`, `bintana test` and
  `bintana check` take the file as well as the directory.
- **`Application.FreeNames`** answers the names a piece of source uses and
  nothing declares, and `bintana check` reports them. Name collisions are loud
  now: a control's sealed method, a project class that hides one, and a name two
  modules export used with no `import` are refused with the place and the name.
- **`Application.Theme`** forces light or dark for the program, and the form's
  `ThemeChange` arrives with the new colours; `""` puts the desktop's back.
- **`Application.ProtectPrototype`** closes `Object.prototype` to new names, so
  a plugin cannot polyfill into every `for...in` in the program.
- A `.form` raises no handler by name while it loads: `Index`, `Text` and a
  component's `Value` declared in the file reach none of `Select`, `Change` or
  the component's own event, where the program's own assignments still do.
- **`Editor.Format`** reindents the selection or the whole file, and the IDE
  renames a local, a parameter or a class field across the project.
- **The debugger is complete**: hit counts on a breakpoint and a logpoint, a
  breakpoint inside a `Task` stopping on the worker's thread while the window
  runs, Pause reaching a spinning task, edit and continue a member at a time,
  data breakpoints on a task's objects, the value of a name under the pointer,
  the Breakpoints page, and *Debug tests* for the test under the caret. DAP is
  the one thing written down to evaluate.
- **History is a page of the side panel**, beside Changes: the commits, the
  files each touched, and the diff opened in the **Git tab** in the main panel.
  The changes list, the ticks and the commit box stay in Changes, so there is one
  sidebar and no duplicate; the tab is the diff, titled `diff: <file> (<branch>)`
  for a change and `Commit: <file> (<branch>)` for one from History, and
  fetch/pull/push are the menus'. Its bar has icon buttons for previous/next
  difference, jump to file and previous/next changed file, with the old Side by
  side/Unified toggle on the right. The old Changes and History windows remain
  as the first shape and as the suite's own.
- **The IDE's Data view**: a project's `.conn` files, a form's `Connection` part
  and a loose `.db` are one entry per path, with tables, columns, a schema and a
  SQL console. `ConnectionForm` edits sqlite and ODBC connections, and an ODBC
  password is the name of an environment variable, never in the file.
- **The report designer** drags the bands and their elements on the page, and a
  `Report` with `Input`/`Signature` is a fillable PDF form.
- A control subclass declared in the project is drawn as the runtime control it
  extends, with its own design values, without evaluating the class.
- The accessibility level is a project setting, and the IDE's check reports at
  it.

### Data

- **`Database.Odbc`**, one API for the server the office runs -- SQL Server,
  MySQL/MariaDB, PostgreSQL, Firebird, an Access file -- on unixODBC and
  `odbc32`: `Query`, `Execute`, `Script`, `Each`, `Transaction`, `Columns`,
  `Tables`, `Dialect`, and `Table`/`Cursor`/`Model` on any engine. The text
  layer is UTF-8 on unixODBC and UTF-16 on Windows, the driver's SQLSTATE is
  `Code`, and a `Decimal` stays exact where the driver reports it exactly.
  `ConnectionPart` takes `Driver: "Odbc"`, and `examples/invoices` is a billing
  screen over three models and one transaction.
- **`Database.Sqlite` completed** as the model a second driver answers:
  `Cursor`, `Each`, the language's order in a statement (`COLLATE LOCALE`) and
  an `Update` that writes only what changed.
- **`lib/datagrid`**: frozen columns, a row of totals under each column, one
  sort across both halves, groups, a rectangle of cells, copy and paste to a
  spreadsheet, and the selection and hover shared by both halves.
- **PDF**: `PdfDocument` reads (poppler) and writes (PoDoFo), encrypts with
  AES-256, `Probe.Pdf` measures without a window, `lib/pdfview` shows a page,
  `Printer.Preview` previews what `DrawPage` draws, and `PdfDocument.Sign` signs
  with a `Key` from a file, a smart card or a PKCS#11 token; `Signatures`
  verifies.
- **`Bitmap`** loads once and scales, crops, rotates and flips into new
  pictures; `Picture.Source` shows one and `Painter.Image` draws one.
- **`Cipher`** is AES-256-GCM, and `Key` loads PEM, DER, PKCS#12 and encrypted
  PKCS#8 keys.
- `examples/sales` is a year of sales in a `DataGrid`.

### Runtime and libraries

- **Transports**: `Socket`/`ServerSocket` (TCP and Unix, TLS with a CA or a
  pin), `UdpSocket` (unicast and broadcast), `WebSocket` (client and
  `Http.Server` upgrade), `SmtpClient` (plain or implicit TLS) and
  `SerialPort`, each a part a form can own.
- **`Http.Server` `req.Hold([timeout])`** lets a handler answer from a callback,
  with one `Answer`, a deadline, and a 503 when it passes.
- **`Media.Devices`** lists the cameras and `Video.Attach` shows a pipeline;
  `examples/camera` previews, photographs and records.
- **`GridRow`/`GridColumn`/`GridRowSpan`** place a child at a cell; `-1`
  follows the order, so every form written before keeps its layout.
- **`TextBox.Mask`** and **`TextBox.Completion`**: the shape of what is typed,
  and a list of words offered without restricting the text.
- **`Direction`** is left-to-right, right-to-left or inherited, with mirrored
  icons and `Start`/`End` swapped in a `Fixed`.
- **`TableView`** gained a rectangle of cells, a tree folded from the keyboard,
  `Hover`/`HoverRow`, `ScrollX`, `ColumnWidths`, `Headers`, `ColumnResize`, Tab
  leaving the grid, and `AddRows`/`NodeToggle`.
- **`lib/propertygrid`** edits an object's properties as rows.
- A control removed or freed by its own event handler no longer leaves
  `bta_emit` reading freed memory after the handler returns.
- **`Stop`, `Kill` and `Timeout` reach a job whose leader has already gone**,
  as when `sh -c "server & echo up"` leaves the server holding the output: every
  Unix child writes its pid back before `exec`, so the job's process group is
  known even if GLib has already reaped the leader.

### Platform and parts

- **On Windows the application follows the system's dark mode.** GTK's Win32
  backend never reads Windows' *app mode* (Settings → Personalization →
  Colors), so a desktop in dark mode drew every window light. With
  `Application.Theme` at `""` the runtime now reads it from the registry at
  start and again when Windows announces a change, live: open forms restyle,
  raise `ThemeChange` and `Dark` answers the new ground. `Application.Theme`,
  `--theme` and a `GTK_THEME` the user set still outrank it.
  `tests/widgets`' `ThemeWindows` holds the form to the registry.
- **The Windows installer can register what the application opens.**
  `Nsis.Script(project, out, { Files, Schemes })`, and `--file <ext>[=<name>]`
  / `--scheme <name>` on `tools/pack.sh --nsis`, register file extensions and
  URL schemes for the user. The application appears in *Open with*, takes
  over an extension only when nothing had it, and the file or URL arrives as
  `Application.Arguments[0]`. The uninstaller removes what is still its own.
  Windows' own extensions (`.exe`, `.lnk` …) and the system's and browser's
  schemes are refused. The IDE's *Windows installer…* does not offer it yet.
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
  taskbar groups the application rather than `bintana-gui.exe`; the toast's
  shortcut already uses that id.
- **Install as user application works on Windows.** The IDE now writes a
  `.lnk` in the user's Start Menu through `Desktop.Shortcut`, with the project's
  id as its AppUserModelID, the project as its argument and working directory,
  and the name/icon the dialog chose; its record lives under
  `%APPDATA%\Bintana\apps`, not beside the shortcut in the menu. A project PNG
  becomes the shortcut's `.ico`, and uninstall removes the shortcut and that
  generated icon. The notification backend no longer overwrites an installed
  application's shortcut with its generic one.
- **A privileged task is a helper project, not a root window.** `Privilege.Run`
  and `Privilege.Wait` start a `main` project declared in `project.btp`'s
  `"privileged"` array with the operating system's consent: `pkexec` and
  polkit's agent on Linux, UAC through an unelevated launcher on Windows. The
  application's own window is never elevated; the helper answers through the
  same `Exec` job (`Stop`, `Kill`, `onLine`, `onExit`) and reads
  `Privilege.Elevated`, `CanElevate` and `Invoker`. A helper that declares
  `startup` is refused before the dialog, and a `Task` cannot ask. A directory
  with its own `project.btp` is a project of its own: the application does not
  load the helper's sources, and `bintana check` knows the `"privileged"` key.
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
- **`SerialPort`**, a serial device on the main loop: `PortName`, `Speed`,
  `DataBits`, `Parity`, `StopBits`, `FlowControl`, `Line`/`EndOfLine`,
  `Data`/`Line`/`Error`, queued `Write`/`WriteLine`, and the `FormPart`.
  Linux is POSIX `termios`. On Windows `Open` is `CreateFileW` on `COM3` (or
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
- **`examples/pomodoro`** puts the tray and a notification together: the window
  is only the settings, put away while a phase runs, with the time left in the
  tooltip and a notification at each change. Where there is no
  status-notifier host it waits minimised, since there would be no way back.
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
- **`Network.Online` can be true on Windows.** GLib's Win32 monitor only
  knows that a route exists, so `Connectivity` was `"Routed"` forever and
  `Online` never true. Windows' own internet check (NCSI, through the Network
  List Manager) answers now: `"Full"`, `"Local"` (a captive portal included)
  or `"None"`. `OnChange` still follows GLib's notices, so a program waiting
  to be online reads `Online` again rather than only listening.
- **`ZipArchive.ExtractAll` refuses what only Windows reads as more than a
  name**: a `:` (which writes an NTFS alternate data stream into another
  file), a device such as `CON`, `NUL`, `COM1` or `CONIN$` whatever its extension, a
  part ending in a dot or a space, and `<>"|?*` or a control character. The
  whole archive is refused before a byte is written, as for `../`. On Linux
  those letters are still ordinary names.
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

### What still differs on Windows

The same program runs on both; these are the places where it is told
something different, so a program meant for both reads them once.

- **`Exec`**: `Stop` ends the job at once (there is no SIGTERM to catch), a
  killed child's `ExitCode` is `1` rather than `-1`, and `ProcessId` is the
  `bintana-exec.exe` helper's. `Exec.Wait`'s `Output` is the child's bytes as
  written -- a console program's CRLF included -- where the line callbacks end
  a line at LF, CRLF or CR on both systems. A command that exists but that
  Windows refuses to start answers `ExitCode` 127 with a `bintana-exec:` line
  on stderr, where Linux throws.
- **`Terminal.Stop`** sends Ctrl+C, which a child may ignore; `Kill` ends it.
- **`Privilege.Invoker.Id`** is the user's name, not a numeric uid, and
  `CanElevate` is true for every user (UAC asks for an administrator's
  password when the user is not one).
- **`Notification`** ignores `Icon`, and a click that starts a closed
  application does not carry its action.
- **`Desktop.Entries`** writes `.desktop` files that no Windows menu reads;
  `Desktop.Shortcut` is the Windows word. `Application.ConfigDirectory` and
  the data directory are the same folder there (`%LOCALAPPDATA%`).
- **`Socket`/`ServerSocket` with `Path`** (Unix sockets) refuse; a TCP port
  on `127.0.0.1` is the portable road.
- **Collation**: `Locale.Compare` and `COLLATE LOCALE` follow Windows' own
  order, which is not glibc's for every accent and case.
- **Not in the Windows build this release ships**: `PdfDocument`'s writing
  half -- `Encrypt` and `Sign` (no PoDoFo), the Journal (`"EventLog"` is
  Windows' target) and the IDE's Sysprof capture.
  `Database.Odbc` is built on `odbc32` but has not yet been run against a
  server on Windows.
- **Known crash**: replacing text on the clipboard with an image while another
  program reads it can end the process inside GTK 4.24.1
  ([`docs/issues/UPSTREAM-windows-clipboard-crash.md`](docs/issues/UPSTREAM-windows-clipboard-crash.md)).

## 0.3.0 — 2026-11-04

[Compare with 0.2.1](https://github.com/getbintana/bintana/compare/v0.2.1...06cca0a74b52ecec7f3e774ec801a37ae52eedc3)

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
- **Arrange in boxes** turns a region of a `Fixed` form into rows, columns and
  grids, keeping the names and handlers, with the editor taking the height and
  each row's gap; overlapping controls are refused and the whole arrangement is
  one undo.
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
