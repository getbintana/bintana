/*
 * A kanban board, and the point of it is that the columns are data.
 *
 * Columns side by side, each a `Scroller` holding cards, with the cards
 * draggable between them and a row of buttons that does the same for
 * whoever does not drag. Everything about it is ordinary vocabulary —
 * `DragData`/`AcceptDrop` plus `Drop`, `Visible` for filtering, a `Record`
 * per task and one JSON file — arranged into the shape every team board has.
 *
 * ## The columns are built, not drawn, and their handlers live on them
 *
 * `Board.form` holds an empty `Cols` scroller. Each column — a header with
 * a title, a count and two flat buttons, over a scroller holding the cards
 * — is assembled in `buildColumn`, because a `.form` cannot hold a number
 * of columns nobody knows yet.
 *
 * Every handler for those widgets is `On(event, fn)`: `del.On("Click", …)`,
 * `list.On("Drop", …)`, `card.On("MouseDown", …)`. That is the whole of the
 * bookkeeping. It used to be `this[name + "_Drop"] = …`, a handler assigned
 * onto the *form* under the widget's name — which works, and costs two
 * arrays of names and two loops deleting them, because a column that is
 * gone must stop answering for widgets that no longer exist. Deleting the
 * widget deletes its handlers now, and the names the columns still carry
 * are for reading a `Dump()`, not for reaching a handler.
 *
 * ## A column is a Scroller and not a RowList, and that is measured
 *
 * It was a `RowList` first: selection, `Filter` and `Activate` for free.
 * And no drag ever started in it — pressing a card selected it and nothing
 * else, while the same gesture from a bare `Button` dropped fine. A probe
 * with one row (`/tmp` never kept it) said it in two lines: `SELECTED`,
 * and no `DROPPED`. The `GtkListBox` claims the press for its own
 * selection and cancels the drag source's gesture, exactly the VTE shape
 * in AGENTS.md — a widget that handles the press keeps the sequence, in
 * either phase. A `Scroller` claims nothing, so the card's `DragData`
 * survives the press. What the list gave for free is written by hand
 * instead: selection is a `MouseDown` plus a `kanban-sel` class, filtering
 * sets `Visible`, and editing is a double click.
 *
 * ## Both scrollers are arranged, and that is what makes the board fill
 *
 * A `Scroller`'s slot is a `Fixed` unless it is told otherwise, and a
 * `Fixed` sizes its content at its natural size: measured, before this was
 * understood, a column of cards was **131 wide in a 300-wide view** and the
 * board's row of columns stayed **924x420 inside a 1376x720 one** — the
 * board grew and the columns did not. `Fill` had nothing to fill, since a
 * scroller's slot has no design size for an anchor to keep a gap against.
 * The first version answered it with arithmetic: a strip whose `Width` was
 * `n * COLW + (n - 1) * 12`, a card declared `COLW - 12`, and a height that
 * simply stayed at the 420 it was born with.
 *
 * None of that is here, because **`Arrangement` on a `Scroller` makes its
 * slot a box**, and a box stretches an expanding child across and scrolls
 * it along. `Cols` is arranged `Horizontal` in the `.form`, so the columns
 * are its children — no strip — and a column with `VExpand` is as tall as
 * the board however the window is resized; a column's own scroller is
 * arranged `Vertical`, so a card with `HExpand` is as wide as the column
 * and the cards below the fold scroll. Measured after: a card is **258 wide**
 * inside a column whose cards area is 288 — the 300 less the ground's own
 * padding — and a column is **628 tall** in an 820-tall window against 408 in
 * the 600 it opens at, with nothing measuring anything.
 *
 * `COLW` stays 300 all the same, and that is a decision rather than a
 * limit: a board's column is a fixed width in Trello, in Jira and on every
 * whiteboard, and more columns than fit scroll the board sideways — which
 * is why `Cols` is a scroller at all.
 *
 * ## A drop lands where it was dropped
 *
 * `Drop(data, x, y)` carries the task id as a string **and the point**, in
 * the coordinates of the widget that accepted it — the column's scroller.
 * `card.Bounds(list)` answers in that same space, so which card a drop is
 * over is a comparison and nothing more: no `ScrollY` added, no rectangle
 * remembered from before the gesture. That is the whole of `landingBefore`,
 * and it is what makes a drop *place* a card rather than append it — which
 * is what this window did first, on the belief that the position would have
 * to be measured mid-gesture.
 *
 * Two things fall out of it, both of them in that function:
 *
 *   - **it answers a task id, not a row number.** A filter hides cards
 *     without taking them out of the column, so the third card *shown* can
 *     be the seventh the column holds; a name survives that and an index
 *     does not. The moved card lands immediately above whatever card the
 *     drop pointed at, and the hidden ones keep the neighbours they had.
 *   - **the midpoint decides**, not the top edge: above half a card is
 *     *before it*, below is *after it*, which is where every list with a
 *     drop indicator puts the line.
 *
 * A drop inside the card's own column is a reorder and is nothing special —
 * the same list, rebuilt with it somewhere else. A drop that changes nothing
 * saves nothing: `moveTask` compares the order it worked out against the one
 * the column already has and returns.
 *
 * The `◀ ▶` buttons move the selection one column at a time and **append**,
 * because a button has no point to carry. They are the accessible half of
 * the verb, and the half a test can press.
 *
 * **What this shows while you drag.** A target hears about the drag before
 * the drop — `DragEnter`/`DragOver` carry the same point `Drop` will, and
 * `DragLeave` says it went — so the column lights up (`kanban-drop` on the
 * box) and a line (`DropLine_<id>`, a 4px panel) sits where `landingBefore`
 * says the card would land. The dragged card greys itself: `DragBegin` sets
 * `Opacity`, `DragEnd` puts it back, dropped or refused. The placement
 * was exact and invisible until the button came up, and now it is shown.
 *
 * ## Each list keeps its own rows
 *
 * Every view holds `rows`, the task ids in row order, parallel to its
 * scroller's children. Four places keep both in step — rebuild, add, delete,
 * move — and refilling instead would take the selection, which is the row
 * being edited (`examples/clients` measurement 2, met again here). One
 * predicate, `shows`, decides both what filtering hides and what the
 * counters claim; two copies is how a list says *2 of 5* while showing
 * three.
 *
 * ## Deleting a column means emptying it first
 *
 * Decided out loud rather than discovered: a column with cards in it refuses
 * the delete with the count, naming where its cards have to go. Moving them
 * elsewhere unasked would be the program rearranging somebody's board, and
 * deleting them along with it would be a bulk delete behind a singular
 * question. The check is `columnDeletable`, so the rule is one function and
 * the dialog only asks once it holds.
 *
 * ## The file holds user data, not prose
 *
 * `kanban.json` lives in `Application.ConfigDirectory` (a project directory
 * may be installed read-only) and is written on every change — `File.Save`
 * is atomic, so saving often is safe. Column titles and task texts are
 * stored raw and shown raw: they are what somebody typed, and running them
 * through the catalogue on the way in would bake today's language into
 * tomorrow's file. The seed's three titles go through `Locale.Text` once,
 * when there is no file yet, and from then on they are data like any
 * renamed one.
 *
 * ## What else is worth reading for
 *
 *   - rebuilding assigns nothing that raises: every property set while a
 *     column or a card is built lands on a fresh widget with no handler
 *     for it, so there is no `showing` guard here — `examples/clients`
 *     needs one because its `show()` writes into live controls, and that
 *     is the difference worth noticing before copying either shape.
 *   - the priority filter compares **by index**: a combo's `Items` are prose
 *     and move in translation (`examples/files`).
 *   - the meta line's colour is `Foreground` set from code — a colour the
 *     program worked out, which is what the per-widget exception is for —
 *     while the card's border is a class in `app.css`, which is what the
 *     sheet is for.
 *
 * Run it with `./build/bintana examples/kanban`.
 */
