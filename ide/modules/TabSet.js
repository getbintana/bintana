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

/* Whether a file of this extension opens in a tab at all. */
function opensInTab(file) {
    return EDITABLE[File.Extension(file).toLowerCase()] !== false;
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
            view.Add(ed);

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
            state.editor = ed;
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

    makeState(name) {
        const path = File.Join(this.ide.project, name);
        if (!File.Exists(path)) {
            Message.Error("The project has no {0}.", name);
            return null;
        }
        const ext = File.Extension(name).toLowerCase();

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
            language: EDITABLE[ext] || "",
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

        try {
            this.switchNow(name);
        } finally {
            this.switching = false;
        }

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
            ConfirmForm.ask("Close tab",
                            `Close ${name} without saving the changes?`,
                            "Close without saving", doClose);
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
        /* What the page did *not* keep to itself: the previewed menu bar hangs
         * its items and their handlers off the IDE's own form, which is the one
         * thing a closed page cannot take with it. */
        if (state.canvas && state.canvas.menubar) state.canvas.menubar.dispose();
        this.ide.Tabs.Remove(index);
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
        /* Take a copy: closing one mutates tabOrder. */
        for (const name of [...this.tabOrder]) this.closeByName(name, true);
    }

    rename(oldName, newName) {
        const state = this.openTabs.get(oldName);
        if (!state) return;
        state.name = newName;
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

        if (state.mode === "design") {
            state.root  = File.LoadJson(path);
            state.dirty = false;
            if (this.ide.activeFile === name) {
                this.ide.designer.loadRoot(state.root, path);
                this.ide.designer.dirty = false;
                this.ide.designer.refresh();
            }
        } else {
            state.text     = File.Load(path);
            state.line     = targetLine || 1;
            state.column   = 1;
            state.dirty    = false;
            /* The tab's own editor, whether or not it is the one on screen: a
             * file that changed on disk changed for every tab holding it. */
            if (state.editor) {
                state.editor.ReadOnly = false;
                state.editor.Text     = state.text;
                state.editor.Modified = false;
                if (targetLine) state.editor.GotoLine(targetLine);
            }
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

        if (state && state.canvas) {
            this.ide.CanvasScroll = state.canvas.scroll;
            this.ide.Canvas       = state.canvas.canvas;
            this.ide.Surface      = state.canvas.surface;
            this.ide.Glass        = state.canvas.glass;
            /* Re-exposes MnuCv* on the form as this tab's; see CANVAS_MENU. */
            this.ide.Glass.Menu   = CANVAS_MENU;
        }

        /* The panel speaks about a selection, and there is one only while a form
         * is being designed. */
        this.ide.SidePanel.Visible = this.ide.designing;

        /* And the find bar speaks about an editor, which has just changed hands. */
        this.ide.finder.sync();
    }

    save() {
        const state = this.activeState();
        if (!state) return false;

        if (!this.liveDirty(state)) return true;   // nothing to save

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
        if (!editor || File.Extension(name).toLowerCase() !== "js") return true;

        /* Only ours: a bookmark or a mark somebody else put there is not this
         * function's to clear. */
        editor.ClearMarks("Error");

        const bad = Application.CheckSource(editor.Text);
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

        state.watch = File.Watch(path, (event) => {
            const tab = this.openTabs.get(name);
            if (!tab) return;

            if (event === "Deleted") {
                tab.goneFromDisk = true;
            } else {
                let now;
                try { now = File.Load(path); } catch (e) { return; }
                if (now === tab.onDisk) return;      /* our own save, or no change */
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

    /* Walks every dirty tab and saves it.  Run and MnuSaveAll use it: a .form
     * and its .js travel together, and one cannot run with either unsaved. */
    saveAllDirty() {
        const wasActive = this.ide.activeFile;
        for (const name of [...this.tabOrder]) {
            const state = this.openTabs.get(name);
            if (!state) continue;
            if (!this.dirtyOf(name, state)) continue;
            this.switchTo(name);
            if (state.mode === "design") {
                this.ide.designer.save();
                try { state.onDisk = File.Load(File.Join(this.ide.project, name)); }
                catch (e) { /* nothing to compare against */ }
                state.changedOnDisk = false;
            } else {
                File.Save(File.Join(this.ide.project, name), state.editor.Text);
                state.editor.Modified = false;
                state.onDisk = state.editor.Text;   /* ours, not somebody else's */
                state.changedOnDisk = false;
                this.checkSyntax(name, state.editor);
            }
            state.dirty = false;
        }
        if (wasActive && this.ide.activeFile !== wasActive) this.switchTo(wasActive);
        this.render();
        this.ide.refresh();
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
        if (!state) return null;

        if (state.mode === "design") {
            return { name, mode: "design",
                     root: state.designer ? state.designer.serializeForm()
                                          : state.root };
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
        if (!state || state.mode !== snap.mode) return false;

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
