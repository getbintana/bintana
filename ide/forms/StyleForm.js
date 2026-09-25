/*
 * The class chooser.
 *
 * `Style` is a *list* of CSS classes, and the row that edits it offered them as
 * a popup menu: one name per line and nothing else, no way to see what was
 * already on, and a combination built one popup at a time. This is the same
 * bargain the icon chooser makes -- a list of names is widgets.
 *
 * **It is not a closed list, and must not read as one.** The field behind it
 * stays free text, because which classes exist is the theme's answer, the
 * project's, and that of whatever theme the person has installed. This offers
 * the ones we know of, with the ones already on the control among them.
 *
 * The search narrows without rebuilding a row, which is not a nicety here: the
 * rows are checkboxes, and a filter that rebuilt them would throw away every
 * tick the moment somebody typed. That is what `RowList.Filter` is for.
 */
"use strict";

/* The CSS nodes a control here can be, worked out once per run of the IDE: it is
 * a fact about the runtime, and the runtime does not change while it runs. */
let nodeCache = null;

class StyleForm extends Form {

    /*
     * StyleForm.pick("card title-3", offered, (value) => ...)
     *
     * The callback gets the whole value, space separated, or `""` for none.
     * Cancelling calls nothing at all, which is the difference between "no
     * class" and "never mind".
     */
    static pick(current, offer, about, onChoose) {
        const dlg = new StyleForm();
        const who = (about && about.type) || "";

        dlg.about    = about || {};
        dlg.offer    = offer || [];
        dlg.onChoose = onChoose;
        dlg.Modal    = true;
        dlg.Text     = who ? Locale.Text("Classes for a {0}", who)
                           : Locale.Text("Choose classes");
        dlg.fill(String(current || "").split(/\s+/).filter(Boolean),
                 offer || [], (about && about.node) || "", who,
                 !!(about && about.container));

        dlg.Show();
        dlg.TxtFind.SetFocus();
        return dlg;
    }

    /*
     * **The list is ordered by what can actually reach this control.**
     *
     * A class is applied to one CSS node -- a `Button` is a `button`, a
     * `ColorButton` a `colorbutton`, a `RowList` the `scrolledwindow` around its
     * list -- and the theme writes most of its rules for a particular node:
     * `button.suggested-action` reaches the first and neither of the others. One
     * that does not match is accepted, saved into the `.form` and does nothing.
     *
     * So the ones that fit come first, under the node's own name, and the rest
     * follow under a heading of their own, dimmed, each saying why. **Nothing is
     * hidden and nothing is refused**: the field behind this dialog is free text,
     * because which classes exist is the theme's answer and not ours. What is on
     * the control is first of all and stays in the list even when no stylesheet
     * here has heard of it.
     */
    fill(have, offer, node, who, container) {
        const known = [...have, ...offer.filter((c) => c && !have.includes(c))];
        const owners = StyleForm.owners();
        const nodes  = Dictionary.Keys(owners);

        const fits = (name) =>
            Ide.Styles.fits(Ide.Styles.find(name), node, nodes, container);

        this.classes = [...known.filter(fits), ...known.filter((n) => !fits(n))];
        this.boxes   = [];
        this.rows    = [];      /* what each row of the list is: see List_Filter */

        this.List.Clear();

        let heading = "";
        this.classes.forEach((name) => {
            const ok   = fits(name);
            const want = ok ? (who ? Locale.Text("For a {0}", who)
                                   : Locale.Text("Classes"))
                            : Locale.Text("For other controls, or for what is inside this one");

            if (want !== heading) {
                heading = want;
                this.addHeading(want);
            }

            const box = new CheckButton();

            box.Text   = name;
            box.Active = have.includes(name);
            box.Margin = 4;
            if (!ok) {
                box.Style   = "dim-label";
                box.Tooltip = Ide.Styles.why(Ide.Styles.find(name), owners);
            }

            this.rows.push([name]);
            this.List.Add(box);
            this.boxes.push(box);

            /* The handler belongs to the box, so emptying the list takes it
             * with them -- and no name is invented to dispatch by. */
            box.On("Click", () => this.showChosen());
        });

        this.showChosen();
    }

