/*
 * Which controls of a `.form` a screen reader cannot name, said before the
 * program is run.
 *
 * The runtime can say what a control is called to an assistive technology
 * (`AccessibleName`, `Label.For`, an icon-only button's `Tooltip`), and GTK
 * names a button by its words; the rest -- a button that is only an icon, a
 * field beside a caption, a picture -- is a "button", a "text box" and an
 * "image" with nothing to tell them apart. The API does nothing for an
 * application whose author never thinks of it, and an author never will unless
 * something says so at the moment the form is written. So this is a *check*,
 * in the family of `Names` and `Check`: it reads the file, asks no window, and
 * finds a thing the runtime accepts without a word.
 *
 * **It is a pure function over a `.form`'s JSON, and that is its limit.** It
 * sees what the file declares; a control built in code, and a component whose
 * form is another file, are somebody else's. `AccessibleInfo()` on the live
 * control is what answers for those.
 *
 * Three rules, and each has a real fix:
 *
 *     a field        a `TextBox`, `SpinBox`, `DecimalBox`, `ComboBox`,
 *                    `DatePicker`, `Slider`, `Switch` or editor with no
 *                    `AccessibleName` and no `Label.For` pointing at it
 *     a button       a `Button` or `ToggleButton` with no `Text`, no `Action`
 *                    that has words, and no `Tooltip` short enough to be a name
 *     a picture      an `Image` or `Picture` with no `AccessibleName`
 *
 * **Every row is the severity the project chose** -- `"accessibility"` in
 * `project.json`: `warning` (the default), `info`, or `off`. One setting, not a
 * different severity per rule: a project that decides accessibility is advice
 * decides it for all three, and one that decides it is nothing turns it off.
 * And **a control that is only decoration says so** with `AccessibleHidden`,
 * which is also what a screen reader needs to skip it -- the one way to quiet
 * the check that is also the truth.
 *
 * `Label.For` is read from the file as the name it is: the same relation the
 * runtime settles when the form is built.
 */
"use strict";

/* The levels, in the order they are written; `warning` is what no word means. */
const A11Y_LEVELS = ["off", "info", "warning"];

/* What a person types into, or sets: each is named by a caption or a name. */
const A11Y_FIELDS = ["TextBox", "SpinBox", "DecimalBox", "ComboBox", "DatePicker",
                     "Slider", "Switch", "TextEditor", "SourceEditor"];
const A11Y_BUTTONS  = ["Button", "ToggleButton"];
const A11Y_PICTURES = ["Image", "Picture"];

/* The runtime's own limit for a tooltip that is a name (`A11Y_TOOLTIP_MAX`): a
 * longer one is advice, read out on every visit to the button. */
const A11Y_TOOLTIP_MAX = 60;

export class Accessibility {

    /* The level a project's manifest asks for: `"warning"` when it says nothing,
     * and when it says something that is not a level -- which `ProjectFile`
     * reports as the mistake it is, and which is no reason to stop checking. */
    static level(config) {
        const said = config && typeof config.accessibility === "string"
                     ? config.accessibility.trim().toLowerCase() : "";
        return A11Y_LEVELS.includes(said) ? said : "warning";
    }

    /* Whether a word is one of the three, for the manifest's own validation. */
    static isLevel(word) {
        return A11Y_LEVELS.includes(String(word).trim().toLowerCase());
    }

    /* The `Problems` row's kind for a level, `null` for `off`. */
    static kind(level) {
        return level === "warning" ? "Warning" : level === "info" ? "Info" : null;
    }

    /*
     * What is missing in one form, as sentences.
     *
     * `root` is the parsed `.form`. Walks `children` only, as `Check.form` does
     * for properties: menus and commands declare keys of the file, not controls.
     */
    static findings(root) {
        const out = [];
        if (!root) return out;

        /* Names a caption points at, from anywhere in the tree: a caption may sit
         * in another panel from its field. */
        const captioned = {};
        const actions   = {};
        const collect = (nodes) => {
            for (const node of nodes || []) {
                const p = node.properties || {};
                if (node.type === "Label" && typeof p.For === "string" && p.For)
                    captioned[p.For] = true;
                collect(node.children);
            }
        };
        collect(root.children);
        for (const action of root.actions || [])
            if (action && action.name) actions[action.name] = action;

        const walk = (nodes) => {
            let before = null;                   // the sibling just above

            for (const node of nodes || []) {
                Accessibility.check(node, before, captioned, actions, out);
                before = node;
                walk(node.children);
            }
        };
        walk(root.children);
        return out;
    }

    /* One control against the three rules. */
    static check(node, before, captioned, actions, out) {
        const p    = node.properties || {};
        const type = node.type;
        const name = node.name || `(an unnamed ${type})`;

        if (p.AccessibleHidden === true)
            return;                              // decoration: said so, and true
        const named = typeof p.AccessibleName === "string" && p.AccessibleName !== "";

        if (A11Y_FIELDS.includes(type)) {
            if (named || (node.name && captioned[node.name])) return;

            /* The caption just above is almost always the one: say so, which is
             * the fix and not only the complaint. */
            const hint = before && before.type === "Label" && !(before.properties || {}).For && before.name
                ? ` (the Label ${before.name} just before it is probably its caption: ` +
                  `set ${before.name}.For to "${node.name || "its name"}")`
                : "";
            out.push(`${name} is a ${type} a screen reader cannot name: give it an ` +
                     `AccessibleName, or point a Label's For at it${hint}`);
        } else if (A11Y_BUTTONS.includes(type)) {
            const act   = typeof p.Action === "string" ? actions[p.Action] : null;
            const words = (typeof p.Text === "string" && p.Text !== "") ||
                          !!(act && typeof act.text === "string" && act.text !== "");
            const tip   = typeof p.Tooltip === "string" ? p.Tooltip : "";

            if (words || named || (tip !== "" && Array.from(tip).length <= A11Y_TOOLTIP_MAX))
                return;
            out.push(`${name} is a ${type} with no words, no command with words and no ` +
                     `Tooltip of ${A11Y_TOOLTIP_MAX} characters or fewer: a screen reader ` +
                     `says only "button". Give it an AccessibleName`);
        } else if (A11Y_PICTURES.includes(type)) {
            if (named) return;
            out.push(`${name} is a ${type} with no AccessibleName: give it one, or ` +
                     `AccessibleHidden if it is only decoration`);
        }
    }
}
