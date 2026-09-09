/*
 * A folder of notes, and the point of it is that nothing is ever lost.
 *
 * The file name **is** the note's title: the list on the left is the folder, and
 * renaming a note renames the file.  There is no index, no database and no
 * metadata anywhere — the folder is the document, so the notes are readable with
 * `cat`, searchable with `grep`, and syncable by anything that syncs a folder.
 * Anything this program stores *about* a note would be a second place for the
 * truth to live, and the first thing to go stale.
 *
 * ## It saves by itself, and that is the design
 *
 * This started as an editor with a Save button and a *"save before closing?"*
 * dialog, and putting it over a folder is what showed that to be wrong.  A list
 * you click through raises `Select` on **every arrow key**: a dirty-check on
 * switching notes means a dialog per keystroke while somebody is looking for
 * something.  So the note is written when it is left — switching away, closing
 * the window, or half a second after the typing stops — and there is no dialog
 * at all.
 *
 * That is not a shortcut around the careful version; it is what a notes
 * application *is*, and it is better behaved than asking:
 *
 *   - **`File.Save` is atomic** (`g_file_set_contents` writes a temporary beside
 *     the file and renames it over), so a save interrupted by a full disk or a
 *     power cut leaves the previous note intact rather than half of a new one.
 *     Saving often is only safe because of that, and it is the runtime's doing
 *     rather than this file's.
 *   - **Deleting goes to the desktop's trash**, so the one irreversible thing is
 *     reversible. `Confirm.js` is only shown where there is no trash to use.
 *
 * What is left of the careful version is `Form_Close`, which still writes before
 * it lets go — and now needs no veto, because writing does not have to ask
 * anybody.  The *veto now, close from the answer* shape is still what a program
 * with a real question has to do; see `ide/forms/MainForm.js`, which has one.
 *
 * ## What else is worth reading for
 *
 *   - the list is sorted with **`Locale.Compare`** and not `sort()`, so a note
 *     called *Ñandú* files between *N* and *O* rather than after Z. That is
 *     `examples/contacts`' whole subject, and this is the second program to need
 *     it — which is what makes it a rule rather than an anecdote.
 *   - **`File.Watch` on the open note**, so an edit made by something else — a
 *     sync client, another machine, `git checkout` — is picked up rather than
 *     silently overwritten by the next autosave. Stopping that watch happens
 *     from inside its own callback, which used to be a segfault and is what this
 *     example found.
 *   - the divider is a `Split` with `Grows: "End"`, so widening the window gives
 *     the room to the text and leaves the list the width somebody chose.
 *
 * ## The strip of buttons, which was got wrong first
 *
 * The buttons were laid out in the `Fixed` with coordinates and widths, and
 * **New note came out clipped** on the machine it was shown on.  Not by a
 * pixel or two: a control in a `Fixed` is given the width it declared, so a
 * caption that needs more is cut — and the width it needs depends on the
 * desktop's font, which is 11 point here and something else there, and on the
 * language, where *New note* is *Nota nueva* is *Neue Notiz*.  A number typed in
 * at design time can only be right for one of those.
 *
 * They are in a horizontal `Panel` now, which asks each child what it needs.
 * The same window at 11, 14 and 18 point gives *New note* 66, 84 and 108 pixels
 * and nothing moves out of the strip, because the label between them is what
 * gives up the room.  It is the measurement `examples/i18n` exists to make, met
 * in an ordinary window rather than a demonstration — and the reason the old
 * layout hid it is worth keeping: at a fixed width, a bigger font could not
 * change the button, so there was nothing to see until the text was already
 * cut.
 *
 * **And the second thing it hid was not a layout problem at all.**  The window
 * remembers its size and restores it in `Form_Open`, and a form told to open
 * narrower than its `.form` was drawn used to give every anchored control a
 * *negative* far margin — so this strip came out sixty-eight pixels wider than
 * its own window, at every size, for as long as that setting survived.  The fix
 * is in `bta_fixed.c`: the anchors measure from the size the **file** drew,
 * which `Resize` no longer overwrites.  It is written down here because this is
 * the window it was found in and the shape of it is worth recognising — a gap
 * that is wrong by a constant at every size is a gap measured against the wrong
 * rectangle.
 *
 * ## Three buttons became one and a half
 *
 * *Rename* and *Delete* sat in that strip too, and they were the wrong shape for
 * it: one thing you do often and two you almost never do, all three shouting the
 * same size.  They are a menu on a drop-down beside *New note* now, the two of
 * them `linked` so they read as one control — which is what a split button is
 * for, and what every application with a primary action and some rarer ones
 * ends up drawing.
 *
 * **There is no `MenuButton` class, and this is the reason there need not be
 * one**: `Menu` is a property of every widget and `PopupMenu` opens it, so the
 * whole of it is a `Menu` in the `.form` and one line in `BtnMore_Click`.  What
 * a `MenuButton` would add over that is the arrow, which is an `Icon` here.
 *
 * **`navigation-sidebar` is deliberately not on the list**, though it is the
 * class this pane would want and the desktop's theme defines it.  Its rules are
 * written `.navigation-sidebar > row`, and `Style` on a `ListBox` lands on the
 * `scrolledwindow` — the rows are three nodes further down, so nothing would
 * match.  That is the table in [widgets.md](../../docs/widgets.md#what-node-a-control-is)
 * doing its job: it is there to be read *before* wondering why a class did
 * nothing.
 *
 * Run it with `./build/bintana examples/notes`. It keeps its notes in `~/Notes`
 * until told otherwise, and remembers the folder, the note and the window.
 */
