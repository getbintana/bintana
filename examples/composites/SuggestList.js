/*
 * What a `Suggest` floats under its field: the list, and nothing else.
 *
 * It is a component of its own so that it is drawn in its own tab like any
 * other form -- the list is the part of `Suggest` that used to be invisible on
 * the designer's canvas, because it lived in a popover that takes no room.
 * `Popover.Show(list, field)` is the whole of how it is opened.
 *
 * The list's events arrive here by name (`Lst_Activate`), so they are said
 * again for whoever shows it: `Take` is a row activated, and `filter` is the
 * lookup a layout asks while it is drawing the rows -- a function, because
 * what the needle keeps is `Suggest`'s to know.
 */
"use strict";

class SuggestList extends Component {

    /* Take(at)
     *   the row at that index was activated
     */
    static Events = ["Take"];

    filter = null;

    Lst_Activate() {
        this.Emit("Take", this.Lst.Index);
    }

    /* A lookup, as the handler a layout asks is not allowed to be more. */
    Lst_Filter(row, index) {
        return this.filter ? this.filter(index) : true;
    }

}
