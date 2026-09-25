/*
 * The field the runtime does not have: a combo you can type in.
 *
 * A `ComboBox` is one choice out of a closed list -- `Index` and `Text` are the
 * whole of it and there is no typing.  A `TextBox` has an icon, a purpose and a
 * placeholder but no list.  What a form keeps needing is both: type to narrow,
 * take a row with Enter or the mouse, and **a value that is in no list is just
 * as valid** -- a category that is usually one of ten and occasionally new.
 *
 * This is that, built out of two controls and the popover between them, so the
 * shape is worth reading before it is worth using.
 *
 * ## The list keeps its own answers
 *
 * `Items` is the whole list and every row is a `Label` built from it.  Which
 * rows pass the needle is computed **once per keystroke** into `shown` and
 * `visible` (`refilter`), because `RowList`'s `Filter` is asked while the list
 * is being laid out and a handler there is a lookup and nothing else.  The
 * count is what decides whether the popover is worth opening: no match, no
 * popup.
 *
 * ## The text does not change under the pointer
 *
 * Arrowing through the list only moves the highlight -- the field keeps what
 * was typed, so a half-word is never replaced by a suggestion on the way past.
 * Taking a row is Enter, a click, or `Lst_Activate`, and that is the moment the
 * text is written back: `accept()`.
 *
 * ## The focus is the delicate half
 *
 * The popover is `Autohide: false`, and that is the price of being typeable:
 * an autohide popover **takes the keyboard into the list** while it is shown,
 * so the letters stop reaching the field -- measured, with the field fighting
 * to take the focus back on every turn.  With autohide off GTK leaves the
 * keyboard alone, and `LostFocus` is what closes it: **one turn later**,
 * because the *press* of a click on a row is what takes the focus and the
 * *release* is what activates the row.  Closing on the spot took the popup out
 * from under the release, and measured, `Lst_Activate` never arrived.
 *
 * The one gesture it does not see is a click on a bare background, which moves
 * no focus and so tells nobody anything: Escape, a row, Enter, Tab or another
 * control all close it, and a click on the page's own empty room does not.
 * That is the same bargain `GtkEntryCompletion`'s users know, and it is
 * written down here rather than worked around.
 *
 * ## Which keys arrive
 *
 * Measured on a `TextBox`: `Up`, `Down`, `Escape` and `Tab` reach `KeyPress`
 * and returning true consumes them; the printable keys and `Left`/`Right` are
 * claimed by the entry; Enter does **not** arrive as a key press at all -- it
 * raises `Activate`.  So this field has three handlers, not one: `Activate`
 * takes, `KeyPress` walks the list and closes it, and `Change` filters.
 *
 * `ActivatesDefault` has to be off for `Activate` to be raised at all, which
 * is its default -- but a form with a default button and a field that wants
 * Enter would have to say so.
 */
"use strict";

class Suggest extends Component {

    static Events         = ["Change", "Select"];
    static TextProperties = ["Placeholder"];

    /* The whole state, and none of it is in a widget: `items` is the list,
     * `shown` which of them the needle keeps, `chosen` the row that was taken
     * (`-1` for free text) and `updating` says an assignment is ours. */
    items    = [];
    shown    = [];
    visible  = 0;
    chosen   = -1;
    updating = false;
    needle   = "";

    /* --- what a consumer sets and reads --------------------------------- */

    get Items() { return this.items; }
    set Items(v) { this.fill(v); }

    get Text() { return this.Txt.Text; }
    set Text(v) {
        /* Ours, so the round trip out to GTK and back is not heard as typing:
         * assigning a value must not open the list over the assignment. */
        this.updating = true;
        this.Txt.Text = String(v);
        this.updating = false;

        this.chosen = -1;
        this.Pop.Close();
    }

    get Index() { return this.chosen; }

    get Placeholder() { return this.Txt.Placeholder; }
    set Placeholder(v) { this.Txt.Placeholder = String(v); }

    /* --- the list -------------------------------------------------------- */

    fill(items) {
        this.items = (items || []).map((one) => String(one));

        this.Lst.Clear();
        for (const text of this.items) {
            const row = new Label();
            row.Text    = text;
            row.Margin  = 6;
            row.HAlign  = "Fill";
            row.HExpand = true;
            this.Lst.Add(row);
        }

        this.chosen = -1;
        this.Pop.Close();
        this.refilter();
    }

    /* Which rows the needle keeps, once -- `Lst_Filter` below is the lookup. */
    refilter() {
        this.needle = this.Txt.Text.trim();

        this.shown = this.items.map(
            (text) => this.needle === "" || Locale.Matches(text, this.needle));
        this.visible = this.shown.filter(Boolean).length;

        this.Lst.Refilter();
    }

    /* Nothing chosen yet is where Enter cannot take: free text. */
    get takes() {
        return this.Lst.Index >= 0 && this.shown[this.Lst.Index] === true;
    }

    open() {
        if (this.visible === 0) {
            this.Pop.Close();
            return;
        }

        /* As wide as the field it belongs to, so the rows read as one column
         * and not as a box that happens to be below it. */
        this.Lst.Width = Math.max(240, this.Txt.Bounds().Width);
        this.Pop.Popup(this.Txt);
    }

    /* One step along the *visible* rows, wrapping. */
    step(delta) {
        const n = this.items.length;
        if (!n) return;

        let at = this.Lst.Index >= 0 ? this.Lst.Index : (delta > 0 ? -1 : 0);

        for (let i = 0; i < n; i++) {
            at = (at + delta + n) % n;
            if (this.shown[at]) break;
        }

        if (this.shown[at]) {
            this.Lst.Select(at);
            this.Lst.Reveal(at);
        }
    }

    accept(at) {
        if (at < 0 || at >= this.items.length || !this.shown[at]) {
            this.Pop.Close();
            return;
        }

        const text  = this.items[at];
        const moved = text !== this.Txt.Text;

        this.updating = true;
        this.Txt.Text = text;
        this.updating = false;

        this.chosen = at;
        this.Pop.Close();

        /* A click took the focus into the list; the field wants it back. */
        this.Txt.SetFocus();
        this.Txt.Select(this.Txt.Text.length, 0);

        if (moved) this.Emit("Change", text);
        this.Emit("Select", text, at);
    }

    /* --- the controls saying things -------------------------------------- */

    Txt_Change() {
        if (this.updating) return;

        this.refilter();
        this.open();
        this.Emit("Change", this.Txt.Text);
    }

    Txt_Activate() {
        if (this.takes) this.accept(this.Lst.Index);
        else            this.Pop.Close();
    }

    Txt_KeyPress(key) {
        if (key === "Escape" && this.Pop.Visible) {
            this.Pop.Close();
            return true;
        }

        if ((key === "Down" || key === "Up") && this.visible > 0) {
            /* Opening with the arrow selects as it opens -- the first row for
             * Down, the last for Up -- so Enter after it takes something. */
            if (!this.Pop.Visible) this.open();
            this.step(key === "Down" ? 1 : -1);
            return true;
        }

        return false;
    }

    Txt_LostFocus() {
        /*
         * One turn later, because a click on a row loses the focus on the
         * press and activates it on the release: closing now would take the
         * popup out from under the release.  A row that took it has closed the
         * popup by then, so there is nothing to do.
         */
        Timer.After(0, () => {
            if (this.Pop.Visible) this.Pop.Close();
        });
    }

    Lst_Activate() {
        this.accept(this.Lst.Index);
    }

    /* A lookup, as the handler a layout asks is not allowed to be more. */
    Lst_Filter(row, index) {
        return this.shown[index] !== false;
    }

}
