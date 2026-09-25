/*
 * The class editor: colours, a border, a font and the rest, written into
 * `<project>/app.css` under a name.
 *
 * **This is where an application's look belongs.** `Background` and its family on
 * a control are the exception the runtime keeps for a colour worked out while the
 * program runs; the rule is a class, because a class is shared -- one name, every
 * control that wears it, changed in one place. Until now making one meant writing
 * CSS by hand, so the property grid's six appearance rows were the path of least
 * resistance and every form ended up with colours scattered through it.
 *
 * **The IDE writes no CSS.** The values go on a control nobody sees and
 * `Widget.StyleRule()` says what that comes to: the units, the colours
 * normalised, and the three ways a font size reaches a stylesheet wrong are
 * written in C and read from there. What this file adds is a name and two braces.
 *
 * And a class it cannot reproduce is not its to edit: `Ide.Sheet.owned` reads the
 * rule back and regenerates it, and anything that does not come out the same --
 * a gradient, a transition, a selector of somebody's own -- is left alone and
 * edited as the text it is.
 */
"use strict";

/* The file every project keeps its classes in, found by name exactly as the
 * runtime finds it. */
const SHEET = "app.css";

const SHEET_HEADER =
    "/*\n" +
    " * <project>/app.css -- what this application looks like.\n" +
    " *\n" +
    " * A control wears a class from here by setting Style. The runtime finds this\n" +
    " * file by name: nothing in project.json points at it.\n" +
    " */\n";

class ClassForm extends Form {

    /*
     * ClassForm.edit(project, "danger", (name) => ...)
     *
     * `name` empty is a new class. The callback gets the name that was saved, so
     * whoever opened this can put it on the control; cancelling calls nothing.
     *
     * Answers `null` -- having said why -- when the class is one the editor does
     * not own, which is the honest end of the road rather than a dialog that
     * would quietly rewrite somebody's rule into less than it was.
     */
    static edit(project, name, onSaved) {
        const path  = File.Join(project, SHEET);
        const text  = File.Exists(path) ? File.Load(path) : "";
        const props = name ? Ide.Sheet.owned(text, name) : {};

        if (name && !props) {
            Message.Info(
                "{0} says more than this can edit — a gradient, a transition or a selector of its own. Open {1} and edit it there.", name, SHEET);
            return null;
        }

        const dlg = new ClassForm();

        dlg.project = project;
        dlg.path    = path;
        dlg.onSaved = onSaved;
        dlg.Modal   = true;
        dlg.Text    = name ? Locale.Text("Class {0}", name)
                           : Locale.Text("New class");

        dlg.TxtName.Text = name || "";
        dlg.ready = true;
        dlg.load(props || {});

        dlg.Show();
        (name ? dlg.ColBack : dlg.TxtName).SetFocus();
        return dlg;
    }

    /* Which control edits which property: one list, read three ways -- filling
     * the fields, reading them back, and showing the sample. */
    fields() {
        return [["Background", this.ColBack,    "Value"],
                ["Foreground", this.ColFore,    "Value"],
                ["Font",       this.TxtFont,    "Text"],
                ["FontScale",  this.SpnScale,   "Value"],
                ["Opacity",    this.SpnOpacity, "Value"],
                ["Border",     this.TxtBorder,  "Text"],
                ["Radius",     this.TxtRadius,  "Text"],
                ["Padding",    this.TxtPadding, "Text"],
                ["Shadow",     this.TxtShadow,  "Text"]];
    }