"use strict";

/* What counts as a note. Plain text, because the folder has to stay readable
 * without this program. */
const KINDS = ["txt", "md"];

class NotesForm extends Form {

    /* Where the notes are. */
    folder = "";

    /* The notes in it, in the order the list shows them: `{ path, title }`. */
    notes = [];

    /* The one being edited, and whether the editor holds anything the file does
     * not. */
    path  = "";
    dirty = false;

    /* The autosave, armed while typing and disarmed by every write. */
    pending = null;

    /* The watch on the open note, and the flag that keeps our own writes from
     * arriving as somebody else's -- see the note at the top. */
    watch     = null;
    justSaved = false;

    /* Set while this form is writing its own controls, so the `Select` and
     * `Change` those assignments raise do not come straight back in. */
    showing = false;

    Form_Open() {
        const was = Settings.Get("size", null);
        if (was) this.Resize(was.width, was.height);

        /* `~/Notes` until told otherwise, made if it is not there: a notes
         * application with nowhere to put notes has nothing to show, and asking
         * before it can show anything is a worse first minute than a folder. */
        const folder = Application.Arguments[0] ||
                       Settings.Get("folder", File.Join(Environment.HomeDirectory, "Notes"));

        this.useFolder(folder, Settings.Get("note", ""));
    }

    /* --- the folder ---------------------------------------------------------- */

    useFolder(folder, want) {
        if (!File.IsDir(folder)) {
            try {
                Directory.Make(folder);
            } catch (e) {
                Message.Error("Cannot use {0}: {1}", folder, e.message);
                return;
            }
        }

        this.folder = File.Absolute(folder);
        this.LblFolder.Text = this.folder;
        Settings.Set("folder", this.folder);

        this.refresh(want);
    }

    BtnFolder_Click() {
        this.write();               /* whatever is open goes to disk first */

        Dialog.SelectFolder(Locale.Text("Where the notes are kept"),
                            { Folder: this.folder },
                            (chosen) => this.useFolder(chosen, ""));
    }

    /*
     * Reads the folder and fills the list, then opens `want` if it is still
     * there and the first note otherwise.
     *
     * **`Locale.Compare` and not `sort()`**: these are names a person reads, and
     * a plain sort files every accented one after Z. See `examples/contacts`.
     */
    refresh(want) {
        this.notes = [];
        for (const kind of KINDS)
            for (const path of Directory.Files(this.folder, `*.${kind}`))
                this.notes.push({ path, title: File.BaseName(File.Name(path)) });

        this.notes.sort((a, b) => Locale.Compare(a.title, b.title));

        this.showing = true;
        this.Notes.Items = this.notes.map((one) => one.title);
        this.showing = false;

        const at = want ? this.notes.findIndex((one) => one.path === want) : -1;
        this.open(at >= 0 ? at : (this.notes.length ? 0 : -1));
    }

