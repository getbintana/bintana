/*
 * The command editor.
 *
 * A form's `actions` are what its buttons and menu items point at with
 * `Action` -- one label, one icon, one shortcut and one enabled state for every
 * place the command appears. They are not widgets either, so like the menus
 * (`MenuForm`) what is edited is the spec: the same `actions` array the .form
 * carries. Before this there was no way to make one from the IDE, and the
 * property grid's `Action` drop-down could only offer what somebody had typed
 * into the file by hand.
 *
 * It works on a copy and hands it back on OK, with the renames: a command's
 * name is what controls point at and the prefix of its handler, so renaming
 * one is carried to both by the designer, which is the one that can.
 */
"use strict";

/* A command's name is a property of the form and the prefix of its handler. */
const ACTION_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

class ActionForm extends Form {

    /*
     * ActionForm.edit(actions, { uses, taken }, (spec, renames) => ...,
     *                 (name) => ...)
     *
     * `uses` maps a command's name to what points at it, so one in use is not
     * deleted out from under a control; `taken` is every other name on the form,
     * since a command is published on it beside the controls.
     */
    static edit(actions, context, onAccept, onOpenHandler) {
        const dlg = new ActionForm();

        /* A copy: Cancel has to leave the form exactly as it was. */
        dlg.actions       = JSON.parse(JSON.stringify(actions || []));
        /* What each entry was called when the dialog opened, so OK can say what
         * was renamed -- `null` for one added here. Kept beside the list and
         * moved with it. */
        dlg.from          = dlg.actions.map((a) => a.name || null);
        dlg.uses          = (context && context.uses)  || {};
        dlg.taken         = (context && context.taken) || [];
        dlg.onAccept      = onAccept;
        dlg.onOpenHandler = onOpenHandler;
        dlg.Modal         = true;

        dlg.Show();
        dlg.fillList();
        return dlg;
    }

    Form_Open() {
        this.muted = false;
        /* The literal at the call, so the extractor finds it and the
         * catalogue translates it: a constant would be neither. */
        this.LblHint.Text = Locale.Text("A command is what a button's and a menu item's Action point at: they take its text and its icon when they declare none, and they are enabled and disabled together (this.Name.Enabled = false).\n\nIts handler is Name_Execute. Double click a command to write it.");
    }

    labelOf(act) {
        const name = act.name || "(no name)";
        return act.text ? `${name} — ${act.text}` : name;
    }

    /* The selection, by index. A key is the index as text: the list is rebuilt
     * after every change that moves an entry, so it is the identity too. */
    get index() {
        const key = this.List.Key;
        return key === null || key === undefined || key === "" ? -1 : Number(key);
    }

    current() {
        return this.actions[this.index] || null;
    }

    fillList(select) {
        this.muted = true;
        this.List.Clear();
        this.actions.forEach((act, i) => this.List.Add(`${i}`, this.labelOf(act)));
        this.muted = false;

        if (select !== undefined && this.List.Exists(`${select}`)) this.List.Key = `${select}`;
        else this.showAction();
    }

    showAction() {
        const act = this.current();
        const has = !!act;

        this.muted = true;
        for (const field of [this.TxtName, this.TxtText, this.TxtIcon,
                             this.TxtShortcut, this.ChkEnabled]) {
            field.Enabled = has;
        }
        this.TxtName.Text      = has ? (act.name || "") : "";
        this.TxtText.Text      = has ? (act.text || "") : "";
        this.TxtIcon.Text      = has ? (act.icon || "") : "";
        this.TxtShortcut.Text  = has ? this.shortcutText(act) : "";
        this.ChkEnabled.Active = !has || act.enabled !== false;
        this.muted = false;

        this.BtnDelete.Enabled = has;
        this.BtnUp.Enabled     = has && this.index > 0;
        this.BtnDown.Enabled   = has && this.index < this.actions.length - 1;
    }

    /* `shortcut` is one accelerator or a list of them, as in a menu item. */
    shortcutText(act) {
        if (Array.isArray(act.shortcut)) return act.shortcut.join(", ");
        return act.shortcut || "";
    }

    List_Select() {
        if (this.muted) return;
        this.showAction();
    }

    /* The RAD gesture: double click and you are writing what it does. The edit
     * is applied first, since a handler for a command a Cancel would take away
     * again is a trap. */
    List_Activate() {
        const act = this.current();
        if (!act || !act.name) return;

        const name = act.name;
        if (!this.accept()) return;
        if (this.onOpenHandler) this.onOpenHandler(name);
    }

    /* --- editing ----------------------------------------------------------- */

    /* Every name a new command must not take: the form's others, and the
     * commands' own. */
    allNames() {
        return this.taken.concat(this.actions.map((a) => a.name).filter(Boolean));
    }