"use strict";

/* One column is 300 wide. Fixed like Trello's, and fixed on purpose (see
 * the header): what a column *holds* follows the column, so this is the one
 * number in the layout and nothing is derived from it. */
const COLW = 300;

class Board extends Form {

    /* The board: column defs `{ id, title }` in order, and the tasks. */
    cols  = [];
    tasks = [];

    /* The live columns: `{ id, box, list, rows, cards, lblTitle, lblCount }`,
     * with `list` the column's own `Scroller` — the cards are in it, see
     * `buildColumn` — `rows` the task ids in row order, and `cards` the card
     * widgets by task id. */
    views = [];

    /* The selection: a column id and a task id, or nulls. */
    selCol  = null;
    selTask = null;

    /* What the filter answers from, read off the controls once per change
     * rather than once per row: the handler runs inside GTK's layout. */
    needle    = "";
    priFilter = 0;
    priNames  = [];

    /* A note from loading (rows left out, lenient reads), shown in the
     * status line until the next change rewrites it. */
    note = "";

    /* Set once there is a board: the guard the `.form` loader needs, since
     * it assigns before `Form_Open`. */
    loaded  = false;

    nextTaskId = 1;
    nextColN   = 1;
    path       = "";

    Form_Open() {
        const was = Settings.Get("size", null);
        if (was) this.Resize(was.width, was.height);

        this.path = File.Join(Application.ConfigDirectory, "kanban.json");
        this.priNames = new Task().PropertyOptions("Priority");

        this.load();
        this.loaded = true;
        this.buildColumns();
        this.rebuildAll();
        this.refilter();
        this.updateActions();
    }