    /* --- the open note ------------------------------------------------------- */

    open(at) {
        this.stopWatching();

        const one = at >= 0 ? this.notes[at] : null;

        this.showing = true;
        this.Notes.Index = at;
        this.Ed.Text     = one ? this.read(one.path) : "";
        this.showing = false;

        this.path  = one ? one.path : "";
        this.dirty = false;

        this.Ed.Enabled      = one !== null;
        this.BtnMore.Enabled = one !== null;

        this.Text = one ? one.title : Locale.Text("Notes");
        this.LblWhere.Text = one ? "" : Locale.Text("No notes here yet.");

        if (one) {
            Settings.Set("note", one.path);
            this.startWatching();
            this.Ed.SetFocus();
        }
    }

    read(path) {
        try {
            return File.Load(path);
        } catch (e) {
            Message.Error("Cannot open {0}: {1}", path, e.message);
            return "";
        }
    }

    /*
     * Leaving a note writes it, and so does everything else that would drop it.
     * One place, so there is no road out of a note that skips the writing.
     */
    Notes_Select() {
        if (this.showing) return;

        const at = this.Notes.Index;
        if (at < 0 || (this.notes[at] && this.notes[at].path === this.path)) return;

        this.write();
        this.open(at);
    }

    /* --- writing ------------------------------------------------------------- */

    /*
     * The guard is the loader's: a `.form` applies its properties before
     * `Form_Open` runs, so an editor with `Text` in the file would raise this
     * with no note open.
     */
    Ed_Change() {
        if (this.showing || !this.path) return;

        this.dirty = true;

        /* Armed afresh on every keystroke, so the write lands half a second
         * after the typing stops rather than half a second after it started. */
        if (this.pending) this.pending.Stop();
        this.pending = Timer.After(500, () => this.write());
    }

    Ed_Cursor() {
        if (this.path)
            this.LblWhere.Text = Locale.Text("Line {0}, column {1}",
                                             this.Ed.Line, this.Ed.Column);
    }

    /*
     * The note to its file, if there is anything to write. Answers whether it
     * worked, since a failed write must not be treated as a saved note.
     */
    write() {
        if (this.pending) { this.pending.Stop(); this.pending = null; }
        if (!this.path || !this.dirty) return true;

        try {
            File.Save(this.path, this.Ed.Text);
        } catch (e) {
            Message.Error("Cannot write {0}: {1}", this.path, e.message);
            return false;
        }

        this.dirty = false;

        /* Our own write is a change to the file like any other and the watch
         * cannot tell it from somebody else's, so it is ignored for as long as
         * GIO needs to deliver it. */
        this.justSaved = true;
        Timer.After(600, () => { this.justSaved = false; });

        return true;
    }

    /*
     * Nothing to ask on the way out, which is the whole point of saving by
     * itself: the note is written and the window goes.
     */
    Form_Close() {
        Settings.Set("size", { width: this.Width, height: this.Height });
        this.write();
        this.stopWatching();
        return false;
    }

    /* --- making, renaming, removing ------------------------------------------ */

    BtnNew_Click() {
        AskName.ask(Locale.Text("What is the note called?"), "",
                    (name) => this.make(name));
    }

    make(name) {
        const path = this.pathFor(name);
        if (!path) return;

        if (File.Exists(path)) {
            Message.Error("{0} is already there.", File.Name(path));
            return;
        }

        this.write();
        try {
            File.Save(path, "");
        } catch (e) {
            Message.Error("Cannot make {0}: {1}", path, e.message);
            return;
        }
        this.refresh(path);
    }

