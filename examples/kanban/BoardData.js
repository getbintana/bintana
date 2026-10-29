/*
 * The board's data, and nothing about showing it.
 *
 * Columns, tasks, the file that keeps them and the rules about where a task
 * may go: everything `Board` used to hold in its own fields and methods beside
 * the widgets. It is a module -- `export class` below -- so `Board.js`,
 * `TaskDialog.js` and `tests/BoardDataTest.js` reach it by its bare name with
 * no `import`, and nothing else in the file leaks out.
 *
 * ## Why it was taken out of the form
 *
 * A form is a poor place for rules. `Board` mixed two kinds of method: the ones
 * that build cards and light up columns while a drag travels (they need a
 * window), and the ones that decide *which column a task is in, in what order,
 * and what the file says* (they need none). The second kind is what a test can
 * hold without opening anything -- `examples/quote` did the same with its
 * totals -- and what a second window or an importer would want, so it is
 * here, and `Board` asks it.
 *
 * ## What stays out
 *
 * Nothing here touches a widget, a selection or a filter. `save()` is called by
 * the form after each change, because *when* to write is the window's
 * decision; *what* is written is this file's.
 */
"use strict";

export class BoardData {

    /* The board: column defs `{ id, title }` in order, and the tasks. */
    cols  = [];
    tasks = [];

    /* A note from loading (rows left out, lenient reads), shown in the
     * status line until the next change rewrites it. */
    note = "";

    nextTaskId = 1;
    nextColN   = 1;
    path       = "";

    constructor(path) {
        this.path = path;
    }

    load() {
        let data = null;
        if (File.Exists(this.path)) {
            try {
                data = File.LoadJson(this.path);
            } catch (e) {
                Message.Error("Cannot read {0}: {1}", this.path, e.message);
            }
        }
        if (!data || !data.columns || !data.tasks) {
            this.seed();
            return;
        }

        this.cols = [];
        for (const c of data.columns) {
            if (!c || typeof c.id !== "string" || !c.id ||
                typeof c.title !== "string" || !c.title.trim())
                continue;
            this.cols.push({ id: c.id, title: c.title });
        }
        if (!this.cols.length) {
            this.seed();
            return;
        }

        const ids = {};
        for (const c of this.cols) ids[c.id] = true;

        this.tasks = [];
        const wrong = [];
        for (const raw of data.tasks) {
            let t = null;
            try {
                t = Task.Load(raw);
            } catch (e) {
                wrong.push(e.message);
                continue;
            }
            for (const p of t.Problems) wrong.push(p);
            if (!ids[t.Column]) {
                wrong.push(Locale.Text("One task names no column and was left out."));
                continue;
            }
            this.tasks.push(t);
        }

        this.nextTaskId = 1;
        for (const t of this.tasks)
            if (t.Id >= this.nextTaskId) this.nextTaskId = t.Id + 1;

        this.nextColN = 1;
        for (const c of this.cols) {
            const m = new Regex("^c(\\d+)$").Match(c.id);
            if (m && Number(m.Group(1)) >= this.nextColN)
                this.nextColN = Number(m.Group(1)) + 1;
        }

        this.note = wrong.length
            ? Locale.Text("{0} rows could not be read as they are.", wrong.length)
            : "";
    }

    /* Something to look at on a first run. An empty board cannot be told
     * from a broken one — and one overdue card shows what the red meta
     * line means without a paragraph about it. The titles go through the
     * catalogue here and never again: see the header. */
    seed() {
        this.cols = [
            { id: "todo",  title: Locale.Text("To do") },
            { id: "doing", title: Locale.Text("Doing") },
            { id: "done",  title: Locale.Text("Done") },
        ];
        this.nextTaskId = 1;
        this.nextColN = 1;

        const T = Day.Today;
        const mk = (o) => {
            const t = new Task(o);
            t.Id = this.nextTaskId;
            this.nextTaskId++;
            return t;
        };
        this.tasks = [
            mk({ Title: Locale.Text("Draw the board"), Notes: Locale.Text("Cards, columns, and the drag between them."),
                 Priority: "High", Due: Day.Add(T, 2), Column: "todo", Order: 0 }),
            mk({ Title: Locale.Text("Write the seed"), Notes: "",
                 Priority: "Medium", Due: "", Column: "todo", Order: 1 }),
            mk({ Title: Locale.Text("Drag a card across"), Notes: Locale.Text("It lands where you drop it — between two cards, or past the last one."),
                 Priority: "Low", Due: "", Column: "doing", Order: 0 }),
            mk({ Title: Locale.Text("Answer the overdue mail"), Notes: "",
                 Priority: "Urgent", Due: Day.Add(T, -2), Column: "doing", Order: 1 }),
            mk({ Title: Locale.Text("First board that saved itself"), Notes: "",
                 Priority: "Low", Due: Day.Add(T, -30), Column: "done", Order: 0 }),
        ];
        this.note = "";
        this.save();
    }

