/*
 * One row of the list, as a component.
 *
 * It used to be a `row(contact)` method on the form: forty lines that made a
 * `Panel`, three `Label`s, and set eight properties on them. That is a class
 * with the word `class` left out -- and it had two costs. Nothing else could
 * use it, and **the designer could not see it**: a `RowList` is filled by the
 * program, so `Contacts.form` drew it as an empty box and the window was laid
 * out around a rectangle nobody could check.
 *
 * As a component both go away. The row is three controls in a `.form`, drawn in
 * the designer like anything else, and `Contacts.form` says what its list holds
 * while it is being designed:
 *
 *     "item": { "of": "Contact", "count": 3 }
 *
 * The designer draws three of these; the program builds the same class. That is
 * the whole reason the item names a **class** and not a layout file -- the
 * drawing and the running list are one thing and cannot drift apart.
 *
 * **The properties are `Person`, `City` and `Phone`, and the first one is not
 * `Name` on purpose.** Every widget already has a `Name`: it is what the runtime
 * dispatches events by and what `this.<name>` on a form looks up. A component
 * publishing its own would shadow that, and the failure would arrive far from
 * here.
 *
 * They are ordinary accessors, which is all a component has to do to be
 * settable from a `.form`, offered by the property grid and written back by the
 * serialiser. What the labels show while the *designer* draws them is in
 * `Contact.form`'s `design` blocks -- a name, a city and a number that no
 * running program ever sees.
 */
class Contact extends Component {

    get Person()  { return this.LblPerson.Text; }
    set Person(v) { this.LblPerson.Text = String(v); }

    get City()  { return this.LblCity.Text; }
    set City(v) { this.LblCity.Text = String(v); }

    get Phone()  { return this.LblPhone.Text; }
    set Phone(v) { this.LblPhone.Text = String(v); }
}
