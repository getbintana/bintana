/*
 * What a `RichSelect` floats under its face: the rows, and nothing else.
 *
 * A component of its own, drawn in its own tab, with three sample `Choice` rows
 * in the designer. `Popover.Show(list, face)` opens it, and the list's own
 * `Activate` arrives here by name, so it is said again as `Take`.
 */
"use strict";

class ChoiceList extends Component {

    /* Take(at)
     *   the row at that index was activated
     */
    static Events = ["Take"];

    Lst_Activate() {
        this.Emit("Take", this.Lst.Index);
    }

}
