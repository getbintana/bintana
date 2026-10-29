/*
 * What the board's data decides, held without a window.
 *
 * `examples/quote/tests/QuoteTest.js` explains how a project is tested; this
 * one is the second example of it and shows the other thing worth knowing: a
 * test of *state*. The same rules used to be methods of `Board`, tangled in
 * with the widgets, and the only way to check where a dropped card lands was to
 * drag one. They are `BoardData` now, and a test is a few lines of arithmetic.
 *
 *     ./build/bintana test examples/kanban
 *
 * **Every test gets a board of its own in a scratch directory**, because
 * `BoardData` writes a file: a test that wrote to the real `kanban.json` would
 * be somebody's board edited by a test run. `Setup` makes the directory under
 * the system's temporary one and `Teardown` removes the whole tree.
 */
"use strict";

class BoardDataTest extends Test {

    Setup() {
        this.dir = File.Join(Environment.TempDirectory, `kanban-test-${Random.Uuid()}`);
        Directory.Make(this.dir);
        this.data = new BoardData(File.Join(this.dir, "kanban.json"));
        this.data.cols = [{ id: "a", title: "A" }, { id: "b", title: "B" }];
        this.data.tasks = [];
    }

    Teardown() {
        Directory.DeleteTree(this.dir);
    }

    /* A task in a column, in the order the calls are made. */
    add(title, col) {
        return this.data.addTask({ Title: title, Column: col });
    }

    /* The titles of a column, in the order it shows them. */
    titles(col) {
        return this.data.inColumn(col).map((t) => t.Title);
    }

    testANewTaskGoesToTheEndOfItsColumn() {
        this.add("one", "a");
        this.add("two", "a");
        this.Eq(this.titles("a"), ["one", "two"]);
    }

    testIdsAreNeverReused() {
        const first = this.add("one", "a");
        this.data.removeTask(first.Id);
        const second = this.add("two", "a");
        this.Check(second.Id > first.Id, "a deleted task's id must not come back");
    }

    /* `before` is the task the moved one lands *above*. */
    testAMoveLandsAboveTheTaskItWasDroppedOn() {
        this.add("one", "a");
        this.add("two", "a");
        const c = this.add("three", "b");
        const two = this.data.inColumn("a")[1];

        this.Eq(this.data.move(c.Id, "a", two.Id), true);
        this.Eq(this.titles("a"), ["one", "three", "two"]);
        this.Eq(this.titles("b"), []);
    }

    testAMoveWithNothingBeforeItGoesToTheEnd() {
        const one = this.add("one", "a");
        this.add("two", "a");
        this.data.move(one.Id, "a");
        this.Eq(this.titles("a"), ["two", "one"]);
    }

    /* A card dropped back where it was is not an edit: nothing to save, nothing
     * to repaint. */
    testDroppingACardWhereItIsChangesNothing() {
        const one = this.add("one", "a");
        const two = this.add("two", "a");
        this.Eq(this.data.move(one.Id, "a", two.Id), false);
        this.Eq(this.data.move(two.Id, "a"), false);
        this.Eq(this.titles("a"), ["one", "two"]);
    }

    testAMoveToAColumnThatIsNotThereIsRefused() {
        const one = this.add("one", "a");
        this.Eq(this.data.move(one.Id, "nowhere"), false);
        this.Eq(one.Column, "a");
    }

    /* The column it left keeps its gaps: `Order` is only a sort key. */
    testTheTargetIsRenumberedAndTheSourceIsLeftAlone() {
        this.add("one", "a");
        const two = this.add("two", "a");
        const three = this.add("three", "a");
        this.data.move(two.Id, "b");
        this.Eq(this.data.inColumn("b").map((t) => t.Order), [0]);
        this.Eq(three.Order, 2);
    }

    testColumnIdsAreNotReused() {
        const c = this.data.addColumn("C");
        this.data.removeColumn(c.id);
        const d = this.data.addColumn("D");
        this.Check(c.id !== d.id, "a column's id must not be reused");
    }

    testWhatIsSavedIsWhatIsLoaded() {
        this.add("one", "a");
        this.add("two", "b");
        this.data.save();

        const again = new BoardData(this.data.path);
        again.load();
        this.Eq(again.cols.map((c) => c.id), ["a", "b"]);
        this.Eq(again.tasks.map((t) => t.Title), ["one", "two"]);
    }

    /* A task that names no column is left out and said so, instead of being
     * kept where nothing can show it. */
    testATaskWithNoColumnIsLeftOutAndSaid() {
        File.SaveJson(this.data.path, {
            columns: [{ id: "a", title: "A" }],
            tasks: [{ id: 1, title: "fine", column: "a" }, { id: 2, title: "lost", column: "gone" }],
        });
        const again = new BoardData(this.data.path);
        again.load();
        this.Eq(again.tasks.map((t) => t.Title), ["fine"]);
        this.Check(again.note !== "", "the note says something was left out");
    }

    testAMissingFileSeedsABoard() {
        const fresh = new BoardData(File.Join(this.dir, "none.json"));
        fresh.load();
        this.Check(fresh.cols.length === 3 && fresh.tasks.length > 0, "a first run has something to look at");
        this.Check(File.Exists(fresh.path), "and it is written, so the next run reads it");
    }
}