    Form_Close() {
        Settings.Set("size", { width: this.Width, height: this.Height });
    }

    /* --- loading, seeding, saving ---------------------------------------- */

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

    /* --- the columns, built from data ------------------------------------- */

    buildColumns() {
        this.Cols.Clear();
        this.views = [];
        for (const c of this.cols) this.views.push(this.buildColumn(c));
    }

    buildColumn(c) {
        const id = c.id;

        /* `Cols` is a `Scroller` arranged `Horizontal`, so a column is a
         * child of a row and not of a drawing surface: `Width` is its floor,
         * `VExpand` claims the height the row was given, and there is no
         * coordinate anywhere. */
        const box = new Panel();
        box.Name = "ColBox_" + id;
        box.Arrangement = "Vertical";
        box.Spacing = 6;
        box.Style = "kanban-column";
        box.Width = COLW;
        box.VExpand = true;
        box.VAlign = "Fill";
        this.Cols.Add(box);

        const head = new Panel();
        head.Name = "ColHead_" + id;
        head.Arrangement = "Horizontal";
        head.Spacing = 4;
        box.Add(head);

        const title = new Label();
        title.Name = "ColTitle_" + id;
        title.Text = c.title;
        title.Style = "heading";
        title.HExpand = true;
        title.Ellipsize = true;
        title.VAlign = "Center";
        head.Add(title);

        const count = new Label();
        count.Name = "ColCount_" + id;
        count.Style = "dim-label caption";
        count.VAlign = "Center";
        head.Add(count);

        const ren = new Button();
        ren.Name = "ColRen_" + id;
        ren.Icon = "document-edit-symbolic";
        ren.Style = "flat";
        ren.Tooltip = Locale.Text("Rename column");
        ren.On("Click", () => this.renameColumn(id));
        head.Add(ren);

        const del = new Button();
        del.Name = "ColDel_" + id;
        del.Icon = "edit-delete-symbolic";
        del.Style = "flat";
        del.Tooltip = Locale.Text("Delete column");
        del.On("Click", () => this.deleteColumn(id));
        head.Add(del);

        /* The cards go straight into the scroller, which is arranged
         * `Vertical` — that is the whole of what makes them as wide as the
         * column (see the header). One widget rather than a scroller over a
         * panel, so there is one drop target: the empty room under the last
         * card belongs to it, and a drop there lands like any other. */
        const list = new Scroller();
        list.Name = "ColList_" + id;
        list.Arrangement = "Vertical";
        list.Scrollbars = "Vertical";
        list.HExpand = true;
        list.VExpand = true;
        /* `Height` and not `MinHeight`: in a box the floor is the declared
         * size, and a `MinHeight` here would read back and do nothing. */
        list.Height = 120;
        list.AcceptDrop = true;
        list.On("Drop", (data, x, y) => this.dropOn(id, data, y));
        list.On("DragEnter", (data, x, y) => this.dragEnter(id, data));
        list.On("DragOver", (data, x, y) => this.dragOver(id, data, y));
        list.On("DragLeave", () => this.dragLeave(id));
        box.Add(list);

        return { id: id, box: box, list: list, rows: [], cards: {},
                 lblTitle: title, lblCount: count, line: null, hot: false };
    }

