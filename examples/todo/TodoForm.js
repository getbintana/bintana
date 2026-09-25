/*
 * A to-do list, and it is the smallest window in this tree whose list is
 * filled by the program.
 *
 * An entry with a `+` in it, a list of check boxes, a task struck through when
 * it is ticked, and a `...` on each row that drops its options: between them
 * they are the shapes a checked list always has, and they are what this file is
 * worth reading for.
 *
 * ## The two doors into the field
 *
 * `TxtNew` carries `Icon: "list-add-symbolic"` -- the icon sits *inside* the
 * entry, on the right, and clicking it raises `IconClick`.  Enter raises
 * `Activate`.  Both are ordinary `TextBox` events, so adding a task is two
 * one-line handlers and the icon costs a `.form` property rather than a button
 * beside the field.
 *
 * ## The tick lives in the data
 *
 * The row is a widget with a `CheckButton` in it, and the task is
 * `{ Text, Done }` in `this.todos`.  The widget shows the data and never *is*
 * it: `task.Done` is what the strike-through is worked out from, and the
 * handler reads `tick.Active` back because GTK has already flipped it -- so
 * the round trip is real, out to GTK and back, and not an assumption about
 * what a click does.
 *
 * That is deliberate rather than tidy.  The moment a list filters, sorts or
 * rebuilds its rows, a tick that lives only in the widget is the wrong row's
 * tick -- which is the single most common bug in every toolkit that offers a
 * checked list.  Keep the answer in your data, show it when the row is built,
 * and nothing the list does to the rows can lie.
 *
 * ## The strike-through is Pango markup, and escaping it is not cosmetic
 *
 * `Label.Markup = true` says `Text` is markup, and Pango's is `<s>...</s>`.
 * The catch is that markup that does not parse **leaves the old text alone and
 * warns on the console** -- no exception, no blank line in a log -- so a task
 * called `R&D <urgent>` would draw a tick and no words at all.  `Text.Escape`
 * is what keeps a person's own `<` and `&` from being read as tags.
 *
 * ## A row built in code hears its events through `On`
 *
 * A `RowList` row is a widget of its own, and there is a number of rows nobody
 * wrote down, so the rows are built in `row()`.  A control built in code has no
 * name to write a `<Name>_<Event>` method for -- two ticks would both be
 * `Tick_Click` -- so the handler goes on the control with `On`, closes over its
 * task and its label, and is deleted with the widget.  Nothing is left on the
 * form to keep in step.
 *
 * ## The options are a `Popover`, and a `Menu` would have been the wrong tool
 *
 * Each row carries a three-dots button, and what it drops is a `Popover` whose
 * content is three ordinary `Button`s.  A `Menu` is the other road and it does
 * not fit here: a menu item's handler is looked up on the *form* by name, and
 * there is one row too many for that -- the three options would have to be
 * methods that find their row again, when `On` closes over the task and goes
 * with it, exactly as the tick does.
 *
 * `Popup(kebab)` opens it over the button and `Close()` puts it away.  Where
 * the row sits in the list is not something it knew when it was built, so which
 * of the two ends is a real move is asked in the `Open` handler -- and moving
 * a row moves what is in `this.todos` with it, because what the list shows is
 * never the truth.
 *
 * The list lives in memory and nothing writes it anywhere: this example is
 * about the list, and `examples/kanban` is the one that keeps a file.
 *
 * Run it with `./build/bintana examples/todo`.
 */
"use strict";

class TodoForm extends Form {

    /* The whole of the state: what is on the list.  No row widget is kept here
     * because nothing ever has to find one again -- the handlers they were
     * built with close over them. */
    todos = [];

    /* Chosen in `Form_Open`, where there is a theme to ask. */
    kebab = "";

    Form_Open() {
        /*
         * The three dots, and the name every desktop also has behind it.
         * `Application.HasIcon` is the question that *renders* the icon, so a
         * name the theme lists and does not draw does not get through -- and a
         * blank square is the failure that hides best.
         */
        this.kebab = ["view-more-symbolic", "open-menu-symbolic"]
                         .find((name) => Application.HasIcon(name)) || "";

        this.TxtNew.SetFocus();
    }