    /*
     * The drop-down beside *New note*.
     *
     * **There is no `MenuButton` class and this is why there does not need to be
     * one**: `Menu` is a property of every widget and `PopupMenu` opens it, so a
     * button that drops a menu is a button, a `Menu` in the `.form`, and this
     * line. What a `MenuButton` would add over it is the arrow — which is the
     * `Icon` here — and the two of them are one way of attaching a menu instead
     * of two.
     *
     * The pair is a `Panel` wearing `Style: "linked"`, so they read as one
     * control: the action and the less common things you can do to it, which is
     * what a split button is for.
     */
    BtnMore_Click() { this.BtnMore.PopupMenu(0, 0); }

    /*
     * A menu item's entries land on the form by name and dispatch as
     * `Name_Click`, exactly as a button does — a context menu is not a second
     * kind of menu, so these read like any other handler.
     */
    MnuRename_Click() {
        const one = this.notes[this.Notes.Index];
        if (!one) return;

        AskName.ask(Locale.Text("What should it be called?"), one.title,
                    (name) => this.rename(one, name));
    }

    rename(one, name) {
        const path = this.pathFor(name, File.Extension(one.path));
        if (!path || path === one.path) return;

        this.write();
        try {
            /* `Rename` refuses to clobber, so a name already taken is answered
             * by the runtime rather than checked for here and raced against. */
            File.Rename(one.path, path);
        } catch (e) {
            Message.Error("Cannot rename to {0}: {1}", File.Name(path), e.message);
            return;
        }
        this.refresh(path);
    }

    /*
     * A name typed by a person into a path, refusing the two that are not names:
     * a separator would put the note somewhere else, and a leading dot would
     * make it a file this list does not show.
     */
    pathFor(name, kind) {
        const bare = name.trim();

        if (!bare || bare.startsWith(".") || bare.includes("/")) {
            Message.Error("{0} is not a name a file can have.", name);
            return "";
        }
        return File.Join(this.folder, `${bare}.${kind || KINDS[0]}`);
    }

    /*
     * **To the trash and not to nothing.** Deleting is the one operation with no
     * way back, and every desktop answers that the same way — so this asks
     * nothing, because the answer is recoverable. Only where there is no trash
     * (a stick, a share, tmpfs) is there a question worth putting up.
     */
    MnuTrash_Click() {
        const one = this.notes[this.Notes.Index];
        if (!one) return;

        try {
            File.Trash(one.path);
        } catch (e) {
            Confirm.ask(Locale.Text(
                "There is no trash on that disk, so {0} would be gone for good.",
                one.title), Locale.Text("Delete for good"), () => this.erase(one));
            return;
        }

        this.dirty = false;                  /* it has nowhere to be written to */
        this.refresh("");
        this.LblWhere.Text = Locale.Text("{0} is in the trash.", one.title);
    }

    erase(one) {
        try {
            File.Delete(one.path);
        } catch (e) {
            Message.Error("Cannot delete {0}: {1}", one.title, e.message);
            return;
        }
        this.dirty = false;
        this.refresh("");
    }

    /* --- the note changing underneath ---------------------------------------- */

    startWatching() {
        if (this.path) this.watch = File.Watch(this.path, (e) => this.changed(e));
    }

    stopWatching() {
        if (this.watch) { this.watch.Stop(); this.watch = null; }
    }

    /*
     * Something else wrote the note — a sync client, another machine, an editor
     * in a terminal.
     *
     * Reloading here calls `stopWatching`, which stops this watch **from inside
     * its own callback**. That is the ordinary thing to do and it used to take
     * the process down; see `docs/runtime-api.md` under `File.Watch`.
     */
    changed(event) {
        if (this.justSaved) return;

        if (event === "Deleted") {
            this.refresh("");
            return;
        }
        if (event !== "Changed") return;

        /* Unsaved typing wins: it is the newer of the two and the only copy that
         * is not on a disk somewhere. The autosave will write it out and the
         * other side is what has to be reconciled by whoever made both. */
        if (this.dirty) {
            this.LblWhere.Text = Locale.Text(
                "{0} changed elsewhere while it was being edited here.",
                File.Name(this.path));
            return;
        }

        const at = this.notes.findIndex((one) => one.path === this.path);
        if (at >= 0) {
            this.open(at);
            this.LblWhere.Text = Locale.Text("{0} changed elsewhere, and was reloaded.",
                                             File.Name(this.path));
        }
    }

}