    viewOf(id) {
        for (const v of this.views)
            if (v.id === id) return v;
        return null;
    }

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

    /* --- the columns, and the rows parallel to them ------------------------ */

    rebuildAll() {
        const sorted = this.tasks.slice().sort((a, b) => (a.Order - b.Order) || (a.Id - b.Id));
        for (const v of this.views) {
            v.list.Clear();
            v.rows = [];
            v.cards = {};
            v.line = null;
            v.hot = false;
            for (const t of sorted)
                if (t.Column === v.id) this.addCard(v, t);
            /* The insertion line, last child and hidden: DragOver moves it
             * with Reorder and shows it. Recreated here because Clear took
             * it, which is also what hides it after a drop. */
            const line = new Panel();
            line.Name = "DropLine_" + v.id;
            line.HExpand = true;
            line.Height = 4;
            line.Style = "kanban-drop-line";
            line.Visible = false;
            v.list.Add(line);
            v.line = line;
        }
        this.restoreSelection();
    }

    /* A card is a plain panel built by hand, in the shape `examples/files`
     * builds its rows — three labels and a class, which is not worth a file
     * of its own.
     *
     * It was a `TaskCard` component first, and what stopped that has since
     * been answered: a component added from code keeps *itself* as its event
     * target (only the `.form` loader rebinds one to its host), so a
     * `TaskCard_MouseDown` written here never fired and prodding a handler
     * onto each instance was the only way in. `On` is the way in now — a
     * component's `Emit` finds the control's own handlers before the
     * `<name>_<event>` road, so `card.On("Picked", …)` here hears a
     * `this.Emit("Picked", …)` inside the card. Measured with a two-file
     * probe, both halves: the component's internal handler fires on the
     * component, and the `Emit` reaches the host. So a card drawn in the
     * designer is open to whoever wants one; this one is three labels. */
    addCard(v, t) {
        const id = v.id;
        const taskId = t.Id;

        const card = new Panel();
        card.Name = "Card_" + taskId;
        card.Arrangement = "Vertical";
        /* `HExpand` is the one that matters: in a box `Fill` only says what
         * to do with room already claimed, and claiming is `Expand`'s. Take
         * it away and the card sits at its content width however wide the
         * column is. The width itself is nobody's arithmetic — the column is
         * a scroller arranged as a column, so a card is the view's width
         * less its own margin, at every window size. */
        card.HAlign = "Fill";
        card.HExpand = true;
        card.Margin = 6;
        card.Spacing = 2;
        card.Style = "kanban-card";
        card.Cursor = "Grab";
        card.DragData = String(taskId);
        card.On("MouseDown", () => this.select(id, taskId));
        card.On("DblClick", () => this.editSelected());
        /* Travelling: greyed while in the air, put back when the drag ends
         * -- dropped or refused. */
        card.On("DragBegin", () => { card.Opacity = 0.45; card.Cursor = "Grabbing"; });
        card.On("DragEnd", () => { card.Opacity = 1; card.Cursor = "Grab"; });

        const title = new Label();
        title.Font = "Bold";
        title.HExpand = true;
        title.Lines = 3;
        title.Wrap = true;
        title.Text = t.Title;
        card.Add(title);

        const meta = new Label();
        meta.Style = "dim-label caption";
        meta.Text = this.metaFor(t);
        meta.Foreground = this.toneFor(t);
        card.Add(meta);

        const notes = new Label();
        notes.HExpand = true;
        notes.Lines = 2;
        notes.Style = "dim-label caption";
        notes.Wrap = true;
        notes.Text = t.Notes;
        card.Add(notes);

        v.list.Add(card);
        v.rows.push(taskId);
        v.cards[taskId] = card;
    }

