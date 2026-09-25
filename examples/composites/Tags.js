/*
 * A field that holds a set of words: each one a chip with a cross, and an
 * entry that adds the next on Enter or on the `+` inside it.
 *
 * ## The widgets are the list
 *
 * `Items` is the whole state -- an array of strings the program owns -- and
 * `render()` is the only thing that draws it: it clears the `Flow` and builds
 * one chip per word.  No handler reaches into the flow to find a chip, and no
 * chip outlives the render that made it: the cross closes over its own word
 * and calls `drop(tag)`, which changes the data and renders again.  The same
 * bargain the tick in `examples/todo` makes, one level up.
 *
 * ## One array in, one array out
 *
 * `Items` reads back a copy, so a caller cannot change the field by keeping
 * the array it assigned.  Every real change -- an add, a removal -- ends in
 * `Change(items)` with the whole new set, which is the only event the class
 * declares: a caller that keeps the field in a record wants the set, not the
 * delta.
 *
 * The chip is the theme's `osd` background with a radius and padding from the
 * widget properties, and not a class of the project's `app.css`: an example
 * about components should not need a stylesheet to look right.
 */
"use strict";

class Tags extends Component {

    static Events = ["Change"];

    tags = [];

    /* --- what a consumer sets and reads --------------------------------- */

    get Items() { return this.tags.slice(); }
    set Items(v) {
        this.tags = (v || []).map((one) => String(one));
        this.render();
    }

    /* --- the field ------------------------------------------------------- */

    render() {
        this.Chips.Clear();
        for (const tag of this.tags) this.Chips.Add(this.chip(tag));
    }

    chip(tag) {
        const box = new Panel();
        box.Arrangement = "Horizontal";
        box.Spacing     = 4;
        box.Style       = "osd";
        box.Radius      = 12;
        box.Padding     = "2 8";

        const label = new Label();
        label.Text   = tag;
        label.VAlign = "Center";

        const close = new Button();
        close.Icon    = "window-close-symbolic";
        close.Style   = "flat";
        close.Tooltip = `Remove ${tag}`;
        close.On("Click", () => this.drop(tag));

        box.Add(label);
        box.Add(close);
        return box;
    }

    drop(tag) {
        const at = this.tags.indexOf(tag);
        if (at < 0) return;

        this.tags.splice(at, 1);
        this.render();
        this.Emit("Change", this.Items);
    }

    /* --- the two doors into the field, as in `examples/todo` -------------- */

    TxtAdd_Activate()  { this.take(); }
    TxtAdd_IconClick() { this.take(); }

    take() {
        const text = this.TxtAdd.Text.trim();
        this.TxtAdd.Text = "";
        this.TxtAdd.SetFocus();

        /* A word the field already has is not an error, it is nothing to do. */
        if (!text || this.tags.includes(text)) return;

        this.tags.push(text);
        this.render();
        this.Emit("Change", this.Items);
    }

}
