/*
 * The methods of the file on screen, listed beside it.
 *
 * The side panel speaks about the *selection* -- properties, events, the control
 * tree -- so it was hidden whenever a form was not being designed, which is to
 * say on every code tab. Two hundred and eighty pixels of nothing, next to the
 * one kind of file where a list of what is in it has been standard equipment
 * since 1991.
 *
 * Prior art, and it is the oldest thing in this IDE: Visual Basic's **procedure
 * dropdown**, the pair of combos over every code window, which is how one moved
 * around a form's code for ten years. Delphi's *Code Explorer* and Lazarus's are
 * the tree version of it; VS Code calls the same panel *Outline*. All of them
 * answer one question -- *what is in this file, and take me there* -- and all of
 * them answer it without a search box, which is what separates it from
 * `Ctrl+Shift+O`: that one asks you to know the name.
 *
 * **It has no index and needs none.** `Navigator.symbols` reads the text on
 * screen, which is the same bargain F12 makes and for the same reason written
 * there: an index would have to be thrown away whenever a method is renamed or a
 * tab is edited, and getting that wrong points at a line that no longer declares
 * anything. What it costs is a regular expression over one file, once the typing
 * stops.
 *
 * `Select` and not `Activate`, which is the opposite of what the Problems panel
 * does and for a stated reason: a problem is a place in *another* file, so
 * walking the list with the arrows must not open one per row. An outline is a
 * list of places in the file already open -- moving the cursor through it is the
 * gesture, not a side effect of reading.
 */
"use strict";

Namespace("Ide");

Ide.Outline = class Outline {

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;

        /* Parallel to the rows: the line each one is at. */
        this.lines = [];

        /* What the list already says, so a pass that found the same methods
         * costs a string compare and leaves the selection alone -- rebuilding a
         * list under somebody's cursor is how a panel becomes a nuisance. */
        this.drawn = null;

        /* Set while this class is the one moving the cursor, so the jump it
         * causes is not read back as *where the cursor is now*. */
        this.moving = false;

        /* ...and set while it is the one moving the selection, so the row it
         * marks is not read back as a row somebody chose. Without this the pair
         * eats the cursor: standing on line 40 inside a method declared at 30
         * marks that row, the row jumps to its declaration, and the caret is
         * dragged ten lines back up the file while one is reading. */
        this.syncing = false;
    }

    /*
     * Which half of the side panel is showing.
     *
     * The panel itself is visible for **any** tab now; what changes is what is
     * in it. A form gets the switcher it always had; a code tab gets this. With
     * nothing open there is neither, and the panel goes back to being hidden.
     */
    place() {
        const ide  = this.ide;
        const form = !!ide.designing;

        /* A `.js` and not merely an editor: a document tab has one too, and a
         * README has no methods to list. */
        const code = !!ide.Editor && !!ide.activeFile &&
                     File.Extension(ide.activeFile).toLowerCase() === "js";

        ide.SidePanel.Visible  = code || form;
        ide.SideTabs.Visible   = form;
        ide.OutlineBox.Visible = code;

        if (code) this.refresh();
    }

    /*
     * The list, from the text on screen.
     *
     * Called on the pause after typing -- `Ide.Live` owns that timer, because
     * one pause should mean one pass over the file however many readers it has
     * -- and on a tab switch, which is the other moment the answer changes.
     */
    refresh() {
        const ide = this.ide;
        if (!ide.Editor || !ide.OutlineBox.Visible) return;

        const found = ide.navigator.symbols(ide.Editor.Text);
        const signature = found.map((s) => `${s.line}:${s.name}`).join("\n");
        if (signature === this.drawn) return;

        this.drawn = signature;
        this.lines = found.map((s) => s.line);

        const list = ide.OutlineList;
        list.Clear();
        for (const symbol of found) list.Add(symbol.name);
    }

    /* A row was chosen: go to the line it is at. */
    chosen() {
        if (this.syncing) return;

        const line = this.lines[this.ide.OutlineList.Index];
        if (!line || !this.ide.Editor) return;

        /* `GotoLine` moves the cursor, which is what `Editor_Cursor` reports --
         * and nothing here should read that back as another choice. */
        this.moving = true;
        try {
            this.ide.Editor.GotoLine(line);
            this.ide.Editor.SetFocus();
        } finally {
            this.moving = false;
        }
    }

    /*
     * The cursor moved in the editor: mark the method it is inside.
     *
     * This is the half of Visual Basic's procedure dropdown that is easy to
     * forget and is most of what it was for -- it did not only take you
     * somewhere, it told you where you *were*. The method the cursor is in is
     * the last one declared at or above its line.
     */
    follow() {
        if (this.moving) return;

        const ide = this.ide;
        if (!ide.Editor || !ide.OutlineBox.Visible) return;

        const at = ide.Editor.Line;
        let which = -1;
        for (let i = 0; i < this.lines.length; i++)
            if (this.lines[i] <= at) which = i;

        if (which === ide.OutlineList.Index) return;

        this.syncing = true;
        try {
            ide.OutlineList.Index = which;
        } finally {
            this.syncing = false;
        }
    }
};