    /*
     * **The font is typed, not chosen whole.**
     *
     * Read the desktop's own type classes and every one is the same shape:
     * `.title-1` is `font-weight: 800; font-size: 200%`, `.heading` is 700 and
     * 110%, `.caption` is 400 and 90% -- a weight and a **relative** size, and
     * never a family. That is what makes them compose, and what makes them follow
     * whoever runs at a different text scale. A chooser can only hand over a
     * whole font, which is precisely what a class should not freeze.
     *
     * So `Font` takes what Pango takes -- `Bold`, `Italic`, `Cantarell 12`, or
     * all of it -- and the size that a class usually wants is the one below it,
     * as a factor. `Opacity` is there for the same reason: `.dim-label` is not a
     * grey, it is `opacity: 0.55`.
     */
    isBlank(key, value) {
        /* 1 is "nothing said" for both, which is also where their spins start:
         * a control that opens on the end of its own range has a button that
         * does nothing, and one that starts at 0 makes text 5% tall on the
         * first click. */
        if (key === "FontScale" || key === "Opacity") return Number(value) === 1;
        return !String(value || "").trim();
    }

    load(props) {
        for (const [key, editor, what] of this.fields()) {
            if (key === "FontScale" || key === "Opacity") {
                editor[what] = props[key] === undefined ? 1 : Number(props[key]);
            } else {
                editor[what] = props[key] || "";
            }
        }
        this.showSample();
    }

    values() {
        const out = {};

        for (const [key, editor, what] of this.fields()) {
            const v = editor[what];
            if (!this.isBlank(key, v)) out[key] = v;
        }
        return out;
    }

    /*
     * The sample wears what the class will say, which is the whole of the
     * preview: the properties a control takes by hand and the declarations a
     * class makes are the same list, so what is shown is what will be written.
     *
     * It doubles as the validation -- a value the runtime refuses throws here,
     * where there is a line to say so, rather than on the way into somebody's
     * stylesheet.
     */
    showSample() {
        /*
         * **Not while the form is being built.** A `.form` applies each property
         * by assignment and puts a control on the form under its name only after
         * its own properties are set -- so `Decimals` on the first spin fires
         * `Change` while the controls below it do not exist yet, and this walks
         * a list of them. `ready` is set once, by `edit`, when there is a form
         * to read.
         */
        if (!this.ready) return;

        const props = this.values();
        let   said  = "";

        for (const [key] of this.fields()) {
            /* Nothing said is not the empty string for a number: a scale of 0 and
             * an opacity of 1 are what "leave it alone" is. */
            const none = (key === "FontScale" || key === "Opacity") ? 1 : "";

            try {
                this.Sample[key] = props[key] === undefined ? none : props[key];
            } catch (e) {
                said = `${key}: ${e.message}`;
                this.Sample[key] = none;
            }
        }

        this.LblSays.Text  = said;
        this.BtnSave.Enabled = !said;
    }

    ColBack_Change()    { this.showSample(); }
    ColFore_Change()    { this.showSample(); }
    TxtFont_Change()    { this.showSample(); }
    SpnScale_Change()   { this.showSample(); }
    SpnOpacity_Change() { this.showSample(); }
    TxtBorder_Change()  { this.showSample(); }
    TxtRadius_Change()  { this.showSample(); }
    TxtPadding_Change() { this.showSample(); }
    TxtShadow_Change()  { this.showSample(); }

    BtnColBackNone_Click() { this.ColBack.Value = ""; this.showSample(); }
    BtnColForeNone_Click() { this.ColFore.Value = ""; this.showSample(); }

    BtnSave_Click() {
        const name = this.TxtName.Text.trim();

        if (!Ide.Sheet.isName(name)) {
            Message.Error("{0} is not a class name: a letter first, then letters, digits, dashes or underscores.", name || "''");
            return;
        }

        /* Asked of the runtime, not built here: see the header. */
        let body;
        try {
            body = Ide.Sheet.rule(this.values());
        } catch (e) {
            Message.Error("{0}", e.message);
            return;
        }
        if (!body) {
            Message.Info("A class with nothing in it would do nothing.");
            return;
        }

        const had  = File.Exists(this.path) ? File.Load(this.path) : SHEET_HEADER;
        const text = Ide.Sheet.put(had, name, body);

        try {
            File.Save(this.path, text);
        } catch (e) {
            Message.Error("{0}", e.message);
            return;
        }

        const answer = this.onSaved;
        this.dismiss();
        if (answer) answer(name);
    }

    BtnCancel_Click() { this.dismiss(); }

    dismiss() { this.Close(); }
}