    freshName() {
        const taken = this.allNames();
        let n = 1;
        while (taken.includes(`Act${n}`)) n++;
        return `Act${n}`;
    }

    BtnAdd_Click() {
        const at = this.index < 0 ? this.actions.length : this.index + 1;
        this.actions.splice(at, 0, { name: this.freshName(), text: "Command" });
        this.from.splice(at, 0, null);
        this.fillList(at);
        this.TxtName.SetFocus();
    }

    /* A command something points at stays: deleting it would leave a control
     * the loader refuses, which is the form not opening at all. */
    BtnDelete_Click() {
        const i   = this.index;
        const act = this.current();
        if (!act) return;

        const users = this.usersOf(i);
        if (users.length) {
            Message.Error("{0} is used by {1}. Point them at another command first.",
                          act.name, users.join(", "));
            return;
        }
        this.actions.splice(i, 1);
        this.from.splice(i, 1);
        this.fillList(Math.min(i, this.actions.length - 1));
    }

    /* What points at the entry at `i`, by the name it had when the dialog
     * opened: that is the name the controls still carry. */
    usersOf(i) {
        const was = this.from[i];
        return (was && this.uses[was]) || [];
    }

    move(by) {
        const i  = this.index;
        const to = i + by;
        if (i < 0 || to < 0 || to >= this.actions.length) return;

        [this.actions[i], this.actions[to]] = [this.actions[to], this.actions[i]];
        [this.from[i],    this.from[to]]    = [this.from[to],    this.from[i]];
        this.fillList(to);
    }

    BtnUp_Click()   { this.move(-1); }
    BtnDown_Click() { this.move(1); }

    /*
     * The fields apply as they are typed, and the list's line follows. Enter is
     * not waited for -- a dialog that loses what was typed because OK was
     * clicked instead is worse than one that validates on OK, which is where a
     * name is checked.
     */
    edited(apply) {
        if (this.muted) return;
        const act = this.current();
        if (!act) return;

        apply(act);
        this.List.SetText(`${this.index}`, this.labelOf(act));
    }

    TxtName_Change() {
        this.edited((act) => { act.name = this.TxtName.Text.trim(); });
    }

    TxtText_Change() {
        this.edited((act) => {
            if (this.TxtText.Text) act.text = this.TxtText.Text;
            else                   delete act.text;
        });
    }

    TxtIcon_Change() {
        this.edited((act) => {
            const icon = this.TxtIcon.Text.trim();
            if (icon) act.icon = icon;
            else      delete act.icon;
        });
    }

    /* The picker the property grid's Icon row opens. */
    TxtIcon_IconClick() {
        if (!this.current()) return;
        this.iconPicker = IconForm.pick(this.TxtIcon.Text.trim(), (name) => {
            this.TxtIcon.Text = name;
        });
    }

    TxtShortcut_Change() {
        this.edited((act) => {
            /* One accelerator stays a string; several become a list. */
            const parts = this.TxtShortcut.Text.split(",")
                              .map((s) => s.trim()).filter(Boolean);

            if (parts.length === 0)      delete act.shortcut;
            else if (parts.length === 1) act.shortcut = parts[0];
            else                         act.shortcut = parts;
        });
    }

    /* Declared disabled is a real state -- a command that needs a selection has
     * none when the window opens -- and enabled is the default, so only the
     * first is written. */
    ChkEnabled_Click() {
        this.edited((act) => {
            if (this.ChkEnabled.Active) delete act.enabled;
            else                        act.enabled = false;
        });
    }

    /* --- accepting ---------------------------------------------------------- */

    /* What the loader would refuse, refused here instead. */
    problems() {
        const bad  = [];
        const seen = [];

        for (const act of this.actions) {
            const name = act.name || "";

            if (!name) {
                bad.push(Locale.Text("A command has no name."));
                continue;
            }
            if (!ACTION_IDENT.test(name)) {
                bad.push(Locale.Text("\"{0}\" is not usable as a command name.", name));
            } else if (seen.includes(name)) {
                bad.push(Locale.Text("{0} is used by more than one command.", name));
            } else if (this.taken.includes(name)) {
                bad.push(Locale.Text("{0} is already the name of something else on the form.", name));
            }
            seen.push(name);
        }
        return bad;
    }

    /* `[old, new]` for every command that had a name and has another now. */
    renames() {
        const out = [];
        this.actions.forEach((act, i) => {
            if (this.from[i] && this.from[i] !== act.name) out.push([this.from[i], act.name]);
        });
        return out;
    }

    accept() {
        const bad = this.problems();
        if (bad.length) {
            Message.Error(bad.join("\n"));
            return false;
        }

        this.dismiss();
        if (this.onAccept) this.onAccept(this.actions, this.renames());
        return true;
    }

    dismiss() { this.Close(); }

    BtnOk_Click()     { this.accept(); }
    BtnCancel_Click() { this.dismiss(); }
}
