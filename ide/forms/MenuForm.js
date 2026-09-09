/*
 * The menu editor.
 *
 * Menus are not widgets -- a GTK4 menu is a model wired to actions -- so there is
 * nothing on the surface to drag into place, and what the designer edits is the
 * spec itself: the same `menus` array the .form carries and the loader reads.
 *
 * The board does *show* the bar (Ide.MenuBar), which is a different question: a
 * preview is ordinary widgets and a real popover, and it is where most people
 * will click to get here.  What it cannot be is the editor -- reordering and
 * renaming a tree is what this dialog is for.
 *
 * Like every other dialog here, this is a Bintana form and not a runtime
 * primitive.  It works on a copy and hands it back on OK, so Cancel costs
 * nothing and the designer's undo has exactly one edit to record.
 */
"use strict";

/* An item's name is the prefix of its handler, so it has to be an identifier. */
const MENU_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/* What a separator looks like in the tree: it has no text of its own. */
const MENU_RULE = "—————";

const MENU_HELP =
    "A submenu holds other items.  An item with no submenu needs a name: that " +
    "is what its Name_Click handler is called after.\n\n" +
    "A check item ticks on and off and its handler is given the new state; a " +
    "dynamic one is filled by the application (Name.Items = [...]), and marking " +
    "it radio keeps the entry that was chosen.\n\n" +
    "Double click an item to write its handler.";

/* Open dialogs, so the collector does not take one away mid-edit. */
const openMenuEditors = [];

class MenuForm extends Form {

    /* MenuForm.edit(menus, (spec) => ..., (name) => ...) */
    static edit(menus, onAccept, onOpenHandler) {
        const dlg = new MenuForm();

        /* A copy: Cancel has to leave the form exactly as it was. */
        dlg.menus           = JSON.parse(JSON.stringify(menus || []));
        dlg.onAccept        = onAccept;
        dlg.onOpenHandler   = onOpenHandler;
        dlg.Modal           = true;

        openMenuEditors.push(dlg);
        dlg.Show();
        dlg.fillTree();
        return dlg;
    }

    Form_Open() {
        this.muted = false;
        this.LblHint.Text = MENU_HELP;
    }

    /* --- the spec, addressed by path ---------------------------------------
     *
     * A tree key is the path of indices to the node: "2" is the third menu,
     * "2/0/1" the second child of the first child of it.  Keys have to be
     * unique and the tree is rebuilt after every change, so a path is both the
     * address and the identity.
     */

    /* The array that holds the node at `path`, and its index in it. */
    listFor(path) {
        const parts = String(path).split("/").map(Number);
        let   list  = this.menus;

        for (let i = 0; i < parts.length - 1; i++) {
            const node = list[parts[i]];
            if (!node) return { list: [], index: -1 };
            node.children = node.children || [];
            list = node.children;
        }
        return { list, index: parts[parts.length - 1] };
    }

    nodeAt(path) {
        if (!path) return null;
        const { list, index } = this.listFor(path);
        return list[index] || null;
    }

    labelOf(node) {
        if (node.separator) return MENU_RULE;
        return node.text || node.name || "(no text)";
    }

    /* Every name in use, so a new item can be given one that is not. */
    allNames(list = this.menus, out = []) {
        for (const node of list) {
            if (node.name) out.push(node.name);
            if (Array.isArray(node.children)) this.allNames(node.children, out);
        }
        return out;
    }

    freshName() {
        const taken = this.allNames();
        let n = 1;
        while (taken.includes(`Mnu${n}`)) n++;
        return `Mnu${n}`;
    }

    /* --- the tree ---------------------------------------------------------- */

    fillTree(select) {
        this.muted = true;
        this.Tree.Clear();

        const walk = (list, prefix) => {
            list.forEach((node, i) => {
                const key = prefix === "" ? `${i}` : `${prefix}/${i}`;
                this.Tree.Add(key, this.labelOf(node), prefix === "" ? undefined : prefix);
                if (Array.isArray(node.children)) walk(node.children, key);
            });
        };
        walk(this.menus, "");
        this.muted = false;

        if (select && this.Tree.Exists(select)) this.Tree.Key = select;
        else this.showNode(null);
    }