    /* Priority and date on one line, user data shown raw. The overdue flag
     * is the record's (`Task.Overdue`), so the label never works it out. */
    metaFor(t) {
        const due = t.Due ? Locale.Date(t.Due) : Locale.Text("No date");
        if (t.Overdue)
            return Locale.Text("{0} · {1} · overdue", t.Priority, due);
        return Locale.Text("{0} · {1}", t.Priority, due);
    }

    /* A colour the program worked out — overdue first, then the priority —
     * so it goes through `Foreground` and not through a class. `""` is the
     * theme's own ink. */
    toneFor(t) {
        if (t.Overdue) return "#c01c28";
        if (t.Priority === "Urgent") return "#c01c28";
        if (t.Priority === "High") return "#e66100";
        if (t.Priority === "Medium") return "#1c71d8";
        return "";
    }

    /* Selection is a class, not a row number: the lists are plain panels
     * and the highlight is `kanban-sel` on the card (see `app.css`). */
    select(colId, taskId) {
        if (!this.loaded) return;
        if (this.selTask !== null) {
            const old = this.cardOf(this.selTask);
            if (old) old.Style = "kanban-card";
        }
        this.selCol = colId;
        this.selTask = taskId;
        const card = this.cardOf(taskId);
        if (card) card.Style = "kanban-card kanban-sel";
        this.updateActions();
    }

    cardOf(taskId) {
        for (const v of this.views)
            if (v.cards[taskId]) return v.cards[taskId];
        return null;
    }

    restoreSelection() {
        const t = this.selTask === null ? null : this.taskById(this.selTask);
        if (!t) {
            this.selCol = null;
            this.selTask = null;
            this.updateActions();
            return;
        }
        this.selCol = t.Column;
        const card = this.cardOf(t.Id);
        if (card) card.Style = "kanban-card kanban-sel";
        this.updateActions();
    }

    updateActions() {
        const t = this.selTask === null ? null : this.taskById(this.selTask);
        const at = t ? this.colIndex(t.Column) : -1;

        this.BtnLeft.Enabled = t !== null && at > 0;
        this.BtnRight.Enabled = t !== null && at >= 0 && at < this.cols.length - 1;
        this.BtnEdit.Enabled = t !== null;
        this.BtnDel.Enabled = t !== null;
        this.LblSel.Text = t ? t.Title : Locale.Text("No task selected");
    }

    /* --- moving ------------------------------------------------------------ */

    moveSelected(dir) {
        const t = this.selTask === null ? null : this.taskById(this.selTask);
        if (!t) return;

        const to = this.colIndex(t.Column) + dir;
        if (to < 0 || to >= this.cols.length) return;
        this.moveTask(t.Id, this.cols[to].id);
    }

    BtnLeft_Click()  { this.moveSelected(-1); }
    BtnRight_Click() { this.moveSelected(1); }