    save() {
        const data = {
            columns: this.cols.map((c) => ({ id: c.id, title: c.title })),
            tasks: this.tasks.map((t) => t.Serialize(true)),
        };
        try {
            File.SaveJson(this.path, data);
        } catch (e) {
            Message.Error("Cannot write {0}: {1}", this.path, e.message);
        }
    }

    /* --- looking things up -------------------------------------------------- */

    colDef(id) {
        for (const c of this.cols)
            if (c.id === id) return c;
        return null;
    }

    colIndex(id) {
        for (let i = 0; i < this.cols.length; i++)
            if (this.cols[i].id === id) return i;
        return -1;
    }

    taskById(id) {
        for (const t of this.tasks)
            if (t.Id === id) return t;
        return null;
    }

    endOrder(colId) {
        let top = -1;
        for (const t of this.tasks)
            if (t.Column === colId && t.Order > top) top = t.Order;
        return top + 1;
    }

    /* --- changing it -------------------------------------------------------- */

    /* A new task from the dialog's fields, at the end of its column. */
    addTask(data) {
        const t = new Task(data);
        t.Id = this.nextTaskId;
        this.nextTaskId++;
        t.Order = this.endOrder(t.Column);
        this.tasks.push(t);
        return t;
    }

    /* A task edited: one that changed column goes to the end of the new one. */
    applyEdit(id, data) {
        const t = this.taskById(id);
        if (!t) return null;
        const moved = data.Column !== t.Column;
        t.Apply(data);
        if (moved) t.Order = this.endOrder(t.Column);
        return t;
    }

    removeTask(id) {
        this.tasks = this.tasks.filter((t) => t.Id !== id);
    }

    /* A new column at the end, with an id nobody has used. */
    addColumn(title) {
        const c = { id: "c" + this.nextColN, title: title };
        this.nextColN++;
        this.cols.push(c);
        return c;
    }

    removeColumn(id) {
        this.cols = this.cols.filter((c) => c.id !== id);
    }

    /* How many tasks a column holds, hidden by a filter or not. */
    count(colId) {
        let n = 0;
        for (const t of this.tasks)
            if (t.Column === colId) n++;
        return n;
    }

    /* The tasks of a column in the order they are shown. */
    inColumn(colId) {
        return this.tasks
            .filter((t) => t.Column === colId)
            .sort((a, b) => (a.Order - b.Order) || (a.Id - b.Id));
    }

    /*
     * What a drop and the two arrow buttons share. `before` is the task the
     * moved one lands *above*, or null for the end of the column -- which is
     * what the buttons always pass, and a drop below the last card too.
     *
     * The column is rebuilt as a list and renumbered from zero, so `Order`
     * stays dense and the file stays readable. The column it *left* keeps
     * its gaps: `Order` is only a sort key, and renumbering a column nobody
     * touched would rewrite rows for nothing.
     *
     * Answers whether anything changed. An edit that changes nothing is not an
     * edit: a card dropped back where it already was must not mark the board
     * or rebuild it.
     */
    move(id, target, before = null) {
        const t = this.taskById(id);
        if (!t || !this.colDef(target)) return false;

        const order = this.inColumn(target).filter((one) => one.Id !== id);

        let at = order.length;
        if (before !== null) {
            for (let i = 0; i < order.length; i++)
                if (order[i].Id === before) { at = i; break; }
        }
        order.splice(at, 0, t);

        if (t.Column === target) {
            const was = this.inColumn(target);
            if (was.length === order.length && was.every((one, i) => one.Id === order[i].Id))
                return false;
        }

        t.Column = target;
        for (let i = 0; i < order.length; i++) order[i].Order = i;
        return true;
    }
}