    /* The fields describe the selection; a separator has nothing to describe. */
    showNode(path) {
        const node = this.nodeAt(path);
        const editable = !!node && !node.separator;
        const submenu  = !!node && Array.isArray(node.children);

        this.selectedPath = node ? path : null;

        const dynamic = !!(node && node.dynamic);
        const plain   = editable && !submenu;

        this.TxtText.Enabled     = editable;
        this.TxtName.Enabled     = plain;
        /* An accelerator can only name a command that takes no argument, so the
         * kinds that are many commands cannot have one. */
        this.TxtShortcut.Enabled = plain && !dynamic;
        /* A submenu's entries are its children, so it cannot also fill its own. */
        this.ChkDynamic.Enabled  = plain;
        /*
         * A tick is a state on one item; a dynamic item's state is *which* of its
         * entries was chosen, which is what radio marks.  So the two exclude each
         * other, and radio says nothing without dynamic -- the same rules the
         * loader enforces, offered here as fields that go grey instead of as an
         * error on OK.
         */
        this.ChkCheck.Enabled = plain && !dynamic;
        this.ChkRadio.Enabled = plain && dynamic;

        this.TxtText.Text     = node && !node.separator ? (node.text || "") : "";
        this.TxtName.Text     = node && !submenu ? (node.name || "") : "";
        this.TxtShortcut.Text = node && !submenu ? this.shortcutText(node) : "";
        this.ChkDynamic.Active = dynamic;
        this.ChkCheck.Active   = !!(node && node.check);
        this.ChkRadio.Active   = !!(node && node.radio);

        const has = !!node;
        this.BtnDelete.Enabled = has;
        this.BtnUp.Enabled     = has;
        this.BtnDown.Enabled   = has;
    }

    /* `shortcut` is one accelerator or a list of them; the field shows a list
     * comma separated, which is also how it is read back. */
    shortcutText(node) {
        if (Array.isArray(node.shortcut)) return node.shortcut.join(", ");
        return node.shortcut || "";
    }

    Tree_Select() {
        if (this.muted) return;
        this.showNode(this.Tree.Key);
    }

    /* The RAD gesture, the same one the canvas has: double click and you are
     * writing what it does.  The edit is applied first -- writing a handler for
     * an item that a Cancel would take away again is a trap. */
    Tree_Activate() {
        const node = this.nodeAt(this.Tree.Key);
        if (!node || node.separator || Array.isArray(node.children)) return;
        if (!node.name) return;

        const name = node.name;
        if (!this.accept()) return;
        if (this.onOpenHandler) this.onOpenHandler(name);
    }

    /* --- editing ----------------------------------------------------------- */

    /*
     * Where a new node goes: inside the selected submenu, because that is what
     * selecting a submenu and pressing Item means; next to the selected item
     * otherwise; at the end of the bar with nothing selected.
     */
    insert(node) {
        const path = this.selectedPath;
        let   list = this.menus, index = this.menus.length, key = `${index}`;

        if (path) {
            const at     = this.listFor(path);
            const target = at.list[at.index];

            if (target && Array.isArray(target.children)) {
                list  = target.children;
                index = list.length;
                key   = `${path}/${index}`;
            } else {
                list  = at.list;
                index = at.index + 1;

                const parts = String(path).split("/");
                parts[parts.length - 1] = String(index);
                key = parts.join("/");
            }
        }

        list.splice(index, 0, node);
        this.fillTree(key);
    }

    BtnItem_Click() {
        this.insert({ name: this.freshName(), text: "Item" });
    }

    BtnSubmenu_Click() {
        this.insert({ text: "Submenu", children: [] });
    }

    BtnSeparator_Click() {
        this.insert({ separator: true });
    }

    BtnDelete_Click() {
        if (!this.selectedPath) return;
        const { list, index } = this.listFor(this.selectedPath);
        list.splice(index, 1);
        this.fillTree();
    }

    move(by) {
        if (!this.selectedPath) return;

        const { list, index } = this.listFor(this.selectedPath);
        const to = index + by;
        if (to < 0 || to >= list.length) return;

        [list[index], list[to]] = [list[to], list[index]];

        const parts = String(this.selectedPath).split("/");
        parts[parts.length - 1] = String(to);
        this.fillTree(parts.join("/"));
    }

    BtnUp_Click()   { this.move(-1); }
    BtnDown_Click() { this.move(1); }

    /* The fields apply on Enter, like the designer's property grid: applying on
     * every keystroke would rename an item once per letter. */
    TxtText_Activate() {
        const node = this.nodeAt(this.selectedPath);
        if (!node) return;
        node.text = this.TxtText.Text;
        this.fillTree(this.selectedPath);
    }