    /* What a drop and the two arrow buttons share. `before` is the task the
     * moved one lands *above*, or null for the end of the column — which is
     * what the buttons always pass, and a drop below the last card too.
     *
     * The column is rebuilt as a list and renumbered from zero, so `Order`
     * stays dense and the file stays readable. The column it *left* keeps
     * its gaps: `Order` is only a sort key, and renumbering a column nobody
     * touched would rewrite rows for nothing. */
    moveTask(id, target, before = null) {
        const t = this.taskById(id);
        const cdef = this.colDef(target);
        if (!t || !cdef) return false;

        const order = [];
        for (const one of this.tasks)
            if (one.Column === target && one.Id !== id) order.push(one);
        order.sort((a, b) => (a.Order - b.Order) || (a.Id - b.Id));

        let at = order.length;
        if (before !== null) {
            for (let i = 0; i < order.length; i++)
                if (order[i].Id === before) { at = i; break; }
        }
        order.splice(at, 0, t);

        /* An edit that changes nothing is not an edit: a card dropped back
         * where it already was must not mark the board or rebuild it. */
        if (t.Column === target) {
            let same = true;
            const was = this.viewOf(target);
            if (!was || was.rows.length !== order.length) same = false;
            else for (let i = 0; i < order.length; i++)
                if (was.rows[i] !== order[i].Id) { same = false; break; }
            if (same) return false;
        }

        t.Column = target;
        for (let i = 0; i < order.length; i++) order[i].Order = i;

        this.selCol = target;
        this.selTask = id;
        this.save();
        this.rebuildAll();
        this.refilter();
        return true;
    }

    dropOn(colId, data, y) {
        if (!this.loaded) return;
        /* **A drop is not a leave.** Nothing follows a `Drop` -- the target's
         * own `DragLeave` is delivered during the *next* drag, for a column
         * that drag may never go near -- so the wash and the line are put out
         * here, or they would sit on the column until somebody dragged again. */
        this.dragLeave(colId);
        const id = Number(data);
        if (!(id > 0)) return;
        const v = this.viewOf(colId);
        this.moveTask(id, colId, v ? this.landingBefore(v, y, id) : null);
    }

    /* The payload is a task id as a string, and anything else is refused:
     * returning false answers GDK_ACTION_NONE, so the cursor shows it and
     * Drop never fires. */
    dragId(data) {
        const n = Number(data);
        return n > 0 ? n : 0;
    }

    /* No `false` here, although it reads like the place for one: **the veto is
     * `DragOver`'s**. GTK raises a `motion` at the same point immediately after
     * every `enter`, and that one sets the action again -- measured, a target
     * refusing only in `DragEnter` receives the drop anyway. So this one only
     * lights the column, and `dragOver` below is what refuses. */
    dragEnter(colId, data) {
        if (!this.loaded) return;
        const v = this.viewOf(colId);
        if (!v || !this.dragId(data)) return;
        if (!v.hot) {
            v.hot = true;
            v.box.Style = "kanban-column kanban-drop";
        }
    }

    /* The line goes where the drop would land: immediately above `before`,
     * or past the last card. `Reorder` counts children without the line,
     * which are the cards in `rows` order, so the index is the position of
     * `before` in `rows` -- or the end when there is none. */
    dragOver(colId, data, y) {
        if (!this.loaded) return false;
        const v = this.viewOf(colId);
        const moving = this.dragId(data);
        if (!v || !moving || !v.line) return false;
        if (!v.hot) {
            v.hot = true;
            v.box.Style = "kanban-column kanban-drop";
        }
        const before = this.landingBefore(v, y, moving);
        let at = 0;
        for (const rid of v.rows) {
            if (before !== null && rid === before) break;
            at++;
        }
        v.list.Reorder(v.line, at);
        v.line.Visible = true;
    }

    dragLeave(colId) {
        const v = this.viewOf(colId);
        if (!v) return;
        v.hot = false;
        v.box.Style = "kanban-column";
        if (v.line) v.line.Visible = false;
    }