    /* Enter in the field, and the `+` inside it. */
    TxtNew_Activate()  { this.add(); }
    TxtNew_IconClick() { this.add(); }

    add() {
        const text = this.TxtNew.Text.trim();
        if (!text) return;

        const task = { Text: text, Done: false };
        this.todos.push(task);

        this.Todos.Add(this.row(task));
        this.Todos.Reveal(this.Todos.Count - 1);

        this.TxtNew.Text = "";
        this.TxtNew.SetFocus();
    }

    /* One row: a tick, its words, and the options it drops. */
    row(task) {
        const row = new Panel();
        row.Arrangement = "Horizontal";
        row.Spacing = 8;
        row.Margin  = 6;
        row.HAlign  = "Fill";
        row.HExpand = true;

        const words = new Label();
        words.HAlign  = "Fill";
        words.HExpand = true;
        words.VAlign  = "Center";
        words.Wrap    = true;
        this.showTask(task, words);

        const tick = new CheckButton();
        tick.VAlign = "Center";
        /* `Active` first, so the assignment is not heard as a click: `Click` is
         * GTK's `toggled`, and a `.form` raises it while a form is still being
         * loaded for exactly this reason. */
        tick.Active = task.Done;
        tick.On("Click", () => {
            task.Done = tick.Active;
            this.showTask(task, words);
        });

        /* The popover is a child of the row like anything else -- invisible,
         * and it takes no room -- so it is deleted when the row is. */
        const pop = new Popover();
        pop.Style = "menu";

        const up   = this.choice(pop, "Move up",   () => this.move(task, row, -1));
        const down = this.choice(pop, "Move down", () => this.move(task, row, +1));
        const kill = this.choice(pop, "Delete",    () => this.remove(task, row));

        pop.On("Open", () => {
            const at = this.Todos.Children.indexOf(row);
            up.Enabled   = at > 0;
            down.Enabled = at >= 0 && at < this.Todos.Count - 1;
        });

        const options = new Panel();
        options.Arrangement = "Vertical";
        options.Spacing = 2;
        options.Add(up);
        options.Add(down);
        options.Add(kill);
        pop.Add(options);

        const kebab = new Button();
        kebab.Icon = this.kebab;
        kebab.Style = "flat";
        kebab.Tooltip = "Options";
        kebab.VAlign = "Center";
        kebab.On("Click", () => pop.Popup(kebab));

        row.Add(tick);
        row.Add(words);
        row.Add(kebab);
        row.Add(pop);
        return row;
    }

    /* One line of the options.  It closes the popover before it acts: the
     * click is *inside* it, so nothing else is going to. */
    choice(pop, text, run) {
        const button = new Button();
        button.Text   = text;
        button.Style  = "flat";
        button.HAlign = "Fill";
        button.On("Click", () => { pop.Close(); run(); });
        return button;
    }

    /* A step along the list, and the data moves with it.  `Reorder` counts the
     * siblings *without* the one moving, which is the same number as its place
     * for a single step either way. */
    move(task, row, delta) {
        const at = this.Todos.Children.indexOf(row);
        const to = at + delta;
        if (at < 0 || to < 0 || to >= this.Todos.Count) return;

        this.Todos.Reorder(row, to);
        this.todos.splice(at, 1);
        this.todos.splice(to, 0, task);
    }

    /* Both places a task lives, and the row carries its popover out with it. */
    remove(task, row) {
        const at = this.todos.indexOf(task);
        if (at >= 0) this.todos.splice(at, 1);
        row.Delete();
    }

    /* What a task looks like right now: the sentence, struck through when the
     * task is done. */
    showTask(task, words) {
        const said = Text.Escape(task.Text);
        words.Markup = true;
        words.Text = task.Done ? `<s>${said}</s>` : said;
    }

}
