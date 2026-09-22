/*
 * What translation does to a layout, as numbers rather than as an impression.
 *
 * The same three buttons -- `Item`, `Submenu`, `Rule` -- laid out four ways, with
 * a blue rule drawn where the container above them ends. Run it in English, then
 * with LANGUAGE=es, and press Measure: the report says, for each row, how wide
 * each button came out and whether the row ran past that line.
 *
 *   ./build/bintana examples/i18n                 # the msgids
 *   LANGUAGE=es ./build/bintana examples/i18n     # the translation
 *
 * Row 1 is the shape the IDE's own menu editor has: three buttons at coordinates
 * whose declared widths add up to exactly the width of the list above them. It is
 * the one that breaks, and it breaks for a reason worth stating precisely:
 *
 *   **A declared Width is a minimum, not a size.** A control whose text needs
 *   more renders wider than the `.form` says -- so a row with no slack does not
 *   clip, it *overflows*, and it overflows into whatever is beside it.
 *
 * Rows 2 to 4 are the three ways out, and the report is what tells them apart.
 */
"use strict";

/* The rows, and where each one's room ends: the x of the rule drawn above it. */
const ROWS = [
    { name: "1 coordinates, no slack", edge: "RulerA",
      buttons: ["BtnFixedItem", "BtnFixedSub", "BtnFixedRule"] },
    { name: "2 coordinates, with slack", edge: "RulerB",
      buttons: ["BtnSlackItem", "BtnSlackSub", "BtnSlackRule"] },
    { name: "3 horizontal box", edge: null,
      buttons: ["BtnBoxItem", "BtnBoxSub", "BtnBoxRule"] },
    { name: "4 box, homogeneous", edge: null,
      buttons: ["BtnEvenItem", "BtnEvenSub", "BtnEvenRule"] },
];

class Layouts extends Form {

    Form_Open() {
        /* Which catalogue is in force, so a screenshot says what it is showing. */
        this.LblLang.Text = Locale.Current
            ? Locale.Text("Catalogue in use: {0}", Locale.Current)
            : Locale.Text("No catalogue: showing the msgids");

        /* Waited for, not timed: nothing is allocated until the main loop has
         * run, and `Allocated` is the frame GTK gives the window one. */
        this.On("Allocated", () => this.measure());

        /* The anchor case opens beside it: the two halves of the question are
         * better read together than one after the other. */
        Timer.After(120, () => this.BtnAnchors_Click());
    }

    BtnMeasure_Click() { this.measure(); }

    /* The other half of the question: an anchor answers "the window grew", and
     * this is what happens when the *contents* grow instead. */
    BtnAnchors_Click() {
        this.anchors = new Anchors();
        this.anchors.Show();
    }

    measure() {
        const out = [];

        for (const row of ROWS) {
            const limit = row.edge ? this.rightOf(this[row.edge]) : null;
            let worst = 0;

            const parts = row.buttons.map((name) => {
                const b   = this[name];
                const box = b.Bounds();
                const ask = b.SizeRequest()[0];
                const end = box.X + box.Width;

                if (limit !== null) worst = Math.max(worst, end - limit);
                /* asked-for against drawn: the gap is the whole story */
                return `${b.Text}=${box.Width}${ask > 0 && box.Width > ask ? `(>${ask})` : ""}`;
            });

            const verdict = limit === null
                ? "box: the row is as wide as it needs"
                : worst > 0 ? `OVERFLOWS its room by ${worst}px`
                            : "fits";

            out.push(`${row.name}\n    ${parts.join("  ")}\n    ${verdict}`);
        }

        this.Report.Text = out.join("\n\n");
        print(this.Report.Text);
    }

    /* Where a control's room ends, in the window's coordinates. */
    rightOf(widget) {
        const box = widget.Bounds();
        return box.X + box.Width;
    }
}