    /* Which card a drop lands above, among the ones that are *shown*.
     *
     * `Drop(data, x, y)` carries the point in the coordinates of the widget
     * that accepted it — the column's scroller — and `Bounds(v.list)` answers
     * in that same space, so the two compare with no arithmetic of ours.
     * Measured with a real pointer on a scrolled column, which is the only
     * way to see it: with the list scrolled down, the drop arrived at `y=168`
     * and the cards above the view read `Y: -293, -206, -119, -32` while the
     * ones in it read `55, 142, 229` — so the scroll is already in both
     * numbers and adding `ScrollY` would be counting it twice.
     *
     * **It answers a task id and not an index**, and that is the filter's
     * doing: hiding a card does not take it out of the column, so the third
     * card *shown* can be the seventh the column holds. An id names a place
     * in the column's own order, which is the thing being changed — measured
     * with four of nine hidden, the moved card landed where it was pointed
     * and every hidden one kept the neighbour it had.
     *
     * The `Visible` guard is not belt and braces: a hidden card measures
     * **0x0 at the origin**, so its rectangle is not a stale one to be
     * compared against — it is a rectangle every point in the column is
     * below.
     *
     * The midpoint and not the top edge, because that is where a row stops
     * feeling like *above this one* and starts feeling like *below it* — the
     * same rule every list with a drop indicator uses. */
    landingBefore(v, y, movingId) {
        for (const id of v.rows) {
            if (id === movingId) continue;
            const card = v.cards[id];
            if (!card || !card.Visible) continue;
            const b = card.Bounds(v.list);
            if (y < b.Y + b.Height / 2) return id;
        }
        return null;
    }

    /* --- filtering ---------------------------------------------------------- */

    readFilters() {
        this.needle = this.TxtFind.Text.trim();
        const at = this.CmbPriority.Index;
        this.priFilter = at < 0 ? 0 : at;
    }

    filtering() {
        return this.needle !== "" || this.priFilter !== 0;
    }

    /* The one predicate: hiding a card and every counter ask it, so the
     * columns cannot disagree with the line under them. */
    shows(t) {
        if (this.priFilter !== 0 && t.Priority !== this.priNames[this.priFilter - 1])
            return false;
        return Locale.Matches(t.Title + " " + t.Notes, this.needle);
    }

    /* Filtering hides cards instead of rebuilding them, so the selection
     * and the caret survive every keystroke — `examples/files`' argument,
     * with `Visible` where that example has `Filter`. */
    refilter() {
        if (!this.loaded) return;
        this.readFilters();
        for (const v of this.views) {
            for (const id of v.rows) {
                const t = this.taskById(id);
                const card = v.cards[id];
                if (t && card) card.Visible = this.shows(t);
            }
        }
        this.showCounts();
    }

    TxtFind_Change()  { this.refilter(); }
    CmbPriority_Select() { this.refilter(); }

    TxtFind_IconClick() {
        this.TxtFind.Text = "";
        this.refilter();
    }

    showCounts() {
        let shownTotal = 0;
        for (const v of this.views) {
            let shown = 0;
            for (const id of v.rows) {
                const t = this.taskById(id);
                if (t && this.shows(t)) shown++;
            }
            shownTotal += shown;
            v.lblCount.Text = this.filtering()
                ? shown + "/" + v.rows.length
                : String(v.rows.length);
        }

        const total = this.tasks.length;
        let status = this.filtering()
            ? Locale.Text("{0} of {1} shown", shownTotal, total)
            : Locale.Plural("{0} task", "{0} tasks", total);
        if (this.note) status += " · " + this.note;
        this.LblStatus.Text = status;
    }

    say(text) {
        this.LblStatus.Text = text;
        Timer.After(3000, () => this.showCounts());
    }

    /* --- tasks -------------------------------------------------------------- */

    colTitles() {
        return this.cols.map((c) => c.title);
    }

    BtnNew_Click() {
        TaskDialog.create(this.cols, this.selCol || this.cols[0].id,
                          (data) => this.addTask(data));
    }

