/*
 * One form, run the way somebody else will see it.
 *
 * The designer draws a form in the IDE's own language, at the IDE's own text
 * size, in the IDE's own theme -- which is the one combination its author never
 * needs to check. What breaks a form drawn by coordinates is somebody else's:
 * a translation a third longer, a desktop set to Large Text, a dark theme that
 * shows a hard-coded colour, a right-to-left language that boxes mirror and a
 * `Fixed` surface does not. The audit called that the most expensive trap of
 * the two layout models (W5), and the cure is to look.
 *
 * **It runs the real form and draws nothing of its own.** The runtime takes
 * the four as options of a run -- `--form`, `--text-scale`, `--theme`, `--rtl`
 * -- and the language is `LANGUAGE`, which is how the desktop says it. A
 * simulation on the canvas would be a second renderer to drift from the first;
 * this is the first one, asked.
 *
 * What was chosen is remembered (`preview.look`), because the question asked
 * after a change is the same one asked before it.
 */
"use strict";

const PREVIEW_KEY = "preview.look";

/* The sizes Large Text and its neighbours give, as the desktop names them.
 * `Locale.Text` here because a list assigned from code is not a declared
 * position the `.form` loader translates. */
const PREVIEW_SCALES = [
    { text: Locale.Text("As the desktop says"), value: 0 },
    { text: "125%",                value: 1.25 },
    { text: "150%",                value: 1.5 },
    { text: "200%",                value: 2 },
];

const PREVIEW_THEMES = [
    { text: Locale.Text("As the desktop says"), value: "" },
    { text: Locale.Text("Light"),  value: "light" },
    { text: Locale.Text("Dark"),   value: "dark" },
];

export class PreviewForm extends Form {

    /*
     * PreviewForm.ask(formName, languages, onAccept)
     *
     * `languages` are the catalogues the project has (`es`, `pt_BR`); the
     * callback is handed the look, `{ language, scale, theme, rtl }`, where an
     * empty language means *as written*.
     */
    static ask(formName, languages, onAccept) {
        const dlg  = new PreviewForm();
        const last = PreviewForm.last();

        dlg.languages = ["", ...languages];
        dlg.onAccept  = onAccept;

        dlg.LblWhat.Text       = formName;
        dlg.CmbLanguage.Items  = [Locale.Text("As written"), ...languages];
        dlg.CmbScale.Items     = PREVIEW_SCALES.map((s) => s.text);
        dlg.CmbTheme.Items     = PREVIEW_THEMES.map((t) => t.text);

        dlg.CmbLanguage.Index = Math.max(0, dlg.languages.indexOf(last.language));
        dlg.CmbScale.Index    = Math.max(0, PREVIEW_SCALES.findIndex((s) => s.value === last.scale));
        dlg.CmbTheme.Index    = Math.max(0, PREVIEW_THEMES.findIndex((t) => t.value === last.theme));
        dlg.ChkRtl.Active     = last.rtl;
        dlg.Modal             = true;

        dlg.Show();
        dlg.BtnPreview.SetFocus();
        return dlg;
    }

    /* What was chosen last time, checked rather than trusted: a settings file
     * is a file a person can edit. */
    static last() {
        const saved = Settings.Get(PREVIEW_KEY, null);
        const ok    = saved && typeof saved === "object" && !Array.isArray(saved);
        return {
            language: ok && typeof saved.language === "string" ? saved.language : "",
            scale:    ok && PREVIEW_SCALES.some((s) => s.value === saved.scale) ? saved.scale : 0,
            theme:    ok && PREVIEW_THEMES.some((t) => t.value === saved.theme) ? saved.theme : "",
            rtl:      ok && saved.rtl === true,
        };
    }

    /*
     * The run a look is: the options before the project, and the environment.
     * Kept here beside the choices so the two cannot disagree, and static so
     * `Runner` and a test can ask it with no dialog up.
     */
    static plan(formName, look) {
        const args = ["--form", formName];
        if (look.scale) args.push("--text-scale", String(look.scale));
        if (look.theme) args.push("--theme", look.theme);
        if (look.rtl)   args.push("--rtl");

        /* `C` is *no translation*: the runtime stops at it, so "as written" is
         * the words in the `.form` whatever the desktop speaks. */
        return { args, environment: { LANGUAGE: look.language || "C" } };
    }

    look() {
        return {
            language: this.languages[this.CmbLanguage.Index] || "",
            scale:    (PREVIEW_SCALES[this.CmbScale.Index] || PREVIEW_SCALES[0]).value,
            theme:    (PREVIEW_THEMES[this.CmbTheme.Index] || PREVIEW_THEMES[0]).value,
            rtl:      this.ChkRtl.Active,
        };
    }

    BtnPreview_Click() {
        const look = this.look();
        Settings.Set(PREVIEW_KEY, look);
        this.Close();
        if (this.onAccept) this.onAccept(look);
    }

    BtnCancel_Click() { this.Close(); }
}
