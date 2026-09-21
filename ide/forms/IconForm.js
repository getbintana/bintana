/*
 * An icon chooser, in the spirit of gtk3-icon-browser.
 *
 * `Button.Icon` and `TextBox.Icon` take a name from the desktop's theme, and
 * until now the only way to fill one in was to know it by heart and type it.
 * There are 2575 of them on this machine.
 *
 * A Bintana form like any other -- the runtime gained `Application.Icons()`,
 * which is the part it could not do, and the rest is widgets.
 */
"use strict";

const ICON_SIZE = 44;    // side of one icon button
/* A page and not the lot: 2575 buttons is thousands of widgets, and every one
 * of them would be built before anything appeared. Narrowing the search is the
 * way to the rest, and the count says so out loud. */
const PAGE      = 240;

class IconForm extends Form {

    /*
     * IconForm.pick("folder-open", (name) => ...)
     *
     * The callback gets the chosen name, or "" for none. Cancelling calls
     * nothing at all, which is the difference between "no icon" and "never
     * mind" -- and clearing an icon is a thing one means to do.
     */
    static pick(current, onChoose) {
        const dlg = new IconForm();

        dlg.onChoose = onChoose;
        dlg.Modal    = true;
        dlg.all      = Application.Icons();
        dlg.TxtFind.Text = current || "";

        dlg.Show();
        dlg.fill();
        dlg.TxtFind.SetFocus();
        return dlg;
    }

    /*
     * What the search leaves, capped at a page.
     *
     * The theme's index can name an icon it does not really ship, so what is
     * shown is checked with HasIcon -- but only the page being shown: asking it
     * of all 2575 means rendering all 2575, which is a wait nobody asked for.
     */
    matches() {
        const want = this.TxtFind.Text.trim().toLowerCase();
        const out  = [];

        for (const name of this.all) {
            if (want && !name.toLowerCase().includes(want)) continue;
            if (!Application.HasIcon(name)) continue;

            out.push(name);
            if (out.length >= PAGE) break;
        }
        return out;
    }

    fill() {
        /* Nothing to unwire: each handler belongs to its own button and goes
         * with it when the board is emptied. */
        this.Board.Clear();

        const found = this.matches();

        found.forEach((name) => {
            const b = new Button();
            b.Icon    = name;
            b.Tooltip = name;         /* with no text, the name has to be somewhere */
            b.Resize(ICON_SIZE, ICON_SIZE);
            b.On("Click", () => this.choose(name));
            this.Board.Add(b);
        });

        const total = this.TxtFind.Text.trim()
            ? `${found.length} match` : `${found.length} of ${this.all.length}`;
        this.LblCount.Text = found.length >= PAGE
            ? `${total} — narrow the search to see the rest`
            : total;
    }

    choose(name) {
        const answer = this.onChoose;
        this.dismiss();
        if (answer) answer(name);
    }

    dismiss() { this.Close(); }

    TxtFind_Change()   { this.fill(); }
    TxtFind_IconClick() { this.TxtFind.Text = ""; }

    BtnNone_Click()   { this.choose(""); }
    BtnCancel_Click() { this.dismiss(); }

}
