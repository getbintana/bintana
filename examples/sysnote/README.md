# Sysnote

A window that writes a note **for all users**. The window itself is never
elevated: the write is a helper project, and the operating system asks for
permission.

```
Sysnote/
  project.btp              declares "privileged": ["tools/write-note"]
  MainForm.form/.js        the window
  tools/write-note/        a main project, no window
    project.btp
    Main.js
```

Run it, type a note and press **Write for all users**:

- **Linux**: `pkexec` and polkit's agent ask; the note goes to
  `/var/lib/bintana/sysnote/note.txt`.
- **Windows**: UAC asks; the note goes to
  `%ProgramData%\Bintana\sysnote\note.txt`.

The helper refuses to run unelevated, and the application's check passes with
neither the app loading the helper's sources nor the helper being an unlisted
source of the app:

```sh
bintana check examples/sysnote
bintana check examples/sysnote/tools/write-note
```

The permission dialog is the one part a test cannot click; run it on a desktop
to see it.
