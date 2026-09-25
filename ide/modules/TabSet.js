/*
 * The open files, as tabs.
 *
 * One page of `Tabs` per open file, and **the page owns what is in it**: a code
 * tab has its own `SourceEditor`, a form tab its own canvas and the `Designer`
 * driving it.  That is what buys what one shared editor could not: the undo
 * history, the selection, the scroll position and the design tree belong to the
 * widget, so they survive a switch without anyone saving and restoring them, and
 * switching a notebook is all the showing and hiding there is.
 *
 * What is *not* per tab is the side panel and the find bar -- they speak about a
 * selection, and there is one because there is one active tab.  Which is why
 * `ide.Editor`, `ide.designer`, `ide.Surface` and friends are not controls of
 * `MainForm.form` any more: they are words for "the active one", repointed by
 * `placeContent` and `null` when nothing is open.
 *
 * `ide.activeFile` is read all over the IDE and written only here.
 */
"use strict";

Namespace("Ide");

/*
 * Which project files the tree lists, and with which highlighting.
 *
 * The value is the GtkSourceView language a tab for it opens in -- **or `false`,
 * which means the file belongs to the project and is shown, but is not opened
 * here.**  A catalogue is the case: it is text, so a tab would work, and that is
 * exactly the problem.  Poedit saving underneath a stale tab, or `Update
 * translations` rewriting the file while a tab holds the old content, loses a
 * translator's work in the ordinary course of using both -- and the IDE runs
 * `msgmerge` over these files itself.  Two editors over one file is a hazard the
 * IDE would be creating, so it does not offer the second one.
 */
const EDITABLE = {
    js:   "js",
    form: "json",
    json: "json",
    css:  "css",    /* app.css: the classes a control wears through Style */
    /* A README is the one file a project writes for a person to *read*, and the
     * IDE showed it the way it shows a source file, when it showed it at all. It
     * opens as the document it is -- see `Ide.Document` -- with the editor a
     * click away, because a tab that could not edit it would be the IDE refusing
     * to let anybody fix a typo in their own project. */
    md:   "markdown",
    /* XML, which in a project means the metainfo: `<id>.metainfo.xml`. It opens
     * as text with GtkSourceView's own XML highlighting, and the structured
     * editor is a menu item of its own -- this raw road is where translations,
     * screenshots and whatever else the form does not model are written. */
    xml:  "xml",
    po:   false,    /* a catalogue: shown, and handed to a translation editor */
    pot:  false,    /* ...and the template it is updated from */

    /* Images: shown in the tree and handed to a viewer, for the same reason a
     * catalogue is -- the project owns them and "the IDE cannot show you your
     * own file" is a worse answer than a window that can. Not SVG: a `Picture`
     * reads what `GdkTexture` reads, and a scalable icon is not among them. */
    png:  false,
    jpg:  false,
    jpeg: false,
    webp: false,
    tiff: false,
    tif:  false,
    bmp:  false,
};

/* What the table says about an extension, **own keys only**: `EDITABLE[ext]`
 * and `ext in EDITABLE` both walk to `Object.prototype`, so a file called
 * `x.constructor` read as editable and its tab was handed the inherited
 * function as a `Language`. `undefined` for an extension the table does not
 * name. */
function editableOf(ext) {
    const key = String(ext).toLowerCase();
    return Dictionary.Has(EDITABLE, key) ? EDITABLE[key] : undefined;
}

/* Whether a file of this extension opens in a tab at all. */
function opensInTab(file) {
    return editableOf(File.Extension(file)) !== false;
}

/* And whether it opens as a rendered document rather than as its source. */
function isDocument(file) {
    return File.IsExtension(file, "md");
}

/* How far the board sits from the corner of the room it is drawn in. */
const BOARD_MARGIN = 8;

/*
 * The canvas's context menu.  It used to be declared on `Glass` in the `.form`;
 * the glass is one per tab now, so it is set from here -- and set again on every
 * switch, because a menu exposes its items on the form by name and the names are
 * the same on every tab.
 *
 * **Three of its four entries point at a command** and so carry no name at all,
 * which is most of what that reassignment was for: `MnuCvDel` existed because
 * two widgets cannot both own `MnuDel`, and an item that points at an action is
 * not a widget that owns anything. Rename is still its own, because renaming
 * from the canvas renames the *selection* and renaming from the tree renames the
 * row the pointer is on -- two commands that read the same and are not.
 */
const CANVAS_MENU = [
    { name: "MnuCvRename", text: "Rename..." },
    { action: "ActDelCtl" },
    { separator: true },
    { action: "ActRaise" },
    { action: "ActLower" },
];