    addTask(data) {
        const t = new Task(data);
        t.Id = this.nextTaskId;
        this.nextTaskId++;
        t.Order = this.endOrder(t.Column);
        this.tasks.push(t);
        this.selCol = t.Column;
        this.selTask = t.Id;
        this.note = "";
        this.save();
        this.rebuildAll();
        this.refilter();
        this.say(Locale.Text("Added {0}", t.Title));
    }

    editSelected() {
        const t = this.selTask === null ? null : this.taskById(this.selTask);
        if (!t) return;
        TaskDialog.edit(t, this.cols, (data) => this.applyEdit(t.Id, data));
    }

    BtnEdit_Click() { this.editSelected(); }

    applyEdit(id, data) {
        const t = this.taskById(id);
        if (!t) return;
        const moved = data.Column !== t.Column;
        t.Apply(data);
        if (moved) t.Order = this.endOrder(t.Column);
        this.note = "";
        this.save();
        this.rebuildAll();
        this.refilter();
    }

    BtnDel_Click() {
        const t = this.selTask === null ? null : this.taskById(this.selTask);
        if (!t) return;
        Confirm.ask(Locale.Text("Delete {0}?", t.Title), Locale.Text("Delete"), () => {
            const kept = [];
            for (const one of this.tasks)
                if (one.Id !== t.Id) kept.push(one);
            this.tasks = kept;
            if (this.selTask === t.Id) {
                this.selTask = null;
                this.selCol = null;
            }
            this.note = "";
            this.save();
            this.rebuildAll();
            this.refilter();
            this.say(Locale.Text("Deleted {0}", t.Title));
        });
    }

    /* --- columns ------------------------------------------------------------ */

    BtnAddCol_Click() {
        ColumnDialog.ask(Locale.Text("Name for the column"), "",
                         this.colTitles(), (name) => {
            const id = "c" + this.nextColN;
            this.nextColN++;
            this.cols.push({ id: id, title: name });
            this.note = "";
            this.save();
            this.buildColumns();
            this.rebuildAll();
            this.refilter();
        });
    }

    renameColumn(id) {
        const cdef = this.colDef(id);
        if (!cdef) return;
        const taken = [];
        for (const c of this.cols)
            if (c.id !== id) taken.push(c.title);
        ColumnDialog.ask(Locale.Text("Name for the column"), cdef.title,
                         taken, (name) => {
            cdef.title = name;
            const v = this.viewOf(id);
            if (v) v.lblTitle.Text = name;
            this.note = "";
            this.save();
        });
    }

    /* The rule, in one function so the dialog only asks once it holds: a
     * column with cards in it is not deletable. What the error names is the
     * count, so the way out — move or delete them — is in the sentence. */
    columnDeletable(id) {
        const v = this.viewOf(id);
        if (!v) return { ok: false, count: 0 };
        return { ok: v.rows.length === 0, count: v.rows.length };
    }

    deleteColumn(id) {
        const cdef = this.colDef(id);
        if (!cdef) return;

        /* One column is the floor: a board with nowhere to put a task cannot
         * take one, and `BtnNew_Click` would have no column to offer. */
        if (this.cols.length <= 1) {
            Message.Error(Locale.Text("{0} is the only column, and the board keeps it.", cdef.title));
            return;
        }

        const rule = this.columnDeletable(id);
        if (!rule.ok) {
            Message.Error(Locale.Text("Empty {0} first: move or delete its {1}.",
                                      cdef.title,
                                      Locale.Plural("{0} task", "{0} tasks", rule.count)));
            return;
        }
        Confirm.ask(Locale.Text("Delete {0}?", cdef.title),
                    Locale.Text("Delete"), () => {
            const kept = [];
            for (const c of this.cols)
                if (c.id !== id) kept.push(c);
            this.cols = kept;
            if (this.selCol === id) {
                this.selCol = null;
                this.selTask = null;
            }
            this.note = "";
            this.save();
            this.buildColumns();
            this.rebuildAll();
            this.refilter();
        });
    }
}
