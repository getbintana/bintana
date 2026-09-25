/*
 * The fields a form keeps needing that the runtime does not have, each built
 * out of the controls it does have.
 *
 * A `ComboBox` is a closed list and a `TextBox` is a line: **the field you can
 * type in and pick from at once does not exist**, and neither does a select
 * whose rows are more than a string, or a field that holds a set of words.  So
 * each one is a component beside this file, and this form is the three of them
 * side by side with what they raise spelled out underneath:
 *
 *   `Suggest`      an editable combo: filter as you type, take a row with
 *                  Enter or the mouse, and free text is a value too
 *   `RichSelect`   a closed select whose rows are icon, name and detail
 *   `Tags`         a set of words as chips, added and removed
 *
 * ## What the page is for
 *
 * The status line under each one is the component's event arriving on this
 * form by name -- `Sug1_Select`, `Tag1_Change` -- which is exactly the road a
 * control's own event takes.  A component is not a special case to wire: it
 * declares `static Events` and raises them with `Emit`, and from here they are
 * `<name>_<event>` methods like everything else.
 *
 * The data is set from code rather than declared in the `.form`, and both
 * would have worked: `Items` is an ordinary settable property, so a `.form`
 * can carry it and the designer's grid edits it.  It is here because a list of
 * twenty countries in a `.form` is a wall, and the point of this example is the
 * behaviour.  Note that `Items` is **not** declared as prose
 * (`static TextProperties`), so these words do not go into a catalogue: an item
 * is data the program chose, and `examples/i18n` is the example about the text
 * a person reads.
 *
 * The other half of that decision is `Placeholder`, which *is* declared prose
 * -- one word a translator should see.  Which properties hold prose is a
 * declaration per class and never a guess from the name.
 */
"use strict";

class MainForm extends Form {

    Form_Open() {
        /*
         * The editable combo: a country is usually one of these and often
         * something else -- write an invented one and it is just as valid.
         */
        this.Sug1.Items = [
            "Argentina", "Bolivia", "Brasil", "Chile", "Colombia", "Costa Rica",
            "Cuba", "Ecuador", "El Salvador", "Guatemala", "Honduras", "México",
            "Nicaragua", "Panamá", "Paraguay", "Perú", "Uruguay", "Venezuela",
        ];
        this.Sug1.Placeholder = "A country, or anything else";

        /* The rich select: the state is `Index`, and assigning it is the same
         * road a click takes -- the row is ticked and the face follows. */
        this.Sel1.Items = [
            { Icon: "audio-speakers-symbolic",    Title: "Digital Output",
              Detail: "Built-in Audio" },
            { Icon: "audio-headphones-symbolic", Title: "Headphones",
              Detail: "Built-in audio" },
            { Icon: "computer-symbolic",          Title: "Thunderbolt Dock",
              Detail: "USB Audio, ThinkPad" },
        ];
        this.LblSelSaid.Text = `Chosen 0: ${this.Sel1.Text}`;

        /* And a set of words, which arrives as one array. */
        this.Tag1.Items = ["urgent", "home"];
        this.LblTagSaid.Text = `Tags: ${this.Tag1.Items.join(", ")}`;
    }

    /* What a `Suggest` raises: every text change, and a listed row taken. */
    Sug1_Change(text) {
        this.LblSugSaid.Text = `Text: ${text}`;
    }

    Sug1_Select(text, index) {
        this.LblSugSaid.Text = `Chosen ${index}: ${text}`;
    }

    /* The select says which row, and the tag field hands back the whole set. */
    Sel1_Select(title, index) {
        this.LblSelSaid.Text = `Chosen ${index}: ${title}`;
    }

    Tag1_Change(items) {
        this.LblTagSaid.Text = items.length ? `Tags: ${items.join(", ")}` : "(no tags)";
    }

}