    /* A heading is a row like any other -- the list is a list -- wearing the
     * theme's own small-and-bold class, as the property grid's do. It carries
     * what is under it, so the search can hide it with them. */
    addHeading(text) {
        const head = new Label();

        head.Text   = text;
        head.Style  = "caption-heading";
        head.Margin = 4;

        this.rows.push(null);          /* null: a heading, not a class */
        this.List.Add(head);
    }

    /*
     * Which controls are which CSS node, worked out once.
     *
     * Two answers in one walk: the nodes a control here can *be* -- which is what
     * decides whether a class that styles `> children` has any to style -- and,
     * for each of them, the controls a person would recognise. `button` is a
     * `Button`, a `ToggleButton` and a `LinkButton`; that is what a row saying
     * *"the theme writes this one for…"* has to name, rather than the node.
     *
     * Asked of the runtime rather than listed, so a widget added in C is covered
     * without touching this file.
     */
    static owners() {
        if (nodeCache) return nodeCache;

        nodeCache = {};
        for (const type of Widget.Types()) {
            let w = null;
            try { w = Widget.New(type); } catch (e) { continue; }   /* abstract */

            const node = w.CssNode();
            if (node) (nodeCache[node] = nodeCache[node] || []).push(type);

            if (w instanceof Form) w.Close();
            else                   w.Delete();
        }
        return nodeCache;
    }

    chosen() {
        return this.classes.filter((name, i) => this.boxes[i].Active);
    }

    /* The value as it will be written, shown while it is being built: `Style` is
     * a list, and a list one cannot see is a list one gets wrong. */
    showChosen() {
        const on = this.chosen();
        this.LblChosen.Text = on.length ? on.join(" ") : Locale.Text("No class");
    }

    /*
     * Asked by GTK, once per row, whenever the search says the answer may have
     * changed. A lookup and nothing else -- it runs while the list is being laid
     * out.
     */
    List_Filter(control, index) {
        const want = this.TxtFind.Text.trim().toLowerCase();
        if (!want) return true;

        /* A heading carries the rows under it, so it goes when they do. */
        const keys = this.rows[index] || this.under(index);
        return keys.some((k) => String(k).toLowerCase().includes(want));
    }

    /* The classes below a heading, up to the next one. */
    under(index) {
        const out = [];
        for (let i = index + 1; i < this.rows.length && this.rows[i]; i++) {
            out.push(...this.rows[i]);
        }
        return out;
    }

    /*
     * **A class of the project's is made here, not in a text editor.**
     *
     * The chooser is where one notices that the class one wants does not exist
     * yet, so this is where making it belongs -- and it lands in
     * `<project>/app.css`, because a class is a thing to *share*: one name, every
     * control that wears it, changed in one place. `ClassForm` does the writing;
     * what comes back is ticked, since somebody who just made a class means to
     * use it.
     */
    BtnNew_Click() {
        this.editClass("");
    }

    /* And editing the one the list is on. A theme's class is not ours to rewrite
     * -- it belongs to the desktop -- so this offers only the project's. */
    BtnEdit_Click() {
        const at   = this.List.Index;
        const name = at >= 0 && this.rows[at] ? this.rows[at][0] : "";

        if (!name || Ide.Styles.find(name)) {
            Message.Info("Pick one of the project's own classes to edit. The theme's belong to the desktop.");
            return;
        }
        this.editClass(name);
    }

    editClass(name) {
        const project = this.project || (this.about && this.about.project);
        if (!project) return;

        const editor = ClassForm.edit(project, name, (saved) => {
            /* Read the sheet again rather than guessing what changed: the file is
             * the answer, and somebody may have edited it in the tab next door. */
            const have = [...this.chosen(), saved];

            this.offer = this.offer.includes(saved) ? this.offer
                                                    : [...this.offer, saved];
            this.fill(have, this.offer, this.about.node || "",
                      this.about.type || "", !!this.about.container);
        });

        /* Kept so the IDE (and its driver) can reach the editor while it is
         * open -- the runtime holds the window itself. */
        if (this.about.ide) this.about.ide.classEditor = editor;
    }

    TxtFind_Change()    { this.List.Refilter(); }
    TxtFind_IconClick() { this.TxtFind.Text = ""; this.List.Refilter(); }

    BtnOk_Click() {
        const answer = this.onChoose;
        const value  = this.chosen().join(" ");

        this.dismiss();
        if (answer) answer(value);
    }

    BtnCancel_Click() { this.dismiss(); }

    dismiss() { this.Close(); }
}
