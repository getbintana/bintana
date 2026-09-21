/*
 * The shape of a task, and nothing about showing one.
 *
 * Here rather than at the top of `Board.js` for the reason `examples/quote`
 * gives: the shape is not a detail of the window that shows it. A second
 * window, an importer, a test that never opens one — all want `Task` and none
 * wants a form.
 *
 * `Priority` is a `Field.Enum`, so the setter refuses a priority nobody
 * charges and `PropertyOptions("Priority")` fills both drop-downs from the
 * same list — the board's filter and the dialog's field cannot disagree.
 * The board compares the filter **by index** for the same reason
 * `examples/files` does: a combo's `Items` are prose and move in translation.
 *
 * `Due` is optional on purpose. An empty date spells `""`, which is what an
 * unset `DatePicker.Value` reads back — so a task with no date round-trips
 * instead of coming back stamped today.
 *
 * `Column` names a column by **id** and not by position: reordering or
 * renaming columns never orphans a task. `Order` decides the sequence inside
 * the column; a drop lands at the end (see `Board.js`).
 */
"use strict";

class Task extends Record {
    static Naming = "lower";
    static Fields = {
        Id:       Field.Int({ key: true }),
        Title:    Field.Text({ required: true, max: 80 }),
        Notes:    Field.Text({ max: 500 }),
        Priority: Field.Enum(["Low", "Medium", "High", "Urgent"]),
        Due:      Field.Date(),
        Column:   Field.Text({ required: true, max: 40 }),
        Order:    Field.Int({ def: 0 }),
    };

    /* What the card's second line is made of is the board's business; what a
     * task *is* overdue is the shape's, so it lives here and not in a label. */
    get Overdue() {
        return this.Due !== "" && this.Due < Day.Today;
    }
}
