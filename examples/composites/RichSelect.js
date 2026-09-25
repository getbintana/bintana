/*
 * A select whose rows are more than a word: a picture, a name and a line of
 * detail, with a tick on the chosen one.  The `GtkDropDown` behind `ComboBox`
 * renders strings and nothing else, and this is the widget every settings
 * window keeps building by hand -- so here it is as one component.
 *
 * ## It is a menu, and that is what makes it easy
 *
 * The `Popover` is left with its default `Autohide: true`, which is GTK's own
 * menu behaviour: opening it moves the focus into the list, the arrows walk
 * the rows, Enter activates, Escape or a click outside closes it.  **None of
 * that is written here** -- the only key-free difference from `Suggest` is the
 * flag, and the contrast is the lesson: a list of suggestions has to keep the
 * keyboard (so it drives itself), a select does not (so GTK does).
 *
 * ## One `Choice` per item
 *
 * `Items` is `[{ Icon, Title, Detail }]`, and each one becomes a `Choice` --
 * the row component beside this file, drawn in the designer and built here.
 * Which row is ticked is kept by telling the rows: `show()` sets `Chosen` on
 * all of them, so the tick cannot go stale in a row the selector forgot.
 */
"use strict";

class RichSelect extends Component {

    static Events = ["Select"];

    items  = [];
    rows   = [];
    chosen = -1;

    /* --- what a consumer sets and reads --------------------------------- */

    get Items() { return this.items; }
    set Items(v) { this.fill(v); }

    get Index() { return this.chosen; }
    set Index(v) { this.choose(Number(v), true); }

    get Text() { return this.chosen >= 0 ? this.items[this.chosen].Title : ""; }

    /* --- the list -------------------------------------------------------- */

    fill(items) {
        this.items = (items || []).map((one) => ({
            Icon:   String(one.Icon   || ""),
            Title:  String(one.Title  || ""),
            Detail: String(one.Detail || ""),
        }));

        this.Lst.Clear();
        this.rows = this.items.map((item) => {
            const row = new Choice();
            row.Icon   = item.Icon;
            row.Title  = item.Title;
            row.Detail = item.Detail;
            this.Lst.Add(row);
            return row;
        });

        this.chosen = this.items.length ? 0 : -1;
        this.show();
    }

    choose(at, said) {
        if (at < 0 || at >= this.items.length || at === this.chosen) return;

        this.chosen = at;
        this.show();

        if (said) this.Emit("Select", this.items[at].Title, at);
    }

    /* What the face says, and which row is ticked -- both from `chosen`. */
    show() {
        const item = this.chosen >= 0 ? this.items[this.chosen] : null;

        this.Face.Icon = item ? item.Icon : "";
        this.Face.Text = item ? item.Title : "";

        this.rows.forEach((row, i) => { row.Chosen = i === this.chosen; });
    }

    /* --- the controls saying things -------------------------------------- */

    Face_Click() {
        if (this.Pop.Visible) this.Pop.Close();
        else                  this.Pop.Popup(this.Face);
    }

    Lst_Activate() {
        this.choose(this.Lst.Index, true);
        this.Pop.Close();
    }

}