    TxtName_Activate() {
        const node = this.nodeAt(this.selectedPath);
        if (!node) return;

        const name = this.TxtName.Text.trim();
        if (name && !MENU_IDENT.test(name)) {
            Message.Error("\"{0}\" is not usable as a menu item name.", name);
            this.TxtName.Text = node.name || "";
            return;
        }
        if (name && this.allNames().filter((n) => n === name).length &&
            name !== node.name) {
            Message.Error("{0} is already used by another item.", name);
            this.TxtName.Text = node.name || "";
            return;
        }

        if (name) node.name = name;
        else      delete node.name;
        this.fillTree(this.selectedPath);
    }

    TxtShortcut_Activate() {
        const node = this.nodeAt(this.selectedPath);
        if (!node) return;

        /* One accelerator stays a string; several become a list, which is what
         * the format takes and what a desktop that steals a key needs. */
        const parts = this.TxtShortcut.Text.split(",")
                          .map((s) => s.trim()).filter(Boolean);

        if (parts.length === 0)      delete node.shortcut;
        else if (parts.length === 1) node.shortcut = parts[0];
        else                         node.shortcut = parts;
    }

    /*
     * The three boxes that say what kind of item it is.
     *
     * Each one leaves first, before deciding: an edit that changes nothing is not
     * an edit, and `showNode` fills these fields by assigning `Value` -- which
     * raises Click exactly as a person would.  Checking against what the node
     * already says is what tells the two apart, and it does not depend on when
     * the signal arrives.
     */
    ChkDynamic_Click() {
        const node = this.nodeAt(this.selectedPath);
        if (!node || !!node.dynamic === this.ChkDynamic.Active) return;

        if (this.ChkDynamic.Active) {
            node.dynamic = true;
            delete node.check;      /* its state is which entry, not on or off */
        } else {
            delete node.dynamic;
            delete node.radio;      /* and with no entries there is none to mark */
        }
        this.showNode(this.selectedPath);
    }

    ChkCheck_Click() {
        const node = this.nodeAt(this.selectedPath);
        if (!node || !!node.check === this.ChkCheck.Active) return;

        if (this.ChkCheck.Active) {
            node.check = true;
            delete node.dynamic;
            delete node.radio;
        } else {
            delete node.check;
        }
        this.showNode(this.selectedPath);
    }

    ChkRadio_Click() {
        const node = this.nodeAt(this.selectedPath);
        if (!node || !!node.radio === this.ChkRadio.Active) return;

        if (this.ChkRadio.Active) {
            /* Radio is what a dynamic item's mark is called, so asking for one
             * asks for the other: the loader refuses radio on its own. */
            node.radio   = true;
            node.dynamic = true;
            delete node.check;
        } else {
            delete node.radio;
        }
        this.showNode(this.selectedPath);
    }

    /* --- accepting ---------------------------------------------------------- */

    /*
     * What the loader would refuse, refused here instead: an item that is
     * neither a submenu nor named has no action to raise, and a name used twice
     * would make two items dispatch to one handler.
     */
    problems() {
        const seen = [];
        const bad  = [];

        const walk = (list) => {
            for (const node of list) {
                if (node.separator) continue;

                const submenu = Array.isArray(node.children);

                if (!node.text) bad.push("An item has no text.");
                if (!submenu && !node.name) {
                    bad.push(`"${node.text}" needs a name, or a submenu of its own.`);
                }
                if (node.name) {
                    if (!MENU_IDENT.test(node.name)) {
                        bad.push(`"${node.name}" is not usable as a name.`);
                    } else if (seen.includes(node.name)) {
                        bad.push(`${node.name} is used by more than one item.`);
                    }
                    seen.push(node.name);
                }
                if (submenu) walk(node.children);
            }
        };
        walk(this.menus);
        return bad;
    }

    accept() {
        const bad = this.problems();
        if (bad.length) {
            Message.Error(bad.join("\n"));
            return false;
        }

        this.dismiss();
        if (this.onAccept) this.onAccept(this.menus);
        return true;
    }

    dismiss() {
        const i = openMenuEditors.indexOf(this);
        if (i >= 0) openMenuEditors.splice(i, 1);
        this.Close();
    }

    BtnOk_Click()     { this.accept(); }
    BtnCancel_Click() { this.dismiss(); }

}
