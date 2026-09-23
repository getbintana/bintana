/*
 * The tab order of a container, as a list things move in.
 *
 * `TabIndex` is a number in the property grid and nothing else, which is the one
 * thing about it that is not like the environments this IDE is built after:
 * Visual Basic has *View > Tab Order* and Delphi *Edit > Tab Order...*, and both
 * are a list of the container's controls with Up and Down. A number typed into a
 * grid cannot say *before what*, which is the only question a tab order is.
 *
 * **What it edits is a container's direct children, and not the form's.** A
 * `Panel` is a group Tab descends into, so its children have an order of their
 * own: select the panel and this edits that. With nothing selected it edits the
 * form. The order shown is the runtime's own -- `TabIndex` ascending, ties in the
 * order they were drawn -- which is what `bta_fixed_focus` sorts by when Tab is
 * pressed, so what the list says is what the keyboard does.
 *
 * **A container drawn in coordinates, and nothing else.** `TabIndex` is read by a
 * `Fixed` surface; on a box it is meaningless and ignored, so offering to
 * reorder one would be offering an edit that does nothing. `Placement` is what
 * says which kind a container is -- the same question every drag asks.
 *
 * **One undo step, and nothing written when nothing moved.** The assignments go
 * after a single `pushUndo()`, so Ctrl+Z takes the whole reorder back; and the
 * values are only assigned where they differ, so opening this and pressing OK
 * leaves the `.form` exactly as it was. A dense renumbering on every accept is
 * what the property deliberately does not do -- see the sparse-and-never-
 * renumbered note in docs/widgets.md.
 */
"use strict";

class TabOrderForm extends Form {

    /*
     * TabOrderForm.open(ide)
     *
     * Edits the live controls on the canvas, not a copy: pressing OK assigns
     * their `TabIndex` and marks the form modified, and Cancel has changed
     * nothing at all.
     */
    static open(ide) {
        const target = TabOrderForm.targetOf(ide);

        if (!target) {
            Message.Warning("Only a container drawn in coordinates has a tab order to edit.");
            return null;
        }

        const dlg = new TabOrderForm();

        dlg.ide    = ide;
        dlg.target = target;
        dlg.origin = TabOrderForm.childrenInOrder(target);
        dlg.order  = dlg.origin.slice();

        dlg.fill(0);
        dlg.Show();
        dlg.LstOrder.SetFocus();
        return dlg;
    }

    /*
     * The container being edited: the selected one when it is a container drawn
     * in coordinates, and the form otherwise. `null` when a container was picked
     * that has no tab order to give -- a box, a stack -- because editing the
     * form's order instead would be editing something nobody asked about.
     */
    static targetOf(ide) {
        const picked = ide.designer.selection;
        const one    = picked.length === 1 ? picked[0] : null;

        if (!one || !(one instanceof Container)) return ide.designer.surface;

        return one.Placement === "Coordinates" ? one : null;
    }

    /*
     * The direct children Tab can reach, in the order it reaches them.
     *
     * `Focusable` is the TabStop -- a `Label` is not one and a `Button` is -- and
     * it is asked of the control because GTK is what decides it. A container that
     * cannot take the focus itself still has its children walked into, so it is
     * not listed here either: select it and this edits its own order.
     */
    static childrenInOrder(target) {
        return target.Children
                     .filter((c) => c.Focusable)
                     .map((c, drawn) => ({ c, drawn }))
                     .sort((a, b) => (a.c.TabIndex - b.c.TabIndex) ||
                                     (a.drawn - b.drawn))
                     .map((e) => e.c);
    }

    /* What to call the thing being edited: the form has no name of its own on
     * the canvas, so it is the class the file declares. */
    static titleOf(ide, target) {
        return target === ide.designer.surface
            ? File.BaseName(ide.designer.path || "")
            : target.Name;
    }

    fill(chosen) {
        this.LblWhich.Text = Locale.Text("Tab order of {0}",
                                         TabOrderForm.titleOf(this.ide, this.target));
        this.LstOrder.Items = this.order.map((c) => c.Name);
        this.LstOrder.Index = this.order.length ? chosen : -1;
        this.updateButtons();
    }

    updateButtons() {
        const at = this.LstOrder.Index;
        this.BtnUp.Enabled   = at > 0;
        this.BtnDown.Enabled = at >= 0 && at < this.order.length - 1;
    }

    LstOrder_Select() { this.updateButtons(); }

    BtnUp_Click()   { this.move(-1); }
    BtnDown_Click() { this.move(1); }

    move(delta) {
        const at = this.LstOrder.Index;
        const to = at + delta;

        if (at < 0 || to < 0 || to >= this.order.length) return;

        const held = this.order[at];
        this.order[at] = this.order[to];
        this.order[to] = held;

        this.fill(to);
    }

    BtnOk_Click() {
        this.apply();
        this.Close();
    }

    BtnCancel_Click() { this.Close(); }

    /* Whether the list says something other than what it said when it opened. */
    moved() {
        return this.order.some((c, i) => c !== this.origin[i]);
    }

    apply() {
        if (!this.moved()) return;

        const designer = this.ide.designer;

        designer.pushUndo();
        this.order.forEach((control, at) => {
            if (control.TabIndex !== at) control.TabIndex = at;
        });
        designer.touch();
    }

}