Ide.TabSet = class TabSet {

    /* Which files open here at all, asked from outside: a link in a document
     * points at a file of the project and has to know whether the answer is a
     * tab or the desktop. The table is this module's, so the question is too. */
    static opensInTab(file) { return opensInTab(file); }

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide       = ide;
        this.openTabs  = new Map();     // name -> the tab's state
        this.tabOrder  = [];            // and the order the strip shows them in
        this.switching = false;
    }

    /* The active tab's state, or null when nothing is open. */
    activeState() {
        return this.ide.activeFile
            ? this.openTabs.get(this.ide.activeFile) || null : null;
    }

    /*
     * Whether a tab has unsaved changes.  The active one is asked of its widgets,
     * which is where the answer is; every other one had it copied out when it
     * left the screen (see `saveActiveState`).
     */
    dirtyOf(name, state) {
        return name === this.ide.activeFile ? this.liveDirty(state) : state.dirty;
    }

    /*
     * Opens a file in a tab.  If it is already open, focuses it; if not, creates
     * the tab and loads it.  Returns true if it resulted in a switch.
     */
    open(name) {
        if (this.openTabs.has(name)) {
            this.switchTo(name);
            return true;
        }

        const state = this.makeState(name);
        if (!state) return false;

        this.watch(name, state);

        /* The Notebook has one page per open file, made here and destroyed with
         * the tab: with nothing open it has none, and a strip with a nameless
         * page in it is a tab that opens nothing.  There is one SourceEditor and it
         * is moved into whichever page is active; between files it waits in
         * WorkArea, which is where the .form declares it.
         *
         * A box and not a Panel, even though the rest of this window is drawn in
         * coordinates now.  HAlign "Fill" keeps the gaps a control was drawn
         * with, so it needs a design size to keep them from -- and a view is
         * made here, by code, with no idea how big the page will be.  An
         * editor put in one would keep its natural size and leave the rest of
         * the page empty.  A box has no such question: it fills. */
        const view = new Panel();
        view.Arrangement = "Vertical";
        this.ide.Tabs.Append(view);

        /*
         * A code tab gets its own editor, made here and destroyed with the page.
         * Which is what buys the thing a single editor could not have: the undo
         * history, the selection and the scroll position are the widget's, so
         * they survive a switch without anyone saving and restoring them.
         *
         * Named "Editor" like every other one, because events dispatch by name
         * and only the tab on screen has any: `Editor_Change` is whichever is
         * showing.  `ide.Editor` is repointed at it -- see placeContent.
         */
        if (state.mode === "edit") {
            const ed = new SourceEditor();
            ed.Name            = "Editor";
            ed.Expand          = true;
            ed.ShowLineNumbers = true;

            /*
             * The words already in the file, offered as you type. The floor of
             * what an editor owes: no knowledge of the language, so typing a
             * control's name a second time is a keystroke and nothing more is
             * claimed. What knows what the text *means* is the other provider,
             * fed from `Completion.js` through the `Complete` event.
             */
            ed.Completion = true;

            /*
             * ...and what the *project* knows, which is the other half:
             * `MainForm.Editor_Complete` answers with the controls of the form
             * beside this file, the properties and events of their real types,
             * and the members of the runtime's own globals. The title is the
             * application's word for it, so it goes through the catalogue like
             * any other caption.
             */
            ed.CompletionTitle = Locale.Text("This project");

            ed.Language = state.language;
            ed.Text     = state.text;
            ed.Modified = false;
            ed.ReadOnly = !!state.foreign;
            state.editor = ed;

            /*
             * The breakpoints this file had.  They belong to the gutter and the
             * gutter belongs to the tab, so closing one would lose them: the
             * debugger keeps the lines of every file it has seen marked, and
             * puts them back on the editor that opens next.
             */
            this.ide.debugger_.restore(name, ed);

            /*
             * A document tab is this tab with a preview in front of it: the
             * editor stays, holding the text, so the modified flag, the save,
             * the reload from disk, the find bar, the session and the recovery
             * are the ones every other code tab has. `Ide.Document` adds the bar
             * and the rendered page, and puts the editor in itself -- which is
             * why this branch does not.
             */
            if (isDocument(name)) {
                state.document = new Ide.Document(
                    this.ide, view, ed, File.Join(this.ide.project, name));
            } else {
                view.Add(ed);
            }
        } else {
            /*
             * A form tab gets a canvas of its own, and a Designer driving it.
             * The names are the same on every tab -- events dispatch by name and
             * only the page on screen has any, so `Glass_MouseDown` is whichever
             * one is showing; `ide.Surface` and friends are repointed at it by
             * placeContent, exactly as `ide.Editor` is.
             *
             * The side panel is *not* per tab: palette, control tree and
             * property grid are chrome about the selection, and there is one
             * selection because there is one active tab.
             */
            const scroll   = new Scroller();
            const board    = new Panel();
            const titlebar = new Ide.TitleBar();
            const menubar  = new Ide.MenuBar(this.ide);
            const canvas   = new Overlay();
            const surface  = new Panel();
            const glass    = new Panel();

            scroll.Name  = "CanvasScroll"; canvas.Name  = "Canvas";
            surface.Name = "Surface";      glass.Name   = "Glass";
            board.Name   = "Board";
            scroll.Expand = true;

            /* The form is not flush against the corner of the room it is drawn
             * in, and it is drawn with the decoration it will be shown with: the
             * desktop's title bar over the canvas and the form's own menu bar
             * under it, on a board with a margin -- which is what a window on a
             * desk looks like.  The board is a column so the three stack without
             * any of them being told a size, and there are no gaps: a title bar
             * sits *on* the window and a menu bar *in* it (TitleBar.js and
             * MenuBar.js for where the design of each comes from). */
            board.Arrangement = "Vertical";
            board.Margin      = BOARD_MARGIN;
            board.Spacing     = 0;
            board.HAlign      = "Start";
            board.VAlign      = "Start";

            /* The shape and the shadow of the window are the board's, since it
             * is the board that *is* the window -- bar and canvas together. */
            titlebar.decorate(board);

            view.Add(scroll);
            scroll.Add(board);
            board.Add(titlebar.panel);
            /* Between the decoration and the canvas, which is where the runtime
             * puts the real one: a menu bar is a sibling of the surface, above
             * it, and spans the whole window. */
            board.Add(menubar.panel);
            board.Add(canvas);
            canvas.Add(surface);
            canvas.Add(glass);

            state.canvas   = { scroll, canvas, surface, glass, board, titlebar, menubar };
            state.designer = new Ide.Designer(this.ide,
                                          { surface, glass, view: scroll, titlebar,
                                            menubar });
            /* The list, not setComponents: it has to be known before the tree is
             * built, because a component becomes a stand-in -- but rebuilding the
             * shared palette is `adopt`'s job, and the switch that follows does
             * it.  Doing both was two rebuilds per file opened. */
            state.designer.components = this.ide.components;
            state.designer.loadRoot(state.root, File.Join(this.ide.project, name));
            /* Reading a form is not editing it. */
            state.designer.dirty = false;
        }

        const label = new Label();
        label.Text = name;
        this.ide.Tabs.SetTabLabel(this.ide.Tabs.Count - 1, label);

        state.view = view;
        state.label = label;
        this.openTabs.set(name, state);
        this.tabOrder.push(name);

        this.switchTo(name);
        return true;
    }

    /*
     * **A file that is not UTF-8 opens read-only, and is never written from
     * here.** `File.Load` answers text, and text cannot hold a byte that is not
     * one: every invalid sequence becomes U+FFFD. So a Latin-1 `.js` opened and
     * saved came back with every accented letter replaced -- silently, and for
     * good, since the bytes were never in the IDE to be put back.
     *
     * The question is the bytes' and not the text's: `Bytes.ToText()` refuses
     * what is not valid UTF-8, where looking for U+FFFD in the text would call
     * a file that legitimately contains one foreign. Every road that writes a
     * tab asks `state.foreign` -- save, save all, the IDE's own rewrites of a
     * source, a recovery snapshot and its restore -- and the editor is
     * `ReadOnly`, so it never becomes dirty and no question on the way out
     * offers to save it.
     */
    static notUtf8(path) {
        try {
            File.LoadBytes(path).ToText();
            return false;
        } catch (e) {
            return true;
        }
    }

    /* Whether an open tab is one of those, for the status bar. */
    isForeign(name) {
        const state = name ? this.openTabs.get(name) : null;
        return !!(state && state.foreign);
    }

    warnForeign(name) {
        this.ide.log(Locale.Text("{0} is not UTF-8: it is open read-only and will not be saved from the IDE.",
                                 name) + "\n");
    }

    makeState(name) {
        const path = File.Join(this.ide.project, name);
        if (!File.Exists(path)) {
            Message.Error("The project has no {0}.", name);
            return null;
        }
        const ext = File.Extension(name).toLowerCase();

        /* Read-only as text, whatever it is: a designer would serialise it
         * back, which is the write this exists to prevent. */
        if (Ide.TabSet.notUtf8(path)) {
            const onDisk = File.Load(path);
            this.warnForeign(name);
            return {
                name, mode: "edit", foreign: true,
                text: onDisk, onDisk,
                language: editableOf(ext) || "",
                line: 1, column: 1,
                dirty: false,
            };
        }

        /*
         * What the file said when it was read, kept whatever the mode is. It is
         * what tells a change made *here* from one made outside: the IDE writes
         * these files itself, so a watch that reported every write would put a
         * notice up after every save. Comparing the bytes is exact and answers
         * the other half too -- somebody rewriting a file with the same content
         * has changed nothing, and saying so would be noise.
         */
        const onDisk = File.Load(path);

        if (ext === "form") {
            const root = File.LoadJson(path);
            return { name, mode: "design", root, onDisk, dirty: false };
        }
        return {
            name, mode: "edit",
            text: onDisk,
            onDisk,
            language: editableOf(ext) || "",
            line: 1, column: 1,
            dirty: false,
        };
    }


    /*
     * Changes the active tab.  The previous one saves its state; the new one
     * loads it into the editor or the designer.  The switch fires the Notebook's
     * switch-page signal, which re-enters here; the `switching` guard
     * cuts that off.
     */
    switchTo(name) {
        if (this.ide.activeFile === name) return;
        if (!this.openTabs.has(name)) return;

        /*
         * Switching is not re-entrant.  Loading a tab destroys and rebuilds
         * widgets, and destroying the one that holds the focus makes GTK move
         * the focus -- into another page, which makes the notebook follow it and
         * fire Switch.  Acting on that sent the IDE straight back to the tab it
         * was leaving, mid-load.  While we are the ones deciding, the notebook
         * does not get a vote.
         */
        if (this.switching) return;
        this.switching = true;

        /* A check put off for the tab being left would read the wrong file by
         * the time it fired. What it already reported stays: a name that does
         * not exist is wrong whether or not one is looking at it. */
        this.ide.live.left();

        try {
            this.switchNow(name);
        } finally {
            this.switching = false;
        }

        /* And the file arriving is checked without waiting for a keystroke:
         * opening a file is exactly when one wants to know. */
        this.ide.live.typed();

        /* The bar belongs to the tab on screen: a file that changed behind a tab
         * one was not looking at has its say when that tab comes forward. */
        this.ide.showReloadBar();
    }

    switchNow(name) {
        if (this.ide.activeFile) this.saveActiveState();

        /* What goes into the new tab's page is `loadActiveState`'s to decide --
         * it is the one that knows whether this tab is code or a form -- and
         * `placeContent` puts it there.  Which is why `activeFile` moves first:
         * the page it names is where the content is about to go. */
        this.ide.activeFile = name;

        this.loadActiveState(name);

        this.ide.Tabs.Current = this.tabOrder.indexOf(name);

        if (this.ide.FileTree.Key !== name) {
            this.ide.muted = true;
            this.ide.FileTree.Key = name;
            this.ide.muted = false;
        }

        this.render();
        this.ide.refresh();
    }

    saveActiveState() {
        const state = this.activeState();
        if (!state) return;
        if (state.mode === "design" && state.designer) {
            /* The designer keeps the form open, so this is not what makes the
             * tab survive a switch any more -- it is what keeps `state.root`
             * answerable for anything that reads the tree without the surface. */
            state.root  = state.designer.dirty ? state.designer.serializeForm()
                                               : state.designer.root;
            state.dirty = state.designer.dirty;
        } else if (state.editor) {
            /* Text, caret, undo: all of it is the tab's own editor's and stays
             * there. Only the flag is copied out, because the tab label reads
             * it while another tab is on screen. */
            state.dirty = state.editor.Modified;
        }
    }

    loadActiveState(name) {
        const state = this.openTabs.get(name);
        if (!state) return;

        if (state.mode === "design") {
            this.setMode(true);
            /* Nothing to load: this tab's designer has had the form open all
             * along, with its selection and its undo history.  What changes
             * hands is the shared side panel, which `adopt` fills in. */
            /* ...unless the file was rewritten while the tab was behind
             * another one -- see `setRoot`. Loaded now, when this designer is
             * the one the shared side panel speaks for. */
            if (state.stale && state.designer) {
                state.stale = false;
                state.designer.loadRoot(state.root, File.Join(this.ide.project, name));
                state.designer.dirty = state.dirty;
            }
            this.ide.designer.setComponents(this.ide.components);
            this.ide.designer.adopt();
        } else {
            /* Nothing to load: the tab's editor has held its text, its caret and
             * its undo history all along.  Reassigning them here is exactly what
             * threw the history away on every switch. */
            this.setMode(false);
        }
    }

    /* Refreshes the tab texts.  With GtkNotebook the label is a widget; these
     * are Labels we can mutate. */
    render() {
        /*
         * A notebook with no pages is not nothing: it is an expanding widget with
         * an empty body, and it took 209px of the work area between the toolbar
         * and a blank editor before anyone opened a file.  With no page there is
         * no tab to click and no tab action to take, so the strip goes away
         * entirely and the editor has the room.
         */
        this.ide.Tabs.Visible = this.ide.Tabs.Count > 0;
        /* The column the notebook is in goes with it: with no page there is no
         * editor either, so nothing in it has anything to show. */
        this.ide.EditorBox.Visible = this.ide.Tabs.Count > 0;

        for (let i = 0; i < this.tabOrder.length; i++) {
            const name  = this.tabOrder[i];
            const state = this.openTabs.get(name);
            if (!state || !state.label) continue;
            state.label.Text = this.dirtyOf(name, state) ? `${name} *` : name;
        }
    }

    close(index) {
        if (index < 0 || index >= this.tabOrder.length) return;
        const name  = this.tabOrder[index];
        const state = this.openTabs.get(name);
        if (!state) return;

        const doClose = () => this.closeByName(name, /* force */ true);

        if (this.dirtyOf(name, state)) {
            /* The msgid is the catalogue's `Close {0} without saving the
             * changes?`, with the name as a value: a template literal here was
             * already interpolated by the time it reached the dialog, so no
             * catalogue could ever match it. */
            ConfirmForm.ask(Locale.Text("Close tab"),
                            Locale.Text("Close {0} without saving the changes?", name),
                            Locale.Text("Close without saving"), doClose);
        } else {
            doClose();
        }
    }

    /* Removes the tab without asking: used by Ctrl+W after confirming, and by
     * the delete-on-disk paths. */
    closeByName(name, force) {
        const index = this.tabOrder.indexOf(name);
        if (index < 0) return;
        const state = this.openTabs.get(name);
        if (!state) return;
        if (!force && this.dirtyOf(name, state)) {
            this.close(index);
            return;
        }

        const wasActive = this.ide.activeFile === name;
        const next = this.tabOrder[index + 1] || this.tabOrder[index - 1];

        /* A page belongs to the file that opened it and takes what is in it
         * with it: its editor, or its canvas and the designer driving it.
         * Nothing has to be rescued first, which is the point of a page owning
         * its content. */
        this.unwatch(state);          /* nothing to report about a file nobody has open */
        /* And the names it was checked for.  **A source that cannot refresh
         * itself must not leave rows behind**: the live check reads the *active*
         * editor, so a row about a file that is no longer open could never be
         * corrected -- it would sit in the panel being wrong. */
        this.ide.live.forget(name);
        /* What the page did *not* keep to itself: the previewed menu bar hangs
         * its items and their handlers off the IDE's own form, which is the one
         * thing a closed page cannot take with it. */
        if (state.canvas && state.canvas.menubar) state.canvas.menubar.dispose();
        /* The breakpoints of a code tab go with it, and the map is where a
         * closed file keeps them: read before the editor is gone. */
        if (state.editor) this.ide.debugger_.remember(name, state.editor);
        this.ide.Tabs.RemovePage(index);
        this.openTabs.delete(name);
        this.tabOrder.splice(index, 1);

        if (wasActive) {
            if (next) {
                /* Which hands the side panel over to the page that comes
                 * forward. */
                this.switchTo(next);
            } else {
                /* Last file: with no page to be in, setMode below puts the
                 * editor back where the .form declares it, showing nothing. */
                this.ide.activeFile = null;
                this.setMode(false);
                this.render();
                this.ide.refresh();
            }
        } else {
            this.render();
            this.ide.refresh();
        }
    }

    closeActive() {
        if (!this.ide.activeFile) return;
        const idx = this.tabOrder.indexOf(this.ide.activeFile);
        if (idx >= 0) this.close(idx);
    }

    closeAll() {
        return this.closeMany([...this.tabOrder]);
    }

    /* Every tab, now and without asking: for leaving a project, whose doors
     * asked already (`MainForm.leaveProject`). */
    discardAll() {
        for (const name of [...this.tabOrder]) this.closeByName(name, true);
    }

    /* Every tab but the one named. */
    closeOthers(keep) {
        return this.closeMany(this.tabOrder.filter((name) => name !== keep));
    }

    /* Closing several tabs is the question closing one already asks -- asked
     * once, naming them. It used to be `closeByName(name, true)` in a loop, and
     * `true` is *force*: Close all and Close others dropped unsaved work with
     * no word at all. */
    closeMany(names, then) {
        return this.whenSettled(names, Locale.Text("Close tabs"),
                         Locale.Text("Close without saving"),
                         Locale.Text("Save and close"), () => {
            for (const name of names) this.closeByName(name, /* force */ true);
            if (then) then();
        });
    }

    /*
     * `then` runs once none of `names` holds unsaved work: at once when none
     * does, and otherwise after the one question -- discard, or save and go on.
     * A save that fails goes on with nothing: the tab is still there and still
     * dirty, and the error said why.
     */
    whenSettled(names, title, discardText, saveText, then) {
        const dirty = names.filter((name) => {
            const state = this.openTabs.get(name);
            return state && this.dirtyOf(name, state);
        });
        if (!dirty.length) { then(); return; }

        return ConfirmForm.ask(title,
            Locale.Plural("{1} has unsaved changes.",
                          "{0} files have unsaved changes:\n{1}",
                          dirty.length, dirty.join(", ")),
            discardText, then,
            { Text: saveText,
              Run:  () => { if (this.saveAllDirty(dirty)) then(); } });
    }

    rename(oldName, newName) {
        const state = this.openTabs.get(oldName);
        if (!state) return;
        this.ide.debugger_.renamed(oldName, newName);
        state.name = newName;
        /* The designer saves to its own `path`, and a tab renamed while it is
         * not on screen is not reloaded until it is: without this, saving it
         * wrote the file it used to be. */
        if (state.designer)
            state.designer.path = File.Join(this.ide.project, newName);
        /* The watch was on the old path, which is gone: a change to the file
         * the tab now holds would go unnoticed, and the tab would go on
         * answering for a path nothing is at. */
        if (state.watch) {
            this.unwatch(state);
            this.watch(newName, state);
        }
        this.openTabs.delete(oldName);
        this.openTabs.set(newName, state);
        const idx = this.tabOrder.indexOf(oldName);
        if (idx >= 0) this.tabOrder[idx] = newName;
        if (this.ide.activeFile === oldName) {
            this.ide.activeFile = newName;
        }
        this.render();
    }

    cycle(direction) {
        if (this.tabOrder.length <= 1) return;
        const idx = this.tabOrder.indexOf(this.ide.activeFile);
        const next = ((idx < 0 ? 0 : idx) + direction + this.tabOrder.length)
                     % this.tabOrder.length;
        this.switchTo(this.tabOrder[next]);
    }

    /* What is on disk just changed: syncs the tab (if open) with the file.
     * When the tab is the active one, `targetLine` takes the cursor where
     * whoever wrote it meant to go. */
    reloadFromDisk(name, targetLine) {
        const state = this.openTabs.get(name);
        if (!state) return;
        const path = File.Join(this.ide.project, name);

        /* What was read is what the watch compares against: without it, the
         * file the IDE itself just wrote reads as somebody else's change. */
        try { state.onDisk = File.Load(path); } catch (e) { /* gone */ }

        /* A file that has become UTF-8 since, or stopped being it, changes
         * whether the tab may write -- and a form that stopped being one
         * cannot be drawn, so it is left to be closed and opened again. */
        const foreign = Ide.TabSet.notUtf8(path);
        if (foreign && !state.foreign) this.warnForeign(name);

        if (state.mode === "design" && foreign) {
            state.foreign = true;
        } else if (state.mode === "design") {
            state.foreign = false;
            this.setRoot(name, File.LoadJson(path), false);
        } else {
            state.text     = File.Load(path);
            state.line     = targetLine || 1;
            state.column   = 1;
            state.dirty    = false;
            /* The tab's own editor, whether or not it is the one on screen: a
             * file that changed on disk changed for every tab holding it. */
            state.foreign  = foreign;
            if (state.editor) {
                state.editor.ReadOnly = foreign;
                state.editor.Text     = state.text;
                state.editor.Modified = false;
                if (targetLine) state.editor.GotoLine(targetLine);
            }
            /* And the page that is drawn from that text. A tab showing its
             * source is left where it is: what changed is the text it is
             * editing, which the editor above already has. */
            if (state.document && !state.document.editing()) state.document.refresh();
        }
    }

    /*
     * A design tab handed a new tree -- the file reloaded, or a rewrite the IDE
     * made to it, like a class retyped.
     *
     * **A tab behind another one has a designer too, and that designer is what
     * saves.** This used to set `state.root` alone for a tab not on screen, and
     * the tab's own designer kept the old tree, the old class and the old path:
     * `loadActiveState` has nothing to load, by design, so switching to it
     * showed the old form and saving it wrote the old `.form` back -- after a
     * rename, under the name it had left. The tab is marked `stale` instead and
     * its designer loads the tree when it comes on screen, because loading it
     * now would have it drive the side panel, which speaks for the tab that is.
     */
    setRoot(name, root, dirty) {
        const state = this.openTabs.get(name);
        if (!state || state.mode !== "design") return;

        state.root  = root;
        state.dirty = dirty;
        if (!state.designer) return;

        if (this.ide.activeFile === name) {
            state.stale = false;
            state.designer.loadRoot(root, File.Join(this.ide.project, name));
            state.designer.dirty = dirty;
            state.designer.refresh();
        } else {
            state.stale = true;
            state.designer.dirty = dirty;
        }
    }

    /* The only thing that differs between the in-memory snapshot and reality:
     * the modified flag, which lives in the widget.  A code tab owns its editor
     * so this is true of any tab, not just the one on screen; the designer is
     * still one, so for a design tab it is only true of the active one. */
    liveDirty(state) {
        if (!state) return false;
        if (state.mode === "design") {
            return state.designer ? state.designer.dirty : state.dirty;
        }
        return state.editor ? state.editor.Modified : state.dirty;
    }

    setMode(designing) {
        this.ide.designing = designing;
        this.placeContent();
    }

    /*
     * The active page holds the content, and that is the whole of it: the editor
     * when the tab is code, the design host when it is a form.  The other one
     * waits hidden in `WorkArea`, where the `.form` declares both.
     *
     * It used to be the other way round -- the pages stayed empty and the two
     * hung *below* the notebook, shown and hidden in place.  That is a notebook
     * used for its tab strip alone, and it cost exactly what you would expect:
     * the empty page went on claiming height, so a blank band opened between the
     * tabs and the designer, and `Tabs.VExpand = !designing` was there to beat it
     * back.  With the content in the page there is no empty page to claim
     * anything, the notebook expands the way a notebook does, and the band is not
     * something that can happen.
     *
     * Nothing moves when nothing changed: re-parenting takes the focus with it,
     * and this runs on every tab switch.
     */
    placeContent() {
        const state = this.activeState();

        /*
         * Nothing moves: a page owns what is in it, and switching a notebook is
         * all the showing and hiding there is.  What this does is repoint the
         * names -- `ide.Editor`, `ide.designer`, `ide.Surface` -- at the tab
         * on screen.  They are not controls of the `.form` any more; they are
         * words for "the active one", and `null` when there is none.
         */
        this.ide.Editor   = state ? state.editor   || null : null;
        this.ide.designer = state ? state.designer || null : null;
        this.ide.document = state ? state.document || null : null;

        if (state && state.canvas) {
            this.ide.CanvasScroll = state.canvas.scroll;
            this.ide.Canvas       = state.canvas.canvas;
            this.ide.Surface      = state.canvas.surface;
            this.ide.Glass        = state.canvas.glass;
            /* Re-exposes MnuCv* on the form as this tab's; see CANVAS_MENU. */
            this.ide.Glass.Menu   = CANVAS_MENU;
        }

        /* The panel used to speak about a selection alone, and so was hidden
         * on every code tab -- 280 pixels of nothing beside the one kind of file
         * that has wanted a list of what is in it since Visual Basic. It holds
         * two things now and `Outline` decides which, because which one belongs
         * there is the same question as what is in it. */
        this.ide.outline.place();

        /* And the find bar speaks about an editor, which has just changed hands. */
        this.ide.finder.sync();
    }

    save() {
        const state = this.activeState();
        if (!state) return false;

        if (!this.liveDirty(state)) return true;   // nothing to save
        if (state.foreign) { this.warnForeign(state.name); return false; }

        if (state.mode === "design") {
            if (!this.ide.designer.save()) return false;
        } else {
            try {
                File.Save(File.Join(this.ide.project, this.ide.activeFile), this.ide.Editor.Text);
            } catch (e) {
                Message.Error("Could not save {0}:\n{1}", this.ide.activeFile, e.message);
                return false;
            }
            this.ide.Editor.Modified = false;
        }
        state.dirty = false;
        /* What is on disk is what we just wrote, so the watch has nothing to
         * report -- this is the line that keeps a notice off every save. */
        try { state.onDisk = File.Load(File.Join(this.ide.project, this.ide.activeFile)); }
        catch (e) { /* saved and then removed: the watch will say so */ }
        state.changedOnDisk = false;
        this.ide.log(`Saved ${this.ide.activeFile}\n`);
        this.checkSyntax(this.ide.activeFile, this.ide.Editor);
        /* A saved `.form` is a different set of controls to propose. */
        this.ide.completion.forget();
        this.render();
        this.ide.afterSave();
        this.ide.refresh();
        return true;
    }

    /*
     * What the file says the moment it lands on disk.
     *
     * `Application.CheckSource` compiles without running, so asking is free of
     * consequence -- and the answer says *where*, which is what puts the
     * complaint in the gutter beside the line rather than in a dialog about a
     * file.  The line is named in the console too, where `SOURCE_LINK` makes it
     * clickable: the mark is for the file one is looking at, the line for the
     * file one is not.
     *
     * **On save and not on every keystroke.** Half a line is not a syntax error,
     * and an editor that says so while one is still typing it is an editor
     * nobody leaves switched on.  Saving is the moment the file becomes
     * something another process would read.
     *
     * It never refuses the save: code that does not compile is exactly what one
     * wants written down before going to look something up.
     */
    checkSyntax(name, editor) {
        if (!editor || !File.IsExtension(name, "js")) return true;

        /* Only ours: a bookmark or a mark somebody else put there is not this
         * function's to clear. */
        editor.ClearMarks("Error");

        const bad = Application.CheckSource(editor.Text);

        /* Its own source, keyed by the file: saving one file says nothing about
         * whether another still compiles, and a collector that let it would
         * clear a complaint nobody answered. */
        this.ide.problems.report(`syntax:${name}`, bad
            ? [{ kind: "Error", file: name, line: bad.Line, text: bad.Message }]
            : []);

        if (!bad) return true;

        if (bad.Line > 0) editor.Mark(bad.Line, "Error", bad.Message);
        this.ide.log(`${name}:${bad.Line}: ${bad.Message}\n`);
        return false;
    }

    /* --- what happens to a file while it is open --------------------------
     *
     * An editor open on a file somebody else rewrote had no way to know, and
     * the only cure was remembering to reload by hand. `File.Watch` is the
     * runtime's answer; this is what the IDE does with it.
     *
     * **The IDE writes these files itself**, so the question is never "did it
     * change" but "did somebody else change it". The bytes on disk against the
     * bytes last read answers that exactly, and answers a second question for
     * free: a rewrite with identical content has changed nothing worth a notice.
     */
    watch(name, state) {
        const path = File.Join(this.ide.project, name);

        state.watch = File.Watch(path, () => {
            const tab = this.openTabs.get(name);
            if (!tab) return;

            /*
             * **The event is a hint; the disk is the answer.** A `"Deleted"`
             * does not mean the file is gone -- it means something happened to
             * that path, and plenty of programs rewrite a file by taking the
             * old one away and putting a new one there. `git restore` is one of
             * them, so discarding a change said *ClientsForm.js is no longer on
             * disk* about a file that was sitting right there, restored.
             *
             * Asking is one `File.Exists`, and it cannot be wrong in the way
             * believing the event can.
             */
            const gone = !File.Exists(path);
            const was  = tab.goneFromDisk;

            tab.goneFromDisk = gone;
            if (gone) {
                this.ide.showReloadBar();
                return;
            }

            let now;
            try { now = File.Load(path); } catch (e) { return; }

            if (now === tab.onDisk) {
                /* Our own save, or a file that came back exactly as it was --
                 * which still has a notice to take down if one went up. */
                if (!was) return;
                tab.changedOnDisk = false;
            } else {
                tab.changedOnDisk = true;
            }
            this.ide.showReloadBar();
        });
    }

    unwatch(state) {
        if (state && state.watch) {
            state.watch.Stop();
            state.watch = null;
        }
    }

    /*
     * Taking the file as it is now: the tab is rebuilt from disk, which is what
     * `reloadFromDisk` already did for the file the IDE itself rewrote.
     */
    takeFromDisk(name) {
        const state = this.openTabs.get(name);
        if (!state) return;

        state.changedOnDisk = false;
        state.goneFromDisk  = false;
        state.onDisk        = File.Load(File.Join(this.ide.project, name));
        this.reloadFromDisk(name);
        this.ide.showReloadBar();
    }

    /*
     * A change the IDE makes to a source file by itself -- a control's handlers
     * following its new name, a class renamed with its form -- applied to
     * **both** copies there are: the file, and the open tab's editor.
     *
     * It used to be the file alone, and the tab kept the old text: a dirty tab
     * then saved the old names back over the rename, and even a clean one sat
     * there saying `class Form1` until the next save wrote it. The file is
     * written so the pair on disk agrees (the `.form` beside it has just been
     * saved); the editor gets the same change on top of whatever was typed into
     * it, and stays exactly as dirty as it was. Assigning `Text` costs the tab
     * its undo history, which is the price of not losing its content.
     *
     * `change(text)` answers the new text; answering the same text is no change.
     */
    rewriteSource(name, change) {
        const path  = File.Join(this.ide.project, name);
        const state = this.openTabs.get(name);

        /* Not a byte of a file that is not UTF-8: the rewrite would be its
         * text, which is the file with its accents gone. Said, not skipped. */
        if ((state && state.foreign) || (File.Exists(path) && Ide.TabSet.notUtf8(path))) {
            this.warnForeign(name);
            return;
        }

        if (File.Exists(path)) {
            const disk = File.Load(path);
            const next = change(disk);
            if (next !== disk) File.Save(path, next);
            if (state) state.onDisk = next;
        }

        const editor = state && state.editor;
        if (!editor) return;

        const text = editor.Text;
        const next = change(text);
        if (next === text) return;

        const dirty = this.liveDirty(state);
        const line  = editor.Line;

        editor.Text     = next;
        editor.Modified = dirty;
        state.text      = next;
        state.dirty     = dirty;
        editor.GotoLine(line);
        this.render();
    }

    /* Walks every dirty tab and saves it.  Run and MnuSaveAll use it: a .form
     * and its .js travel together, and one cannot run with either unsaved. */
    /* Saves every dirty tab, or only those of `only`, and answers whether all
     * of them were saved -- which is what lets "save and close" not close the
     * one that failed. */
    saveAllDirty(only) {
        const wasActive = this.ide.activeFile;
        let   ok        = true;

        for (const name of [...this.tabOrder]) {
            if (only && !only.includes(name)) continue;
            const state = this.openTabs.get(name);
            if (!state) continue;
            if (!this.dirtyOf(name, state)) continue;
            if (state.foreign) { this.warnForeign(name); ok = false; continue; }
            this.switchTo(name);
            if (state.mode === "design") {
                if (!this.ide.designer.save()) { ok = false; continue; }
                try { state.onDisk = File.Load(File.Join(this.ide.project, name)); }
                catch (e) { /* nothing to compare against */ }
                state.changedOnDisk = false;
            } else {
                try {
                    File.Save(File.Join(this.ide.project, name), state.editor.Text);
                } catch (e) {
                    Message.Error("Could not save {0}:\n{1}", name, e.message);
                    ok = false;
                    continue;
                }
                state.editor.Modified = false;
                state.onDisk = state.editor.Text;   /* ours, not somebody else's */
                state.changedOnDisk = false;
                this.checkSyntax(name, state.editor);
            }
            state.dirty = false;
        }
        if (wasActive && this.ide.activeFile !== wasActive) this.switchTo(wasActive);
        this.render();
        this.ide.afterSave();
        this.ide.refresh();
        return ok;
    }

    /* Whether there are unsaved changes, whichever the mode.  This is about the
     * active tab: each tab knows its own, the global question is saveAllDirty's. */
    isDirty() {
        const state = this.activeState();
        return state ? this.liveDirty(state) : false;
    }

    /*
     * Which tabs have unsaved changes.  A dialog that asks about them has to be
     * able to *name* them -- "3 files have unsaved changes" with no list is a
     * question nobody can answer -- and `hasDirty` is the same walk answered
     * yes or no.  One walk, so the two can never disagree about what is dirty.
     */
    dirtyNames() {
        const out = [];
        for (const [name, state] of this.openTabs) {
            if (this.dirtyOf(name, state)) out.push(name);
        }
        return out;
    }

    hasDirty() { return this.dirtyNames().length > 0; }

    /*
     * What one open tab holds *right now*, as something `File.SaveJson` can
     * write. `Recovery` is the caller, and the knowledge of where a tab keeps
     * its content stays here, where the tabs are made.
     *
     * The live widget and not `state`, for the same reason `saveActiveState`
     * exists: the active tab's text is in its editor and its tree is on its
     * surface, and `state` is only caught up when the tab is switched away
     * from -- which is exactly the tab a crash is most likely to take.
     */
    contentOf(name) {
        const state = this.openTabs.get(name);
        if (!state || state.foreign) return null;

        if (state.mode === "design") {
            return { name, mode: "design",
                     root: state.designer && !state.stale
                         ? state.designer.serializeForm() : state.root };
        }
        return { name, mode: "edit",
                 text: state.editor ? state.editor.Text : state.text };
    }

    /*
     * ...and back again, into a tab opened for it, left **dirty**: what is on
     * screen is not what is in the file, and the tab has to say so.
     *
     * The mode is checked against the tab's own rather than trusted: a snapshot
     * outlives the project it was taken from, and a `.form` that has since
     * become something else would otherwise be handed a tree to draw.
     */
    restore(snap) {
        if (!snap || !snap.name || !this.open(snap.name)) return false;

        const state = this.openTabs.get(snap.name);
        if (!state || state.mode !== snap.mode || state.foreign) return false;

        if (snap.mode === "design") {
            if (!state.designer) return false;
            state.designer.loadRoot(snap.root,
                                    File.Join(this.ide.project, snap.name));
            state.designer.dirty = true;
        } else {
            if (!state.editor) return false;
            state.editor.Text     = snap.text;
            state.editor.Modified = true;
        }

        state.dirty = true;
        this.render();
        return true;
    }
};
