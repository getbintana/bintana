/*
 * What the form is made of, as a tree.
 *
 * A canvas cannot show everything it holds: a control behind another one, or
 * inside a container too small to aim at, has nowhere to be clicked.  This is
 * the other way in, and the only way to reach some of them.
 *
 * Selecting from either side ends in the same place -- `Designer.setSelection`
 * is the one funnel -- so the two can never disagree about what is selected.
 *
 * One per designer, unlike the palette: `WidgetTree` is a single widget, but
 * what it shows is *this* form's controls, so each open form keeps its own idea
 * of what is on it and what is selected.  Whichever designer is on screen fills
 * it in; a rebuild only happens when the shape of the form really changed.
 */
"use strict";

Namespace("Ide");

/* The tree's root, standing for the form itself. Not a name a control could
 * have, so it can never collide with one. */
const TREE_ROOT = "@form";

Ide.ControlTree = class ControlTree {

    /** @param {Ide.Designer} designer */
    constructor(designer) {
        this.designer = designer;

        /* What was built, so nothing is rebuilt for an edit the tree cannot
         * show; and which key is on it, so a selection is not reported back as
         * the user asking for one. */
        this.signature = null;
        this.key       = null;
        this.muted     = false;
    }

    get tree() { return this.designer.ide.WidgetTree; }

    /* The name the .form knows a control by, stand-ins included: a component is
     * shown as what it will be, not as the Label standing in for it. */
    typeOf(control) {
        if (control.__node) return control.__node.type;
        return control.constructor.__type || control.constructor.name;
    }

    /* What a control is shown with, which is the palette's icon for its type --
     * a stand-in gets the component icon, since what it stands for has none of
     * its own. A name the desktop turns out not to have comes back empty and
     * the tree simply shows no icon. */
    iconFor(control) {
        const names = control.__node ? COMPONENT_ICON
                                     : (PALETTE_ICON[this.typeOf(control)] || []);
        return names.find((name) => Application.HasIcon(name)) || "";
    }

    /*
     * Rebuilt only when the shape of the form really changed, so editing a
     * property does not throw the tree away and take the selection with it.
     * The signature covers what the tree shows: nesting, order, names, types.
     */
    shape() {
        const parts = [];
        const walk = (container, depth) => {
            for (const c of container.Children) {
                parts.push(`${depth}:${c.Name}:${this.typeOf(c)}`);
                /* Not into a list showing its design-time item: what is in it is a
                 * drawing of a component, not a control of this form. */
                if ("Children" in c && !c.Item && !c.__node) walk(c, depth + 1);
            }
        };
        walk(this.designer.surface, 0);
        return parts.join("|");
    }

    refresh() {
        const tree = this.tree;
        if (!tree) return;

        const signature = this.shape();
        if (signature === this.signature) return;
        this.signature = signature;

        /* Clearing and refilling makes the TreeView report selections of its
         * own along the way; none of them is the user asking for anything. */
        this.muted = true;
        tree.Clear();
        tree.Add(TREE_ROOT, this.formLabel(), "", paletteIcon("Form"));

        const walk = (container, parentKey) => {
            for (const c of container.Children) {
                tree.Add(c.Name, `${c.Name} (${this.typeOf(c)})`, parentKey,
                         this.iconFor(c));
                if ("Children" in c && !c.Item && !c.__node) walk(c, c.Name);
            }
        };
        walk(this.designer.surface, TREE_ROOT);
        this.muted = false;

        this.key = null;            // the tree was emptied; nothing is on it now
        this.sync();
    }

    /* The root stands for the form itself, which is what an empty selection
     * edits -- so clicking it is how the form's own properties are reached. */
    formLabel() {
        const d    = this.designer;
        const name = (d.root && d.root.class) ||
                     File.BaseName(d.path || "") || "Form";
        return `${name} (Form)`;
    }

    /* Canvas -> tree.  Never the other way: that is `selectFromKey`. */
    sync() {
        const tree = this.tree;
        if (!tree) return;

        const want = this.designer.selected ? this.designer.selected.Name : TREE_ROOT;
        if (want === this.key || !tree.Exists(want)) return;

        this.muted = true;
        tree.Key   = want;
        this.key   = want;
        this.muted = false;
    }

    /* Tree -> canvas. */
    selectFromKey(key) {
        if (this.muted || !key) return;
        this.key = key;

        if (key === TREE_ROOT) {
            this.designer.select(null);      // the form itself
            return;
        }
        const found = this.designer.allControls().find((c) => c.Name === key);
        if (found) this.designer.select(found);
    }

    /*
     * Double clicking a node renames what it stands for.
     *
     * On the canvas a double click writes the control's handler and jumps to
     * it, which is the right thing where one is *looking* at the form.  The
     * tree is the other question -- what things are called and what holds what
     * -- and renaming from here goes through exactly the path the grid's Name
     * row does: the identifier is checked, the handlers in the .js follow, and
     * the history is cleared because undo cannot take the code back.
     */
    renameFromKey(key) {
        if (!key || key === TREE_ROOT) return;  // the form is renamed from the project tree

        const found = this.designer.allControls().find((c) => c.Name === key);
        if (!found) return;

        this.designer.select(found);
        /* Kept so the IDE (and its driver) can reach the dialog while it is
         * open; the runtime holds the window itself. */
        this.designer.ide.renameControlAsk =
            AskForm.prompt("Rename control", "Name:", found.Name,
                           (name) => this.designer.renameControl(name.trim()));
    }
};
