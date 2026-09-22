/*
 * One row of the item list.
 *
 * A component, the way `examples/contacts`' `Contact` is and for the same
 * reason: the row is drawn in a `.form` instead of assembled from eight
 * assignments, and `Feeds.form` can say what its list holds while it is being
 * designed (`"item": { "of": "FeedItem", "count": 4 }`) rather than showing an
 * empty box.
 *
 * The properties are `Title` and `When` -- not `Text`, which every `Label`
 * inside already uses, and not `Name`, which is the runtime's on every widget.
 */
"use strict";

class FeedItem extends Component {

    get Title()  { return this.LblTitle.Text; }
    set Title(v) { this.LblTitle.Text = String(v); }

    get When()  { return this.LblWhen.Text; }
    set When(v) { this.LblWhen.Text = String(v); }
}
