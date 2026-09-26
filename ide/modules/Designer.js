/*
 * The form designer: the canvas, and what a gesture on it means.
 *
 * It edits real controls, not a drawing of controls: Surface holds the actual
 * widgets of the .form, and Glass is a transparent layer on top that keeps the
 * mouse -- which is why clicking a Button selects it instead of pressing it.
 *
 * Events are dispatched to the form that owns the control (MainForm), so the
 * handlers live there and delegate here.
 *
 * What this file is left with is the canvas: what is selected, what a drag or a
 * key does to it, how a control is added and named, the undo history, and
 * reading and writing the `.form`.  The three panels beside it each have a class
 * of their own, and each is a widget the IDE owns and the active designer fills
 * in:
 *
 *   Chrome         what is drawn *over* the form -- outline, handles, guides
 *   ControlTree    what the form is made of, as a tree
 *   PropertyGrid   what one property of the selection is worth
 *   Palette what can be added -- and the IDE's, since it is one palette
 *                  for every open form (see Palette.js)
 */
"use strict";

Namespace("Ide");

/*
 * Which event a double click opens is **asked of the control**, not looked up
 * here.  `EventNames()` answers most-derived first, so its head is the event the
 * control is really about -- `Click` for a Button, `Change` for a TextBox -- and
 * for something that raises none of its own it is Widget's `MouseDown`, which is
 * exactly what the table this replaced used as its fallback.
 *
 * That table was fifteen types written by hand, and five controls were missing
 * from it: `ColorButton`, `FontButton`, `Notebook`, `Switcher` and `RowList` all
 * double-clicked into a mouse handler nobody wanted. Which is the whole argument
 * for the runtime publishing what it knows -- the list could only ever be as
 * current as whoever last added a control remembered to be.
 */

const GRID = 4;                 // moves snap to this grid
/* How far a control that would land on top of another is shifted -- a paste and
 * a palette press both do it, and the number is the same question both times:
 * far enough to see there are two. */
const PASTE_STEP = 12;

const FORM_MIN         = 40;    // px: a form smaller than this cannot be aimed at
const MIN_SIZE = 12;

/*
 * How many rows a list draws for its design-time item when the node does not
 * say, and the most it will draw when it does.
 *
 * Three, because what a drawn list answers is *how tall a row is and where the
 * next thing starts*, and the second row is what proves the first was a row and
 * not the whole list. Android's editor draws ten; ten of anything here is a
 * scroll, and a list that scrolls in the designer hides the form under it.
 */
/* The mark on a component that draws nothing one can recognise. Square, and
 * small enough to leave the type beside it in a box drawn at a component's own
 * size -- which for the smallest of them is a row 30 tall. */
const STANDIN_ICON = 16;

const PREVIEW_ROWS = 3;
const PREVIEW_MAX  = 20;

/* A control the IDE cannot build: a component of the project, whose class lives
 * in the project's process and not in this one. */
const STANDIN_BG    = "#d0cfcc";

/* All a stand-in has: the designer places it and names it, and the component
 * itself owns everything else. */
const STANDIN_PROPS = ["Name", "X", "Y", "Width", "Height"];
/*
 * What surrounds the board.  A `Background` and not a class, which is the
 * exception this project reserves for what a stylesheet cannot say: there is no
 * class in the theme for "the space around a drawing board", and the IDE ships
 * no app.css of its own.  Alpha over whatever is behind, so it darkens the same
 * on a light theme and on a dark one.
 */
const OUTSIDE_COLOR = "rgba(0,0,0,0.13)";

/* How close an edge has to be to snap to another control's. */
const GUIDE_SNAP = 5;

function snap(v) {
    return Math.round(v / GRID) * GRID;
}

Ide.Designer = class Designer {

    /*
     * One designer per open form, each with the canvas of its own tab.  The side
     * panel -- palette, control tree, property grid -- is not passed in: it is
     * the IDE's, shared, because it is chrome about *the selection* and there is
     * one selection, the active tab's.  Whichever designer is showing drives it.
     */
    /**
     * @param {MainForm} ide
     * @param {object} canvas
     */
    constructor(ide, canvas) {
        this.ide      = ide;
        this.surface  = canvas.surface;
        this.glass    = canvas.glass;
        this.view     = canvas.view;      // the Scroller the board sits in
        this.titlebar = canvas.titlebar;  // the decoration, over the board
        this.menubar  = canvas.menubar;   // the form's own bar, under the decoration

        /*
         * What is *outside* the form is the scroller's own background, and the
         * board covers itself with the theme's window colour -- which is what a
         * form is made of, so what is drawn is what will be seen.
         *
         * It used to be two panels on the glass, sized from the glass, moved on
         * every layout.  That worked while the surface stretched to the whole
         * canvas area; once the `Scroller` arrived the board became the size of
         * the *form*, so `glass.Width - form.Width` was zero and the shading was
         * a strip of nothing -- or a sliver, whenever the glass came out a few
         * pixels larger. A colour on the container is the whole of it: it covers
         * whatever is not covered, at any size, and there is nothing to update.
         */
        this.view.Background = OUTSIDE_COLOR;
        this.surface.Style   = "background";

        /* Both are stretched to whatever room the IDE has, which is not the
         * size of the form being drawn.  Anchoring them would show every
         * control resized to that room -- a TextBox declared 380 drawn at 504
         * -- so the canvas would disagree with the coordinates being edited.
         * A drawing board places what is on it exactly as drawn. */
        this.surface.Anchored = false;
        this.glass.Anchored   = false;

        this.path     = null;    // .form abierto
        this.root     = null;    // root node as read, to rewrite it
        this.selection = [];     // the last one is the primary (see get selected)
        this.drag     = null;
        this.band     = null;
        this.dirty    = false;
        this.undoStack = [];
        this.redoStack = [];

        /* What is drawn over the form -- outline, handles, guides, border -- and
         * the panels it is drawn with.  One per designer, like the canvas. */
        this.chrome = new Ide.Chrome(this);

        /* What the form is made of, as a tree: one per designer, because what it
         * shows is this form's controls even though the widget is shared. */
        this.tree = new Ide.ControlTree(this);

        /* And what one property of it is worth, which is the same bargain: a
         * shared widget, filled in by whichever designer is on screen. */
        this.grid = new Ide.PropertyGrid(this);

        /* The glass layer takes focus when clicked, and that is where it gets
         * the keys: Delete, arrows, Escape. */
        this.glass.Focusable = true;

        /* What Ctrl+Insert adds: the last type used. */
        this.tool = PALETTE[0];
        /*
         * What the project's components are, filled in by the IDE once it knows.
         * The palette is `Palette`'s and is offered this list rather than
         * built from it here: an empty one is never what it should show, and the
         * IDE calls `setComponents` and `adopt` immediately after this.
         */
        this.components = [];
    }

    /* --- the project's components -------------------------------------------
     *
     * A component is a class of the *project*, and the designer runs in the
     * IDE's process without it: everything it can say about one it reads off the
     * list the IDE found and off the source.  What the palette does with the
     * list is `Palette`'s.
     */
    /*
     * The project's components, as the IDE found them: [{name, Width, Height}].
     * They are a tab of the palette like any other -- a component exists to be
     * placed, and one that cannot be placed from the palette does not exist as
     * far as the designer is concerned.
     */
    setComponents(list) {
        const names = (list || []).map((c) => c.name).join(",");
        if (names === this.components.map((c) => c.name).join(",")) return;

        this.components = list || [];
        this.showTool();
    }

    isComponent(type) {
        return this.components.some((c) => c.name === type);
    }

    /* --- what a component's class says about itself --------------------------
     *
     * The designer cannot ask an instance: a component's class belongs to the
     * project, and the designer runs in the IDE's own process without it.  What
     * it *can* do is read the class -- `Ide.Classes` does that once per listing,
     * off the same source it read to decide the class was a component at all --
     * and these three are the designer's share of the answer.
     */

    /*
     * A component's own properties: the accessors its source declares, minus the
     * ones the designer owns and puts in front of them itself.
     */
    componentProps(type) {
        return (this.ide.classes.componentProperties(type) || [])
                   .filter((key) => !STANDIN_PROPS.includes(key));
    }

    /* The values one of its properties accepts, or null where it is free-form.
     * Never asked of the stand-in: a Label has an `Align` too, and it is not
     * this one's. */
    componentOptions(type, prop) {
        return this.ide.classes.componentOptions(type, prop);
    }

    /* Which of its properties hold prose, or null where its class does not say
     * -- which is not the same as saying none of them do. */
    componentTexts(type) {
        return this.ide.classes.componentTextProperties(type);
    }

    componentSize(type) {
        const spec = this.components.find((c) => c.name === type);
        return [spec && spec.Width  || COMPONENT_SIZE[0],
                spec && spec.Height || COMPONENT_SIZE[1]];
    }

    /*
     * The palette, which is the IDE's: one widget for every open designer, so
     * what it offers is the project's business and only which button is marked
     * changes hands.  Called on every switch and after every listing, and it is
     * `offer` that decides whether any of that is a rebuild.
     */
    showTool() {
        const palette = this.ide.palette;
        if (!palette) return;

        palette.offer(this.components);
        /* A component that was removed from the project leaves nothing to add. */
        if (!palette.buttons[this.tool]) this.tool = PALETTE[0];
        palette.mark(this.tool);
    }

    /* The form's declared size, which is what the window will measure. */
    formSize() {
        const p = (this.root && this.root.properties) || {};
        return { w: p.Width || 400, h: p.Height || 300 };
    }

    /*
     * What is left of it for the form itself, which is what the canvas draws.
     *
     * `Width` and `Height` are the size of the **window** -- they are handed to
     * `gtk_window_set_default_size` -- and a menu bar is prepended *inside* it,
     * above the surface.  So a form with menus has that much less room than it
     * declares, and until the board showed the bar the designer was drawing it
     * with room its window will not have: a control placed against the bottom
     * edge came out under it.
     *
     * The rule the rest of the file follows from here: **everything says the
     * window's size except this**.  The property grid, the status bar, the form
     * handles and the drag that moves them all read `formSize`; only what the
     * surface is resized to takes the bar off.
     */
    clientSize() {
        const { w, h } = this.formSize();
        return { w, h: Math.max(MIN_SIZE, h - this.menuBarHeight()) };
    }

    /* Nothing when the form has no menus, which is thirty-six of the thirty-nine
     * forms in this tree. */
    menuBarHeight() {
        return this.menubar ? this.menubar.Height : 0;
    }

    /* The canvas, given the room the window will really leave it.  Called
     * wherever that changes: the size was edited, an undo put another one back,
     * or the menus appeared or went away. */
    syncSize() {
        const { w, h } = this.clientSize();
        this.surface.Resize(w, h);
    }

    /*
     * The control's rectangle in the space where the chrome is placed.
     *
     * Measuring against Surface and drawing inside Glass is correct because the
     * two layers are siblings in the same Overlay and share an origin.
     *
     * Bounds and not X/Width: those report what the control *asked for*, and a
     * theme's margins make the face it draws smaller and offset from that -- 17
     * pixels each side on a Button here.  Taking the origin from one and the size
     * from the other is what made the outline sit visibly off its control.
     */
    rectOf(control) {
        const at = control.Bounds(this.surface);
        if (!at) return null;
        return { x: at.X, y: at.Y, w: at.Width, h: at.Height };
    }

    /* --- deshacer ---------------------------------------------------------
     *
     * Snapshots of the serialised tree are kept, not a list of inverse actions:
     * Serialize/BuildChildren already exist, and a snapshot cannot fall out of
     * sync the way a badly written inverse action can.  A form being designed
     * has dozens of controls, not millions.
     */

    snapshot() {
        return JSON.stringify({
            /* The form's own too: resizing it has to be undoable like any
             * other edit -- and so are its menus, which live in the node and
             * not on the surface. */
            properties: (this.root && this.root.properties) || {},
            menus: (this.root && this.root.menus) || [],
            children: this.surface.Children.map((c) => c.Serialize(true)),
            selected: this.selection.map((c) => c.Name),
        });
    }

    /* `before` allows pushing a state captured before the action, which is what
     * a drag needs: the useful snapshot is the one from mouseDown. */
    pushUndo(before, merge) {
        /* Any action closes the edit the grid was grouping. */
        this.grid.closeEdit();

        /*
         * **A run of the same gesture is one edit.** A held arrow key pushed a
         * snapshot per repeat, so a few seconds of nudging filled the 200-entry
         * stack and pushed real history out. The first push of a run keeps the
         * state from before it and the rest ride on that; any other action ends
         * the run by pushing without a key.
         */
        if (merge !== undefined && merge === this.undoMerge) return;
        this.undoMerge = merge;

        this.undoStack.push(before !== undefined ? before : this.snapshot());
        if (this.undoStack.length > 200) this.undoStack.shift();
        this.redoStack = [];
    }

    restore(json) {
        const snap = JSON.parse(json);

        if (snap.properties && this.root) {
            this.root.properties = snap.properties;
            this.syncSize();
        }
        if (this.root) {
            if (snap.menus && snap.menus.length) this.root.menus = snap.menus;
            else                                 delete this.root.menus;
        }
        this.buildSurface({ properties: (this.root && this.root.properties) || {},
                            children: snap.children });

        /* The controls were rebuilt, so the selection is recovered by name and
         * not by reference. */
        const names = snap.selected || [];
        const back  = this.allControls().filter((c) => names.includes(c.Name));
        this.setSelection(back);
    }

    undo() {
        if (this.undoStack.length === 0) return;
        const current = this.snapshot();
        this.restore(this.undoStack.pop());
        this.redoStack.push(current);
        this.undoMerge = undefined;   /* a nudge after this is a new edit */
        this.touch();
    }

    redo() {
        if (this.redoStack.length === 0) return;
        const current = this.snapshot();
        this.restore(this.redoStack.pop());
        this.undoStack.push(current);
        this.undoMerge = undefined;
        this.touch();
    }

    /* --- abrir y guardar -------------------------------------------------- */

    /*
     * The surface lays its children out the way the running form will: a form
     * declared Vertical is a box, and a box's children have no coordinates at
     * all.  Without this the designer showed every elastic form piled at the
     * origin -- which is why the IDE could not open its own MainForm.
     *
     * Setting Arrangement swaps the slot, and GTK only allows that while it is
     * empty, so every rebuild goes through here: clear, arrange, fill.
     */
    buildSurface(root) {
        const want = (root.properties || {}).Arrangement || "Fixed";

        this.surface.Clear();
        if (this.surface.Arrangement !== want) this.surface.Arrangement = want;

        for (const node of root.children || []) this.buildNode(this.surface, node);
    }

    /*
     * One node, and a stand-in when it cannot be built.
     *
     * A project's components are classes of the *project*, and the designer runs
     * in the IDE's process: it has the runtime's widgets and none of the
     * project's.  Refusing to open the form would make a component something one
     * cannot use with the IDE; building a Panel instead would rewrite the
     * component out of the file on the next save.  So the node is kept, shown as
     * itself, and written back as it came.
     */
    buildNode(parent, node) {
        /*
         * What is left behind when it fails matters as much as the stand-in.
         * `AddNode` parents a control *before* applying its properties, so a
         * value the runtime refuses -- a `Style` that is not a class name, a
         * colour that is not one -- throws with a half-built subtree already in
         * the container.  The stand-in then carries the same node, and the next
         * save writes it twice: the controls built before the throw, and the
         * whole node again.  A form of 38 controls came back with 44.
         *
         * So whatever the attempt added comes out before the stand-in goes in.
         */
        const had = parent.Children.length;

        try {
            /*
             * **One level at a time**, and that is the whole of what keeps a
             * stand-in to the node that needed one. `AddNode` builds the node
             * *and its whole subtree* in one call, so a descendant the IDE
             * cannot instantiate -- a component of the project, or of a library
             * it uses -- threw out of the container being built, and the
             * container became the stand-in with every sibling gone. A form
             * whose component sat two levels down opened as a board with one
             * grey `[Panel]` on it. Built shallow and recursed here, the throw
             * is caught where it happened.
             *
             * `true` is "this is a drawing of an application, not one".  Two
             * things follow from it and both are load-bearing here: prose is left
             * as the file wrote it, so a designer running in Spanish cannot bake
             * a translation into a form it saves; and the node's `design` block
             * is applied over the properties, which is how a label whose text the
             * code fills in has something to be laid out by.
             */
            const built = parent.AddNode({ ...node, children: [] }, true);

            /* ...and what a list holds while it is being drawn, which is the
             * other half of the same idea and cannot be a property: see
             * `showItem`. */
            if (node.item) this.showItem(built, node.item);

            for (const child of node.children || []) this.buildNode(built, child);
            return built;
        } catch (e) {
            for (const built of parent.Children.slice(had)) built.Delete();
            return this.standIn(parent, node);
        }
    }

    /* The node, shown as itself and carrying itself: what goes back to the file
     * is what came out of it, plus whatever geometry the user gave it. */
    standIn(parent, node) {
        const props = node.properties || {};
        const tree  = this.ide.classes.componentTree(node.type);

        /*
         * **A component is drawn rather than named when its own `.form` can be
         * read**, which is the same drawing a list makes of its `item` and the
         * same reason it is safe: the widget is a `Component`, and the runtime's
         * serialiser has always written a component as a black box. So what is
         * inside cannot reach the file whatever happens here.
         *
         * A `Component` even when there is nothing to draw, and not the `Label`
         * this used to be: then the two cases end in the same place -- a
         * container that says what it is -- instead of one of them being a
         * different widget with a different set of methods on it.
         *
         * What the designer still cannot do is *run* the component's class, so
         * this shows the half that is declared. A component that paints itself
         * -- `Chart`, `Report`: a `DrawingArea` and a thousand lines -- draws the
         * empty box it really is, and one whose class fills its labels in shows
         * whatever its `design` blocks say. Both are the truth about what the
         * file declares, which is the only thing a designer can be honest about.
         */
        const standIn = Widget.New("Component");
        parent.Add(standIn);

        standIn.Name       = node.name || node.type;
        standIn.__node     = node;
        /*
         * The tint stays even when the component is drawn, and it is the only
         * thing left saying *this one is not yours*: the grey `[Stepper]` box
         * used to say it in words, and a drawing cannot. What is inside belongs
         * to another file and nothing here can edit it, so the surface it sits
         * on says so quietly rather than by refusing to show it.
         */
        standIn.Background = STANDIN_BG;

        if (tree) {
            const root = tree.properties || {};
            if (root.Arrangement) standIn.Arrangement = root.Arrangement;
            if (root.Spacing !== undefined) standIn.Spacing = root.Spacing;
            if (root.Margin  !== undefined) standIn.Margin  = root.Margin;

            /* One deep, the same guard `showItem` makes and for the same
             * reason: a component holding itself would draw for ever. */
            if (!this.showingItem) {
                this.showingItem = true;
                try {
                    for (const child of tree.children || [])
                        this.buildNode(standIn, child);
                } finally {
                    this.showingItem = false;
                }
            }
        }

        /*
         * ...and when the drawing says nothing, the component says what it is.
         *
         * Three cases arrive here and they look identical on the canvas: a type
         * this project has no `.form` for, a component whose form is empty, and
         * **the painted half** -- a `Chart` declares one `DrawingArea` and
         * everything one recognises about it is painted by code the designer
         * cannot run. All three would be a tinted rectangle with nothing in it,
         * which says less than the `[Chart]` box this replaced.
         *
         * So the test is what the drawing *shows*, not what it holds: a subtree
         * with no prose anywhere in it has nothing to recognise, whatever it is
         * made of.
         */
        if (!this.showsAnything(standIn)) {
            standIn.Clear();
            standIn.Arrangement = "Horizontal";
            standIn.Spacing     = 6;
            standIn.Margin      = 6;

            /*
             * The desktop's icon first and ours behind it, which is this tree's
             * rule for every icon and the same pair `Palette` and `ControlTree`
             * already name a component with -- so the canvas, the tree and the
             * palette cannot come to disagree about what a component looks like.
             * A desktop that has neither leaves an empty name and the row is
             * just the type, which is where this started.
             */
            const mark = COMPONENT_ICON.find((n) => Application.HasIcon(n)) || "";
            if (mark) {
                const icon = new Image();
                icon.Icon = mark;
                icon.Resize(STANDIN_ICON, STANDIN_ICON);
                standIn.Add(icon);
            }

            const says = new Label();
            says.Text = node.type;
            standIn.Add(says);
        }

        /* The size the node asks for, or the component's own, or the last
         * resort -- which is what a type nothing here knows is left with. */
        const size = this.isComponent(node.type) ? this.componentSize(node.type)
                                                 : [120, 30];
        standIn.Resize(props.Width || size[0], props.Height || size[1]);
        if (this.isFixed(parent)) standIn.Move(props.X || 0, props.Y || 0);

        return standIn;
    }

    /*
     * Whether anything in this subtree would be read by a person.
     *
     * Prose and nothing else, asked of each control the way the rest of this
     * IDE asks -- `TextProperties()` is what the runtime says holds words. An
     * icon or a drawing is not prose and deliberately does not count: a
     * component that is one `DrawingArea` looks like an empty box until its
     * code runs, and saying so is the honest answer.
     */
    showsAnything(control) {
        for (const c of control.Children || []) {
            for (const key of c.TextProperties())
                if (String(c[key] ?? "").trim()) return true;
            if ("Children" in c && this.showsAnything(c)) return true;
        }
        return false;
    }

    /*
     * A list, drawn with something in it.
     *
     * A list is filled by the program, so in a designer it is an empty box --
     * and a form is laid out *around* one: how tall a row is decides whether
     * what sits under the list collides with it. `item` names a **component**
     * and how many of it to draw, which is Android's `tools:listitem` with the
     * one change this tree's shape forces: pointing at a class rather than at a
     * layout file is what lets the form's own code build the same thing, so the
     * drawing and the program are one widget and not two that drift.
     *
     * Each row is a real `Component` filled from the component's own `.form`,
     * through `buildNode` -- so a component inside the item gets the stand-in it
     * would get anywhere else, and a `.form` that cannot be read draws nothing
     * rather than taking the form down.
     *
     * `SetItem` is what makes the whole thing safe: from then on the runtime's
     * serialiser writes the `item` key and **not** the children, so a save can
     * never turn three drawn rows into three real ones.
     */
    showItem(control, item) {
        if (!control || !("Children" in control)) return false;

        const of = String((item && item.of) || "").trim();
        if (!of) return false;

        const count = Math.min(Math.max(Math.round(Number(item.count) || PREVIEW_ROWS), 1),
                               PREVIEW_MAX);

        /* Marked first and whatever happens next: a container that is showing an
         * item has no children of its own to save, and one that failed to draw
         * the rows still has none. */
        control.SetItem(of, count);

        /* A component that is gone, or whose `.form` cannot be read, draws
         * nothing -- and the list keeps its `item`, so the name survives the
         * save that follows. */
        const root = this.ide.classes.componentTree(of);
        if (!root) return false;

        /*
         * One deep, and said with a counter rather than trusted to the data: a
         * component whose own form holds a list showing *this* component would
         * otherwise draw for ever. Two rows of a row is not a layout question
         * anybody has.
         */
        if (this.showingItem) return false;
        this.showingItem = true;

        try {
            const props = root.properties || {};
            for (let i = 0; i < count; i++) {
                const row = Widget.New("Component");
                control.Add(row);

                if (props.Arrangement) row.Arrangement = props.Arrangement;
                row.Resize(props.Width || 120, props.Height || 30);

                for (const child of root.children || []) this.buildNode(row, child);
            }
        } finally {
            this.showingItem = false;
        }
        return true;
    }

    /*
     * The item a list shows, changed from the grid: the rows go and are drawn
     * again, or go for good when the name is cleared.
     *
     * **Refused on a list that holds controls of its own.** A list whose rows
     * are written down in the `.form` has nothing to preview -- it is already
     * showing what it holds -- and clearing it to draw a drawing would delete
     * somebody's controls. The two states are exclusive by construction, which
     * is also what lets `Item` alone tell the runtime's serialiser that nothing
     * under here is the form's.
     */
    setItem(control, of, count) {
        if (!control || !("Children" in control)) return false;

        if (control.Children.length && !control.Item) {
            Message.Warning("{0} holds controls of its own, so there is nothing to draw an item in.",
                            control.Name);
            return false;
        }

        this.pushUndo();
        control.Clear();
        control.SetItem("", 0);

        if (String(of || "").trim()) this.showItem(control, { of, count });

        this.chrome.position();
        this.grid.fill();
        this.touch();
        return true;
    }

    /*
     * What a container does with a new child, when it is not coordinates.
     *
     * A notebook makes it a page and needs a name for its tab -- which is what
     * the .form could not carry until Tabs existed.  A split has exactly two
     * halves and no third place to put anything, so it is refused before a
     * control is created rather than after, when the runtime would throw.
     *
     * A switcher is the notebook's case exactly: pages, named through `Tabs`,
     * shown one at a time -- so there is no "where the pointer is" to drop onto
     * either.
     */
    /*
     * How this container places a child, which is the only thing every gesture
     * here needs to know: `Coordinates`, `Order`, `Layers`, `Pages`, `Halves`.
     *
     * **Asked of the runtime**, which is the one thing that knows what its slot
     * is. It used to be decided here by class name, and that table is how
     * `Overlay`, `Flow` and `RowList` came to be on the palette while every
     * gesture treated them as boxes: dropping into one raised *this container
     * has no order to give* after the control had already been added. A table of
     * names in the editor is a second list to keep in step, and it was not.
     *
     * No container is `Coordinates`, so the form itself answers for nothing.
     */
    placementOf(container) {
        if (!container || !("Placement" in container)) return "Coordinates";
        return container.Placement || "Coordinates";
    }

    pages(container) {
        return this.placementOf(container) === "Pages";
    }

    split(container) {
        return this.placementOf(container) === "Halves";
    }

    /* A stack: every child has the whole of it, so what a drop chooses is which
     * layer it lands over and `HAlign`/`VAlign` place it. */
    layers(container) {
        return this.placementOf(container) === "Layers";
    }

    /*
     * Whether a child of this one can be moved among its siblings at all -- which
     * is what the arrows, the drag and the drop have to know before they reach
     * for `Reorder`.
     *
     * `Coordinates` is a position and not an order; `Single` is one child and one
     * place, so there is nothing to move it to. Everything else answers: a box
     * and a grid by the line, a stack by the layer, a notebook by the page, a
     * split by the half.
     */
    reorders(container) {
        const places = this.placementOf(container);
        return places !== "Coordinates" && places !== "Single";
    }

    /* Says no, and says why, before anything has been added. */
    canTake(container) {
        if (this.placementOf(container) === "Single" && container.Children.length >= 1) {
            /* One literal, like the split's below. */
            Message.Warning("An aspect frame holds one child.\nPut a container in it to hold more.");
            return false;
        }
        if (this.split(container) && container.Children.length >= 2) {
            /* One literal and not two joined: a msgid built by concatenation
             * extracts as its first piece only, which reads like a valid entry
             * and silently never matches. */
            Message.Warning("A split holds exactly two children.\nPut a container in one of its halves to hold more.");
            return false;
        }
        return true;
    }

    /*
     * A page arrives nameless: GTK draws an empty tab and nothing says which is
     * which, so it gets the name it would have been given anyway.
     *
     * A Switcher gets there first -- a button with nothing written on it is not
     * something anybody can aim at, so the runtime names a page as it arrives --
     * and that default is exactly what this would have written.  Replaced too,
     * then: the control's own name says more than its number does.  A name the
     * .form promised through `Tabs` is left alone, which is the whole point of
     * the test being on the value rather than on how the page got here.
     */
    nameTab(book, page) {
        const tabs = book.Tabs;
        const at   = book.Children.indexOf(page);
        if (at < 0) return;

        const numbered = `Page ${at + 1}`;
        if (tabs[at] && tabs[at] !== numbered) return;

        tabs[at]  = page.Name || numbered;
        book.Tabs = tabs;
    }

    /*
     * How far inside its box a control draws, per side.
     *
     * A theme's margins are the difference between the size asked for and the
     * size drawn, halved: GTK centres what is left.  Taken from sizes rather
     * than positions on purpose -- a control moved this frame still reports the
     * position it had in the last one, while its size is already right.
     */
    inset(control) {
        const drawn = this.rectOf(control);
        if (!drawn || drawn.w <= 0) return { x: 0, y: 0 };

        return {
            x: Math.max(0, Math.round((control.Width  - drawn.w) / 2)),
            y: Math.max(0, Math.round((control.Height - drawn.h) / 2)),
        };
    }

    /*
     * What a control asked for against what GTK gave it.
     *
     * Width and Height are a *request*, i.e. a minimum: a control whose content
     * does not fit comes out bigger and nothing says so -- a label declaring 120
     * drew 433 here and stretched its window by 141 pixels.  Only bigger is worth
     * reporting; smaller is the theme's margins, which every button has and
     * nobody needs told about.
     */
    overflow(control) {
        if (!control) return null;

        const drawn = this.rectOf(control);
        if (!drawn) return null;

        const wide = control.Width  > 0 && drawn.w > control.Width + 1;
        const tall = control.Height > 0 && drawn.h > control.Height + 1;

        return wide || tall ? { drawn, wide, tall } : null;
    }

    /* What the status bar says about it, or nothing at all. */
    overflowNote(control) {
        const over = this.overflow(control);
        if (!over) return "";

        const w = over.wide ? over.drawn.w : control.Width;
        const h = over.tall ? over.drawn.h : control.Height;
        return `   does not fit: draws ${w}x${h}`;
    }

    /*
     * A control as a node.  A stand-in writes back the node it came from, with
     * whatever geometry the user gave it: what the designer could not build, it
     * must not silently replace.
     */
    nodeOf(control, parentIsFixed) {
        if (!control.__node) return control.Serialize(parentIsFixed);

        const node  = control.__node;
        const props = { ...(node.properties || {}) };

        props.Width  = control.Width;
        props.Height = control.Height;
        if (parentIsFixed) { props.X = control.X; props.Y = control.Y; }

        /* The name is the one thing about a stand-in the designer does own:
         * it is what the form's handlers will be named after. */
        return { ...node, name: control.Name, properties: props };
    }

    /* Which way a container runs.  One word for every container -- a Panel
     * arranged as a row and a Split split across answer the same way. */
    runsHorizontal(container) {
        return container.Arrangement === "Horizontal";
    }

    /* Where X/Y mean something.  Anywhere else the parent decides the position,
     * so dragging a control has to reorder it instead of moving it. */
    isFixed(container) {
        return this.placementOf(container) === "Coordinates";
    }

    /* The topmost child of `box` at a point given in the surface's coordinates
     * -- `PickAt` asks in the container's own, and the two differ for anything
     * that is not the surface itself. */
    pickIn(box, x, y) {
        const local = box === this.surface
            ? [x, y]
            : (box.LocalPoint(x, y, this.surface) || [x, y]);

        return box.PickAt(local[0], local[1]);
    }

    /* The container a control sits in, which is not always the surface. */
    parentOf(control, from = this.surface) {
        for (const c of from.Children) {
            if (c === control) return from;
            if ("Children" in c) {
                const deeper = this.parentOf(control, c);
                if (deeper) return deeper;
            }
        }
        return null;
    }

    /* Loads an already-parsed tree, so a tab can be switched without going
     * through disk: the caller is responsible for the in-memory state. */
    loadRoot(root, path) {
        this.path = path;
        this.root = root;

        this.select(null);
        this.undoStack = [];
        this.redoStack = [];
        this.buildSurface(this.root);

        this.syncSize();
    }

    save() {
        if (!this.path) return false;

        File.SaveJson(this.path, this.serializeForm());
        this.root  = this.serializeForm();
        this.dirty = false;
        this.refresh();
        return true;
    }

    /* The current surface as a serializable form tree. The root holds the
     * last load: it stops reflecting the surface the moment the user moves
     * a control, so any per-tab state must rebuild from this instead. */
    /*
     * The file as it will be written.  The designer models the controls and the
     * form's properties; everything *else* the node came in with is carried over
     * untouched -- `menus` above all, which cannot be reconstructed from the
     * surface and which saving used to drop on the floor.
     *
     * Spreading the root first also keeps the key order the file was read in.
     */
    serializeForm() {
        const root = this.root || {};

        return {
            ...root,
            format: "bintana-form/1",
            class: root.class || File.BaseName(this.path || ""),
            properties: root.properties || {},
            children: this.surface.Children.map((c) => this.nodeOf(c, true)),
        };
    }

    touch() {
        this.dirty = true;
        this.refresh();
    }

    refresh() {
        const has = this.selection.length > 0;

        /* Both are cheap and both are no-ops when nothing they show changed,
         * which is what lets them hang off the one call every edit and every
         * selection already makes. */
        this.tree.refresh();
        this.tree.sync();

        /*
         * **Three assignments for twelve places**, and the reason to say it that
         * way is what this replaced. Each of these commands appears four times
         * -- the toolbar button, the Edit menu, the canvas menu and the tree
         * menu -- and their availability used to be written here for the buttons
         * and the context menus, and *again* in `MainForm.refresh` for the menu
         * bar, as `design && designer.selected !== null`. Two files, two
         * expressions, one command: whether they agreed was not answerable by
         * reading either.
         *
         * A command greys out in every place it appears from one assignment
         * because that is what an `Action` is for -- and a control bound to one
         * now *refuses* an `Enabled` of its own, so the second place cannot
         * come back.
         */
        this.ide.ActDelCtl.Enabled = has;
        this.ide.ActRaise.Enabled  = has;
        this.ide.ActLower.Enabled  = has;

        /* Renaming is two things with one condition: the canvas's command
         * renames the selection, the tree's item renames the row the pointer is
         * on. The first is a command only because the canvas menu is assigned
         * to each tab's canvas, and a named item cannot be in two menus. */
        this.ide.ActRenameCtl.Enabled = has;
        if (this.ide.MnuTrRename) this.ide.MnuTrRename.Enabled = has;
        /* Saving is the toolbar's -- one Save for a form and for a .js, enabled
         * by `refresh()` from the same `isDirty()` the menu's Ctrl+S reads.  A
         * second button for it in the design bar answered a question the panel
         * does not ask, and could disagree with the first about whether there
         * was anything to save. */

        /*
         * The decoration over the board, which is what the form will be shown
         * with: its caption if it has one, the class otherwise -- the same order
         * a window title follows, and the class is what a form with no caption is
         * known by -- and its icon, which the window manager shows too.
         *
         * A component is not a window and has no title bar, the same reason the
         * property grid offers it no `Text`.
         */
        const props = (this.root && this.root.properties) || {};

        this.titlebar.Visible = !(this.root && this.isComponent(this.root.class));
        this.titlebar.Text    = props.Text || (this.root && this.root.class) || "";
        this.titlebar.Icon    = props.Icon || "";

        /*
         * And the form's own menu bar, under it.  A component is not a window
         * and has neither -- the same condition, said once.
         *
         * `setSpec` is cheap when nothing changed, which is what lets it hang
         * off a call that also runs on every change of selection; when something
         * did change the bar's height may have, and the canvas is what has to
         * give the room up or take it back.
         */
        if (this.menubar) {
            const menus = this.titlebar.Visible ? this.menus() : [];

            this.menubar.setSpec(menus, (this.root && this.root.actions) || []);

            /*
             * And the canvas, whenever the two disagree -- which covers the bar
             * appearing, going away, and the one case a "did it change?" answer
             * would miss: the height is measured off a real menu bar, and until
             * the IDE's own window has been laid out there is nothing to measure,
             * so the first answer can be the fallback and the second the truth.
             * Comparing costs a subtraction and cannot go stale.
             */
            const want = this.clientSize();
            if (this.surface.Height !== want.h || this.surface.Width !== want.w)
                this.syncSize();
        }
        this.ide.refresh();
    }

    /*
     * Takes the shared side panel over.
     *
     * The palette, the control tree and the property grid all speak about *the*
     * selection, and there is one because there is one active tab -- so the
     * three widgets are the IDE's and the designer being switched to is what
     * fills them in.  `refresh` covers the tree and the buttons; the other two
     * say so here.
     */
    adopt() {
        this.showTool();
        this.refresh();
        this.grid.adopt();
    }

    canUndo() { return this.undoStack.length > 0; }
    canRedo() { return this.redoStack.length > 0; }

    /*
     * Depth.  Selecting a control does not raise it, on purpose: that would
     * reorder the .form without anyone asking.  Meanwhile the selection outline
     * lives in Glass, so a covered control is still visible.
     */
    restack(toFront) {
        if (!this.selection.length) return;
        this.pushUndo();

        for (const control of this.selection) {
            if (toFront) control.Raise();
            else         control.Lower();
        }
        this.chrome.position();
        this.touch();
    }

    /*
     * Even spacing: the outer two stay where they are and the rest share out the
     * gap.  With fewer than three there is nothing to share.
     *
     * It is measured in surface coordinates but applied as a delta on X/Y, which
     * are relative to the container: that way it works the same when the selected
     * controls live in different containers.
     */
    distribute(axis) {
        if (this.selection.length < 3) return;

        const horizontal = axis === "h";
        const items = this.selection
            .map((c) => ({ c, r: this.rectOf(c) }))
            .filter((it) => it.r)
            .sort((a, b) => (horizontal ? a.r.x - b.r.x : a.r.y - b.r.y));

        if (items.length < 3) return;
        this.pushUndo();

        const first = items[0].r, last = items[items.length - 1].r;
        const span  = horizontal ? (last.x + last.w) - first.x
                                 : (last.y + last.h) - first.y;
        const used  = items.reduce((n, it) => n + (horizontal ? it.r.w : it.r.h), 0);
        const gap   = (span - used) / (items.length - 1);

        let at = (horizontal ? first.x + first.w : first.y + first.h);
        for (let i = 1; i < items.length - 1; i++) {
            at += gap;

            const { c, r } = items[i];
            const target = Math.round(at);
            if (horizontal) c.Move(c.X + (target - r.x), c.Y);
            else            c.Move(c.X, c.Y + (target - r.y));

            at += horizontal ? r.w : r.h;
        }

        this.chrome.position();
        this.grid.fill();
        this.touch();
    }

    /* --- alinear ------------------------------------------------------------
     *
     * The whole point of selecting several.  Alignment is against the primary --
     * the last one touched -- which is every designer's convention and the only
     * one that lets the user decide the result.
     */
    align(how) {
        const anchor = this.selected;
        if (!anchor || this.selection.length < 2) return;

        /*
         * Aligned on the edges one can *see*, not on the coordinates: a theme
         * draws a Button's face inside its box (17 px a side here), so aligning
         * declared X left a button and a label visibly out of line -- which is
         * not what anyone means by align.
         *
         * The inset comes from the *size* difference, and sizes do not go stale:
         * a control moved a moment ago still reports last frame's position, so
         * computing from drawn positions would align against where things used
         * to be.
         */
        const at = this.inset(anchor);
        this.pushUndo();

        for (const c of this.selection) {
            if (c === anchor) continue;
            const in_ = this.inset(c);

            switch (how) {
            case "left":
                c.Move(Math.max(0, anchor.X + at.x - in_.x), c.Y);
                break;
            case "right":
                c.Move(Math.max(0, anchor.X + anchor.Width - at.x - (c.Width - in_.x)), c.Y);
                break;
            case "top":
                c.Move(c.X, Math.max(0, anchor.Y + at.y - in_.y));
                break;
            case "bottom":
                c.Move(c.X, Math.max(0, anchor.Y + anchor.Height - at.y - (c.Height - in_.y)));
                break;
            /* Same *drawn* size: two controls with different insets need
             * different requests to come out looking the same. */
            case "width":
                c.Resize(Math.max(MIN_SIZE, anchor.Width - 2 * at.x + 2 * in_.x), c.Height);
                break;
            case "height":
                c.Resize(c.Width, Math.max(MIN_SIZE, anchor.Height - 2 * at.y + 2 * in_.y));
                break;
            }
        }

        this.chrome.position();
        this.grid.fill();
        this.touch();
    }

    /* --- seleccion -------------------------------------------------------- */

    /* The layout is asked: that way it lands correctly inside a Panel or a
     * Frame, whose border and label shift the content by whatever the theme
     * decides. */
    hitTest(x, y) {
        return this.owner(this.surface.PickAt(x, y));
    }

    /*
     * The control a hit belongs to.
     *
     * `PickAt` answers with the topmost widget at a point *at any depth*, and
     * inside a list showing an item that widget is part of a drawing rather than
     * of the form -- selecting it would put a component's own label in the
     * property grid. What the pointer means there is the list.
     */
    owner(widget) {
        /*
         * The climb is only to find out *whether* this is inside a preview: what
         * comes back is the widget that was hit, unless one of its ancestors is
         * a list showing an item -- and then it is that list. Returning the
         * ancestor in the ordinary case instead is a control inside a `Panel`
         * selecting the panel, which is what the first version of this did.
         */
        for (let w = widget; w; ) {
            const parent = this.parentOf(w);

            if (!parent || parent === this.surface) return widget;
            if (parent.Item || parent.__node) return parent;
            w = parent;
        }
        return widget;
    }

    /* Every control of the form, at any depth.  Which is what `ControlTree`
     * shows, and how a name coming back from it is resolved to a control. */
    allControls(container = this.surface, out = []) {
        for (const c of container.Children) {
            out.push(c);
            /*
             * A list showing its design-time item is not walked into: what is in
             * it is a drawing of a component and not this form's controls, so
             * the tree must not list it, a name must not collide with it, and
             * aligning or deleting must not reach it. The list itself is a
             * control like any other and is pushed above.
             */
            if ("Children" in c && !c.Item && !c.__node) this.allControls(c, out);
        }
        return out;
    }

    /* Where a new control ends up: inside the selected container, which is what
     * one expects right after drawing a Panel. */
    dropTarget() {
        const s = this.selected;
        return s && "Children" in s ? s : this.surface;
    }

    /* --- seleccion multiple -------------------------------------------------
     *
     * `selected` is the primary: the last one picked.  It is the one the property
     * grid shows and the one that can be resized; the rest come along for moves
     * and for set operations.
     */
    get selected() {
        return this.selection.length ? this.selection[this.selection.length - 1] : null;
    }

    select(widget) {
        this.setSelection(widget ? [widget] : []);
    }

    setSelection(controls) {
        /* If a container is selected, its descendants do not come separately:
         * moving them as well as the parent would shift them twice. */
        this.selection = controls.filter(
            (c) => !controls.some((other) => other !== c && this.contains(other, c)));

        this.chrome.position();
        this.grid.fill();
        this.refresh();
    }

    contains(container, control) {
        if (!("Children" in container)) return false;
        for (const child of container.Children) {
            if (child === control || this.contains(child, control)) return true;
        }
        return false;
    }

    toggle(control) {
        const at = this.selection.indexOf(control);
        if (at < 0) this.setSelection([...this.selection, control]);
        else        this.setSelection(this.selection.filter((c) => c !== control));
    }

    /* --- mouse ------------------------------------------------------------ */

    mouseDown(x, y, button, ctrl) {
        this.glass.SetFocus();      /* so the keys arrive here */
        const grabbed = this.chrome.handleAt(x, y);
        if (grabbed) {
            this.beginDrag(grabbed, x, y);
            return;
        }

        /* After a control's handles: with a control against the form's edge the
         * two grips overlap, and the selected control is what the eye is on. */
        const edge = this.chrome.formHandleAt(x, y);
        if (edge) {
            this.beginFormDrag(edge, x, y);
            return;
        }

        const hit = this.hitTest(x, y);

        if (!hit) {
            /* On the background: dragging draws a selection rectangle. */
            if (!ctrl) this.select(null);
            this.beginBand(x, y);
            return;
        }

        if (ctrl) {
            this.toggle(hit);
            return;                 /* ctrl+clic elige, no arrastra */
        }

        /* Clicking one already selected keeps the set, so several can be dragged
         * at once. */
        if (!this.selection.includes(hit)) this.select(hit);
        this.beginDrag("move", x, y);
    }

    /*
     * Resizing the form by its border.  What changes is the root node's size,
     * not a widget's -- the form is not on the surface, it *is* the surface --
     * so this goes through setFormProperty like the grid's Width row, and the
     * grid follows along as it is dragged.
     */
    beginFormDrag(mode, x, y) {
        const { w, h } = this.formSize();
        this.formDrag = { mode, x0: x, y0: y, startW: w, startH: h,
                          base: this.childGeometry(), before: this.snapshot() };
    }

    dragForm(x, y, noSnap) {
        const d  = this.formDrag;
        const dx = noSnap ? x - d.x0 : snap(x - d.x0);
        const dy = noSnap ? y - d.y0 : snap(y - d.y0);

        const w = d.mode === "s" ? d.startW : Math.max(FORM_MIN, d.startW + dx);
        const h = d.mode === "e" ? d.startH : Math.max(FORM_MIN, d.startH + dy);

        this.setFormProperty("Width", w);
        this.setFormProperty("Height", h);
        this.chrome.layout();
        this.ide.refresh();      /* the status bar reads the size as it changes */
    }

    beginDrag(mode, x, y) {
        const s = this.selected;
        /* Where the cursor grabbed the control, measured now that its real
         * position is allocated.  That distance does not change during the drag,
         * so on release the corner is known without measuring again: just moved,
         * the layout would still report the old position. */
        const corner = s.OriginIn(this.surface) || [s.X, s.Y];

        this.drag = {
            mode,
            x0: x, y0: y,
            startX: s.X, startY: s.Y,
            startW: s.Width, startH: s.Height,
            grabX: x - corner[0], grabY: y - corner[1],
            /* The set moves together, each from where it was. */
            starts: this.selection.map((c) => ({ c, x: c.X, y: c.Y })),
            /* In a box there is nowhere to move to: dragging reorders instead,
             * and this is where the answer to "which container" is settled, once,
             * before anything has moved. */
            box: this.reorders(this.parentOf(s)) ? this.parentOf(s) : null,
            index: null,
            before: this.snapshot(),
        };
    }

    /* --- alignment guides ---------------------------------------------------
     *
     * While a control is dragged, if any of its three lines of interest (leading
     * edge, centre, trailing edge) comes close to the same line of another
     * control, it snaps and the guide is drawn.  It is what turns drawing by hand
     * into something repeatable instead of trial and error.
     *
     * It takes the corner computed from the pointer, not measured with OriginIn:
     * a control just moved reports the previous frame's position.
     */
    guideSnap(control, cornerX, cornerY) {
        /* The size it draws, to line up with the edges the others draw.  Its
         * position is passed in, computed from the pointer: a control moved this
         * frame still reports where it was in the one before. */
        const drawn = control.Bounds(this.surface);
        const w = drawn ? drawn.Width : control.Width;
        const h = drawn ? drawn.Height : control.Height;
        const others = this.allControls()
            .filter((c) => !this.selection.includes(c))
            .map((c) => this.rectOf(c))
            .filter(Boolean);

        const best = { dx: null, dy: null, gx: 0, gy: 0 };

        for (const r of others) {
            /* The same three points on both sides: edges and centre. */
            for (const mine of [cornerX, cornerX + w / 2, cornerX + w]) {
                for (const theirs of [r.x, r.x + r.w / 2, r.x + r.w]) {
                    const d = theirs - mine;
                    if (Math.abs(d) <= GUIDE_SNAP &&
                        (best.dx === null || Math.abs(d) < Math.abs(best.dx))) {
                        best.dx = d;
                        best.gx = theirs;
                    }
                }
            }
            for (const mine of [cornerY, cornerY + h / 2, cornerY + h]) {
                for (const theirs of [r.y, r.y + r.h / 2, r.y + r.h]) {
                    const d = theirs - mine;
                    if (Math.abs(d) <= GUIDE_SNAP &&
                        (best.dy === null || Math.abs(d) < Math.abs(best.dy))) {
                        best.dy = d;
                        best.gy = theirs;
                    }
                }
            }
        }

        /* Across the whole board, so a guide is visibly about the line and not
         * about the two controls that happen to share it. */
        const surface = this.rectOf(this.surface) ||
                        { w: this.surface.Width, h: this.surface.Height };

        if (best.dx !== null) this.chrome.showGuide("v", best.gx, surface.h);
        else                  this.chrome.hideGuide("v");

        if (best.dy !== null) this.chrome.showGuide("h", best.gy, surface.w);
        else                  this.chrome.hideGuide("h");

        return { dx: best.dx || 0, dy: best.dy || 0 };
    }

    /* --- ordering inside a box ----------------------------------------------
     *
     * A box gives its children no coordinates, so what a drag can say is only
     * *where in the row* the control goes.  The index is read off the middles:
     * past the middle of a child is past that child.
     */
    insertionIndex(box, x, y, ignore) {
        const kids = box.Children;

        /*
         * A stack has no boundary to read: every child has the whole of it, so
         * what a drag chooses is *which layer it lands over*.  The runtime
         * answers that already -- `PickAt` is the topmost child at a point --
         * and one past it is where the new layer goes.
         */
        if (this.layers(box)) {
            const over = this.pickIn(box, x, y);
            const at   = over && over !== ignore ? kids.indexOf(over) : -1;
            return at < 0 ? kids.length : at + 1;
        }

        const horizontal = this.runsHorizontal(box);
        const along      = horizontal ? x : y;

        for (let i = 0; i < kids.length; i++) {
            if (kids[i] === ignore) continue;
            const r = this.rectOf(kids[i]);
            if (!r) continue;
            if (along < (horizontal ? r.x + r.w / 2 : r.y + r.h / 2)) return i;
        }
        return kids.length;
    }

    /* A line across the box at the boundary the control would land on -- the
     * guide bars again, which is what they are for: saying where something is
     * about to go. */
    showInsertion(box, index) {
        const kids = box.Children;
        const area = this.rectOf(box);
        if (!area) return;

        /* In a stack the mark is the layer it will land on top of, because a
         * line between two things that occupy the same rectangle says nothing. */
        if (this.layers(box)) {
            const under = index > 0 ? this.rectOf(kids[index - 1]) : null;
            this.chrome.layerMark(under || area);
            return;
        }

        const horizontal = this.runsHorizontal(box);

        let at;
        if (index < kids.length) {
            const r = this.rectOf(kids[index]);
            at = r ? (horizontal ? r.x : r.y) : (horizontal ? area.x : area.y);
        } else {
            const r = kids.length ? this.rectOf(kids[kids.length - 1]) : null;
            at = r ? (horizontal ? r.x + r.w : r.y + r.h)
                   : (horizontal ? area.x : area.y);
        }

        this.chrome.insertionMark(horizontal, at, area);
    }

    /* --- selection rectangle ---------------------------------------------- */

    beginBand(x, y) {
        this.band = { x0: x, y0: y, x1: x, y1: y };
    }

    bandRect() {
        const b = this.band;
        return {
            x: Math.min(b.x0, b.x1), y: Math.min(b.y0, b.y1),
            w: Math.abs(b.x1 - b.x0), h: Math.abs(b.y1 - b.y0),
        };
    }

    endBand(additive) {
        const r = this.bandRect();
        this.band = null;
        this.chrome.hideBand();

        /* A bare click is not a rectangle. */
        if (r.w < 4 && r.h < 4) return;

        const inside = this.allControls().filter((c) => {
            const cr = this.rectOf(c);
            return cr && cr.x < r.x + r.w && cr.x + cr.w > r.x &&
                         cr.y < r.y + r.h && cr.y + cr.h > r.y;
        });

        this.setSelection(additive ? [...this.selection, ...inside] : inside);
    }

    mouseMove(x, y, noSnap) {
        if (this.band) {
            this.band.x1 = x;
            this.band.y1 = y;
            this.chrome.showBand(this.bandRect());
            return;
        }

        if (this.formDrag) {
            this.dragForm(x, y, noSnap);
            return;
        }

        const d = this.drag;
        if (!d || !this.selected) return;

        const dx = snap(x - d.x0);
        const dy = snap(y - d.y0);
        const s  = this.selected;

        if (d.mode === "move" && d.box) {
            /* Its position is the parent's business; what the drag decides is
             * the order.  Nothing is moved until the release: the mark shows
             * where it would land. */
            d.index = this.insertionIndex(d.box, x, y, s);
            this.showInsertion(d.box, d.index);
            return;
        }

        if (d.mode === "move") {
            let ax = dx, ay = dy;

            /* Guides only with one: with several there is no single edge to
             * snap without guessing which. */
            if (this.selection.length === 1 && !noSnap) {
                const corner = this.guideSnap(this.selected,
                                              d.x0 - d.grabX + dx,
                                              d.y0 - d.grabY + dy);
                ax += corner.dx;
                ay += corner.dy;
            } else {
                this.chrome.hideGuides();
            }

            for (const start of d.starts) {
                start.c.Move(Math.max(0, start.x + ax), Math.max(0, start.y + ay));
            }
        } else {
            const [left, top, right, bottom] = HANDLES[d.mode];

            let nx = d.startX + (left ? dx : 0);
            let ny = d.startY + (top ? dy : 0);
            let nw = d.startW + (right ? dx : 0) - (left ? dx : 0);
            let nh = d.startH + (bottom ? dy : 0) - (top ? dy : 0);

            /* When shrinking from the top or the left, the opposite edge does
             * not move: the corner is stopped instead of allowed to cross. */
            if (nw < MIN_SIZE) {
                if (left) nx = d.startX + d.startW - MIN_SIZE;
                nw = MIN_SIZE;
            }
            if (nh < MIN_SIZE) {
                if (top) ny = d.startY + d.startH - MIN_SIZE;
                nh = MIN_SIZE;
            }

            s.Move(Math.max(0, nx), Math.max(0, ny));
            s.Resize(nw, nh);
        }

        this.chrome.position();
    }

    /* Double click: write what the control does.  On the background, the form's
     * own event. */
    dblClick(x, y) {
        this.drag = null;               // the first click's drag does not count

        const hit = this.hitTest(x, y);
        if (!hit) {
            this.ide.openHandler("Form", "Open");
            return;
        }

        this.select(hit);
        this.ide.openHandler(hit.Name, this.defaultEvent(hit));
    }

    /*
     * The event a double click writes for this control, and the one the Form
     * menu marks as its default: the head of the list, which is why that list
     * is most-derived first.
     */
    defaultEvent(control) {
        return this.eventsOf(control)[0] || "MouseDown";
    }

    /*
     * Every event that control raises, for the Form menu to offer.
     *
     * **A stand-in for a component is not asked**, though it would answer: it is
     * a `Label` wearing the component's name, and what came back was the Label's
     * list. That it looked right is luck and not design -- `Label` declares no
     * events of its own today, so the answer fell through to Widget's and a
     * double click on a Stepper wrote `Step_MouseDown`. The day `Label` declares
     * a `Click` it would start writing `Step_Click` instead, silently, for every
     * component in every project.
     *
     * The component's own class answers instead: `static Events` first, then
     * what any widget raises. The other kind of stand-in -- a control the
     * runtime refused to build -- keeps what it had, since Widget's events are
     * every control's and that is all a Label was ever saying.
     */
    eventsOf(control) {
        if (control.__node) {
            const declared = this.ide.classes.componentEvents(control.__node.type);
            if (declared) return declared;
        }
        return "EventNames" in control ? control.EventNames() : [];
    }

    mouseUp(x, y, button, ctrl) {
        if (this.band) {
            this.endBand(ctrl);
            return;
        }

        if (this.formDrag) {
            const d = this.formDrag;
            this.formDrag = null;

            const { w, h } = this.formSize();
            if (w !== d.startW || h !== d.startH) {   /* a click is not a resize */
                this.pushUndo(d.before);
                this.grid.fill();
                this.touch();
            }
            return;
        }

        if (!this.drag) return;

        const d = this.drag;
        this.drag = null;
        this.chrome.hideGuides();

        const s = this.selected;

        if (d.box) {
            if (d.index === null) return;          /* a click, not a drag */

            const kids  = d.box.Children;
            const from  = kids.indexOf(s);
            /* Counted without the control itself, which is how Reorder counts:
             * dragging something forward passes the hole it leaves behind. */
            const to    = from >= 0 && from < d.index ? d.index - 1 : d.index;

            if (to !== from) {
                d.box.Reorder(s, to);
                this.pushUndo(d.before);
                this.chrome.position();
                this.grid.fill();
                this.touch();
            }
            return;
        }

        const moved = s && (s.X !== d.startX || s.Y !== d.startY ||
                            s.Width !== d.startW || s.Height !== d.startH);
        if (!moved) return;

        /* Re-parenting only with one: splitting a set across containers by
         * where each landed would be guesswork. */
        if (d.mode === "move" && this.selection.length === 1) {
            this.dropInto(s, x - d.grabX, y - d.grabY, x, y);
        }

        this.pushUndo(d.before);
        this.grid.fill();
        this.touch();
    }

    /*
     * Dropping a control on another container moves it in there.
     *
     * The coordinates have to be recomputed: X/Y are relative to the container,
     * so keeping them would teleport the control.  The conversion happens
     * *before* the move, while the target still has its layout: freshly
     * allocated it would have none until the next frame.
     */
    dropInto(control, cornerX, cornerY, pointerX, pointerY) {
        const target = this.surface.ContainerAt(pointerX, pointerY, control);
        if (!target) return false;

        /* Already there: nothing to do. */
        if (target.Children.some((c) => c === control)) return false;

        const local = target.LocalPoint(cornerX, cornerY, this.surface);
        if (!local) return false;

        control.Delete();
        target.Add(control);
        control.Move(Math.max(0, snap(local[0])), Math.max(0, snap(local[1])));

        /* Hiding them avoids a flicker at the old position; the chrome puts
         * them back in place on the next frame. */
        this.chrome.show(false);
        this.chrome.position();

        this.ide.log(`${control.Name} moved into ${target.Name || "the form"}\n`);
        return true;
    }

    /* --- teclado ---------------------------------------------------------
     * Returns true to consume the key; otherwise the arrows would move the focus
     * instead of the control. */
    keyPress(key, ctrl, shift) {
        if (key === "Escape") {
            this.select(null);
            return true;
        }
        if (!this.selected) return false;

        if (key === "Delete" || key === "BackSpace") {
            this.deleteSelected();
            return true;
        }

        /* Anywhere but on a surface the arrows reorder: there is no coordinate
         * to nudge, and the keyboard should reach what the mouse can do. In a
         * stack that is one layer up or down, which is the same sentence -- the
         * order *is* the z-order there. */
        const box = this.reorders(this.parentOf(this.selected))
            ? this.parentOf(this.selected) : null;
        if (box) {
            const by = { Left: -1, Up: -1, Right: 1, Down: 1 }[key];
            if (by === undefined) return false;

            const kids = box.Children;
            const at   = kids.indexOf(this.selected) + by;
            if (at < 0 || at >= kids.length) return true;

            /* Taken before and pushed after, which is what `mouseUp` already
             * does: pushing first left a dead undo step behind every nudge that
             * could not happen -- at either end of the list, and on every
             * container that used to refuse the move outright. */
            const before = this.snapshot();
            box.Reorder(this.selected, at);
            this.pushUndo(before);
            this.chrome.position();
            this.touch();
            return true;
        }

        /* With Shift the step is the grid's; on its own, it is fine-grained. */
        const step = shift ? GRID : 1;
        const by   = { Left: [-step, 0], Right: [step, 0],
                       Up: [0, -step],   Down: [0, step] }[key];
        if (!by) return false;

        /* One undo step per run of nudges of the same selection, not per
         * repeat: see `pushUndo`. */
        this.pushUndo(undefined, `nudge:${ctrl ? "size" : "move"}:` +
                                 this.selection.map((c) => c.Name).join(","));

        /* Resizing from the keyboard goes to the primary only; moving, to all. */
        if (ctrl) {
            const s = this.selected;
            s.Resize(Math.max(MIN_SIZE, s.Width + by[0]),
                     Math.max(MIN_SIZE, s.Height + by[1]));
        } else {
            for (const c of this.selection) {
                c.Move(Math.max(0, c.X + by[0]), Math.max(0, c.Y + by[1]));
            }
        }

        this.chrome.position();
        this.grid.fill();
        this.touch();
        return true;
    }

    /* --- agregar controles -------------------------------------------------
     *
     * Two roads to the same place.  Pressing the palette button adds the control
     * in the first free spot; dragging it to the form puts it where it is
     * dropped, which is what one wants once one knows where it goes.
     */

    /*
     * A type dropped on the form.  The coordinates arrive in Glass's space,
     * which is Surface's: the two layers of the same Overlay.
     *
     * The control ends up centred on the pointer, because centred on the pointer
     * was the stamp that was being dragged.
     */
    dropControl(type, x, y) {
        if (!this.path) return false;
        if (!PALETTE.includes(type) && !this.isComponent(type)) return false;

        const [w, h] = this.sizeFor(type);

        /* Inside the container it was dropped on, not always the form: dropping
         * on top of a Panel puts the control in there. */
        const target = this.surface.ContainerAt(x, y) || this.surface;
        if (!this.canTake(target)) return false;

        /*
         * **Where it goes is worked out before anything is created**, and that
         * order is the whole of this method.
         *
         * It used to add the control and *then* ask the container for a place,
         * so a container the editor had misjudged was left holding a child that
         * nothing had selected, with the insertion mark still on screen and the
         * form not even marked as modified -- a drag that read as failed and
         * left something behind. Both halves are answerable up here: the place
         * is a function of the pointer and the children already there, and
         * `canTake` above has already said no if the container cannot take one.
         */
        const kind  = this.placementOf(target);
        const place = kind === "Order" || kind === "Layers"
                    ? this.insertionIndex(target, x, y, null)
                    : null;


        this.pushUndo();
        const widget = this.newControl(type, target);
        widget.Resize(w, h);

        /* The gesture is finished here, before the container is asked for
         * anything else: from this point a refusal is a control in the wrong
         * place -- a whole drop, badly ordered -- and never a control nothing
         * points at. */
        this.chrome.hideGuides();
        this.tool = type;
        this.showTool();
        this.select(widget);
        this.touch();

        if (kind === "Pages") {
            /* A page goes at the end: a notebook shows one at a time, so there
             * is no "where the pointer is" to read. */
            this.nameTab(target, widget);
            target.Current = target.Count - 1;
        } else if (kind === "Halves") {
            /* The runtime put it in whichever half was free. */
        } else if (kind === "Single") {
            /* One place, and `Add` already used it. */
        } else if (kind === "Coordinates") {
            const corner = [x - w / 2, y - h / 2];
            const local  = target === this.surface
                ? corner
                : (target.LocalPoint(corner[0], corner[1], this.surface) || corner);

            widget.Move(Math.max(0, snap(local[0])), Math.max(0, snap(local[1])));
        } else {
            /* Nothing to drop *onto*: what the pointer chose is the place in
             * the row, or the layer of the stack. `Add` already put it last, so
             * this is the only move there is to make. */
            target.Reorder(widget, place);
        }

        /* The outline follows it to wherever the placement put it. */
        this.chrome.position();
        return true;
    }

    /* The control itself: a unique name, inside the container, showing off its
     * name as text the way VB does.  No position: the caller sets that. */
    sizeFor(type) {
        if (this.isComponent(type)) return this.componentSize(type);
        return DEFAULT_SIZE[type] || [100, 30];
    }

    newControl(type, target) {
        /*
         * A component is the project's class and the designer is the IDE's
         * process: there is nothing here to instantiate.  It gets the same
         * stand-in a component read from a file gets, so both save the same.
         */
        if (this.isComponent(type)) {
            /* Placing it commits the project to loading its class: a form that
             * names a component whose .js is not in "sources" does not open at
             * all, and the error would come out of the running program rather
             * than out of the designer that put it there. */
            const spec = this.components.find((c) => c.name === type);
            if (spec && spec.source) this.ide.registerSource(spec.source);

            return this.standIn(target, { type, name: this.uniqueName(type),
                                          properties: {} });
        }

        /* Widget.New and not a global by name: it is the same lookup the .form
         * loader does, and the only one there is now that globalThis is not
         * part of the language. */
        const widget = Widget.New(type);

        widget.Name = this.uniqueName(type);
        target.Add(widget);

        /* Only if its Text is something assignable: a ListBox's is read-only,
         * and a freshly created ComboBox's has to be one of its items, of which
         * it has none yet. */
        if (widget.PropertyNames().includes("Text")) {
            try { widget.Text = widget.Name; } catch (e) { /* no lo acepta */ }
        }
        return widget;
    }

    addControl(type) {
        if (!this.path) return;
        if (!PALETTE.includes(type) && !this.isComponent(type)) return;

        const target = this.dropTarget();
        if (!this.canTake(target)) return;

        this.pushUndo();

        const widget = this.newControl(type, target);

        const [w, h] = this.sizeFor(type);
        widget.Resize(w, h);

        if (this.pages(target)) {
            this.nameTab(target, widget);
            target.Current = target.Count - 1;
        }

        /* In a box it goes at the end, which is where Add already put it. */
        if (this.isFixed(target)) {
            widget.Move(16, 16);
            /* Shifted along until a free spot, so they do not pile up. */
            while (this.overlapsAny(target, widget))
                widget.Move(widget.X + PASTE_STEP, widget.Y + PASTE_STEP);
        }

        this.select(widget);
        this.touch();
    }

    overlapsAny(container, widget) {
        return container.Children.some((c) =>
            c !== widget &&
            c.X === widget.X && c.Y === widget.Y);
    }

    /*
     * Unique across the whole form, not just among siblings: handlers are
     * Name_Event on the form, so two controls with the same name at different
     * depths would collide in the dispatch.
     *
     * **And unique against the code as well as against the form**, which is the
     * part that is not obvious. Deleting a control leaves its handlers in the
     * `.js` -- deliberately: they are the user's code and nobody asked to lose
     * them -- and this used to count up from 1 over the *live* controls only, so
     * the next Button after deleting `Button1` was `Button1` again and silently
     * inherited whatever `Button1_Click` still did. A fresh control that already
     * does something, with nothing anywhere saying why.
     *
     * So a name whose handlers are still written is taken, exactly as a name on
     * screen is. The evidence lives in the file rather than in a counter here,
     * which is what makes it survive closing the project -- a counter would hand
     * `Button1` back the next morning.
     *
     * Reclaiming the old code deliberately is still there and is a *rename*: it
     * is the gesture that says "this control is that one", and renaming already
     * carries handlers along.
     */
    uniqueName(type, claimed = []) {
        /* After the class, not the namespace: a control's name is a JS
         * identifier -- its handlers are Name_Event methods -- and
         * "Partes.Chip1" is not one. */
        const stem  = type.split(".").pop();

        /* `claimed` is what a paste has already promised to the nodes it has not
         * built yet: they are not in the tree, so asking the tree alone would
         * hand the same name to both halves of one paste. */
        const taken = this.allControls().map((c) => c.Name).concat(claimed);

        /* Read once: `renamedNode` walks a whole pasted subtree through here. */
        const source = this.ide.formFiles.siblingSource();

        let n = 1;
        while (taken.includes(`${stem}${n}`) ||
               Ide.FormFiles.handlersIn(source, `${stem}${n}`).length) n++;
        return `${stem}${n}`;
    }

    /* --- copiar y pegar -----------------------------------------------------
     *
     * The clipboard carries **`.form` nodes as text**, which is what makes this
     * work between forms, between tabs and between two IDEs on the same desktop
     * without anything having to be shared: the serialiser already writes a
     * control as a node and `AddNode` already builds one, so a control on the
     * clipboard is the same thing a file holds. It is readable, too -- paste it
     * into a text editor and it is the block that would have been in the file.
     *
     * What does **not** travel is the code. A pasted control gets a fresh name,
     * so its handlers would be `Button7_Click` and nothing wrote one; copying
     * `Button3_Click` into it under a new name would be guessing that the body
     * still means anything where it landed. Renaming carries handlers along
     * because a rename is the *same* control; a paste is a second one.
     */
    static get CLIP_FORMAT() { return "bta-clip/1"; }

    /* The selection as something that can be written down. `nodeOf` is what the
     * save uses, so what goes on the clipboard is exactly what the file would
     * have held -- stand-ins for the project's components included. */
    clipOf(controls) {
        return {
            format: Designer.CLIP_FORMAT,
            nodes: controls.map((c) =>
                this.nodeOf(c, this.isFixed(this.parentOf(c)))),
        };
    }

    /* What a text on the clipboard turns out to be, or nothing at all. Anything
     * that is not ours is not an error: a clipboard holding a paragraph of prose
     * is the ordinary state of a clipboard. */
    clipNodes(text) {
        if (!text) return [];
        try {
            const clip = JSON.parse(text);
            if (!clip || clip.format !== Designer.CLIP_FORMAT) return [];
            return Array.isArray(clip.nodes) ? clip.nodes : [];
        } catch (e) {
            return [];
        }
    }

    copySelection() {
        if (!this.selection.length) return false;
        Clipboard.Copy(JSON.stringify(this.clipOf(this.selection), null, 2));
        return true;
    }

    cutSelection() {
        if (!this.copySelection()) return false;
        this.deleteSelected();
        return true;
    }

    /*
     * Pasting is an answer that arrives: the clipboard belongs to whoever owns
     * the selection, and its contents come when that application replies. So
     * this is the one edit in the designer that cannot finish in its own call --
     * and `pasteNodes` is the half that can, which is what `Duplicate` uses.
     */
    paste() {
        if (!this.path) return;
        Clipboard.Paste((text) => {
            const nodes = this.clipNodes(text);
            if (!nodes.length) {
                /* A gesture that appears to do nothing is worse than one that
                 * says why: Ctrl+V over a clipboard holding something else is
                 * the commonest way to meet this. */
                this.ide.log("Nothing to paste: the clipboard holds no controls.\n");
                return;
            }
            this.pasteNodes(nodes);
        });
    }

    /*
     * Another one of these, **beside it** and not inside it.
     *
     * That is the one place duplicating differs from pasting, and the reason is
     * what each gesture means: pasting into the selected container is how one
     * puts something *in* a Panel, so paste follows the selection; duplicating a
     * Panel that is selected would then drop the copy inside the original, which
     * is nobody's idea of "one more of these". A duplicate is a sibling, so it
     * goes where the thing it came from lives.
     */
    duplicateSelection() {
        if (!this.selection.length) return;
        this.pasteNodes(this.clipOf(this.selection).nodes,
                        this.parentOf(this.selected) || this.surface);
    }

    /*
     * Nodes into the form, named afresh and offset so they do not hide what they
     * came from.
     *
     * Where they land is where a new control would: the selected container if it
     * can take children, the surface otherwise -- the same `dropTarget` the
     * palette uses, so pasting into a Panel is done by selecting the Panel.
     */
    pasteNodes(nodes, into) {
        const target = into || this.dropTarget();
        if (!this.canTake(target)) return;

        /* A split with room for one is not room for two: refusing after the
         * first would leave half a paste behind. */
        if (this.split(target) && target.Children.length + nodes.length > 2) {
            Message.Warning("A split holds exactly two children.\nPut a container in one of its halves to hold more.");
            return;
        }

        this.pushUndo();

        const claimed = [];
        const made    = [];

        for (const node of nodes) {
            const control = this.buildNode(target, this.renamedNode(node, claimed));
            if (!control) continue;

            if (this.pages(target)) {
                this.nameTab(target, control);
                target.Current = target.Count - 1;
            }

            /* In a box there are no coordinates to offset: it went to the end,
             * which is where a new child goes. */
            if (this.isFixed(target)) {
                control.Move(control.X + PASTE_STEP, control.Y + PASTE_STEP);
                while (this.overlapsAny(target, control))
                    control.Move(control.X + PASTE_STEP, control.Y + PASTE_STEP);
            }
            made.push(control);
        }

        if (!made.length) return;

        this.setSelection(made);
        this.touch();
    }

    /*
     * A copy of the node with every name in it fresh, children included.
     *
     * Depth matters: a copied Panel brings its contents, and a name is unique
     * across the *form* rather than among siblings -- handlers are `Name_Event`
     * on the form, so two controls called `Button3` at different depths collide
     * in the dispatch even though nothing on screen looks wrong.
     */
    renamedNode(node, claimed) {
        const name = this.uniqueName(node.type, claimed);
        claimed.push(name);

        return {
            ...node,
            name,
            children: (node.children || []).map((c) => this.renamedNode(c, claimed)),
        };
    }

    deleteSelected() {
        if (!this.selection.length) return;
        this.pushUndo();

        this.reportOrphans(this.selection);

        for (const control of this.selection) control.Delete();
        this.select(null);
        this.touch();
    }

    /*
     * What the code still answers for once the control is gone.
     *
     * **The handlers stay**, and that is the decision rather than an oversight:
     * they are the user's code, deleting a control is not asking to lose it, and
     * a designer that quietly edited the `.js` on a Delete would be the worst
     * kind of helpful. Undo brings the control back and finds its handlers where
     * it left them.
     *
     * What it must not be is *silent*. Dead code nobody knows about is how the
     * name got reused and the next control inherited it -- `uniqueName` refuses
     * that now, so the pair is: the code is kept, the name is not handed on, and
     * one line says both. Said in the console and not in a dialog, because
     * deleting is an ordinary gesture and one confirms nothing here.
     *
     * The subtree, not the control: a deleted `Panel` takes its children with
     * it, and their handlers are as orphaned as its own.
     */
    reportOrphans(controls) {
        const source = this.ide.formFiles.siblingSource();
        if (!source) return;

        const left = [];
        const walk = (control) => {
            for (const event of Ide.FormFiles.handlersIn(source, control.Name,
                                                         this.eventsOf(control)))
                left.push(`${control.Name}_${event}`);
            if ("Children" in control) for (const kid of control.Children) walk(kid);
        };
        for (const control of controls) walk(control);
        if (!left.length) return;

        const jsName = sibling(this.ide.activeFile, "js");
        this.ide.log(`${left.join(", ")} ${left.length > 1 ? "are" : "is"} ` +
                     `still in ${jsName}; ` +
                     `${left.length > 1 ? "those names" : "that name"} ` +
                     `will not be given to another control.\n`);
    }

    /* --- menus --------------------------------------------------------------
     *
     * Not on the surface and not widgets: what is edited is the spec the .form
     * carries, which is also what gets saved.  The designer only has to make it
     * an edit like any other -- undoable, and dirtying the form.
     */
    menus() {
        return (this.root && this.root.menus) || [];
    }

    setMenus(spec) {
        if (!this.root) return false;
        this.pushUndo();

        if (spec && spec.length) this.root.menus = spec;
        else                     delete this.root.menus;

        this.touch();
        return true;
    }

    /* --- renaming a control -----------------------------------------------
     *
     * Renaming a control has to carry its handlers along: if Button1 becomes
     * BtnSave and Button1_Click stays as it is, the button stops responding and
     * nothing says so.
     *
     * That is why this is not an undoable edit.  The .js is rewritten on disk,
     * and undo only reverts the widget tree: it would put the old name back in
     * the .form while leaving the code with the new one, which is exactly the
     * silent breakage this is here to avoid.  The form is saved and the history
     * cleared, since from here on it no longer describes a valid state.
     */
    renameControl(newName) {
        const control = this.selected;
        const oldName = control ? control.Name : null;

        if (!control || newName === oldName) {
            this.grid.sync();
            return false;
        }

        /* `CLASS_NAME` is `Classes.js`'s, and this is the same question: a
         * control's name is the prefix of its handlers, so it has to be an
         * identifier the runtime can spell -- ASCII, which is narrower than the
         * engine's own idea of one. This was a second copy of that pattern
         * written as a regexp literal, where the tree writes `Regex`. */
        if (!CLASS_NAME.IsMatch(newName)) {
            Message.Error("\"{0}\" is not usable as a control name.", newName);
            this.grid.sync();
            return false;
        }
        if (this.allControls().some((c) => c !== control && c.Name === newName)) {
            Message.Error("There is already a control named {0}.", newName);
            this.grid.sync();
            return false;
        }

        /* A name the code still answers for is not free either -- the rule
         * `uniqueName` learned. Renaming onto it would carry this control's
         * handlers over methods already there, and two methods of one name in a
         * class is the silent kind: the later one wins. */
        const events   = this.eventsOf(control);
        const answered = Ide.FormFiles.handlersIn(this.ide.formFiles.siblingSource(),
                                                  newName, events);
        if (answered.length) {
            Message.Error("The code already has handlers for {0}: {1}.\nRename or delete them first.",
                          newName, answered.map((e) => `${newName}_${e}`).join(", "));
            this.grid.sync();
            return false;
        }

        const moved = this.ide.renameHandlers(this.path, oldName, newName, events);
        control.Name = newName;

        this.save();
        this.undoStack = [];
        this.redoStack = [];

        this.grid.fill();
        this.refresh();
        this.ide.log(`Renamed ${oldName} to ${newName}` +
                     (moved ? ` (${moved} in the code)\n` : "\n"));
        return true;
    }

    /*
     * Resizing the form moves and stretches what was anchored to its far edges,
     * and *writes the new coordinates*.
     *
     * It has to write them.  An anchor is measured against the form's declared
     * size, so the moment that changes the old numbers stop describing what the
     * runtime would draw -- a control left at X=210 in a form grown to 420 is
     * no longer against the right edge, whatever its HAlign says.  Moving it on
     * screen and leaving the .form alone would show one thing and save another.
     *
     * This is the arithmetic of bta_fixed.c applied to the coordinates instead
     * of to the allocation, floors included: MinWidth/MinHeight when declared,
     * and the designer's own minimum when not, so a control can never be
     * squeezed down to something there is no way to grab again.
     */
    adaptChildren(container, dw, dh, base) {
        /* No early return on a zero delta: the numbers are computed *from* the
         * baseline, not stepped from the last frame, so a drag that comes back
         * to where it started has to be applied to be undone -- with a floor in
         * play, whatever bottomed out on the way in would otherwise stay
         * bottomed out. */
        for (const c of container.Children) {
            const was = base[c.Name] || { x: c.X, y: c.Y, w: c.Width, h: c.Height };

            const h = this.adaptAxis(c.HAlign, was.x, was.w, dw, c.MinWidth);
            const v = this.adaptAxis(c.VAlign, was.y, was.h, dh, c.MinHeight);

            c.Move(h.at, v.at);
            c.Resize(h.size, v.size);

            /* A container that grew passes its own growth down: what is inside
             * it is anchored to *it*, not to the form. Only a fixed one -- in a
             * box the coordinates are the parent's business. */
            if ("Children" in c && this.isFixed(c)) {
                this.adaptChildren(c, h.size - was.w, v.size - was.h, base);
            }
        }
    }

    /*
     * The geometry the next adaptation measures from.  It matters that this can
     * be captured once and reused: a floor makes shrinking lossy, so a drag
     * that measured each frame from the last one would not come back where it
     * started once anything had bottomed out.  Measured from where the border
     * was grabbed, dragging in and out again is exact.
     */
    childGeometry(container = this.surface, into = {}) {
        for (const c of container.Children) {
            into[c.Name] = { x: c.X, y: c.Y, w: c.Width, h: c.Height };
            if ("Children" in c && this.isFixed(c)) this.childGeometry(c, into);
        }
        return into;
    }

    adaptAxis(align, at, size, slack, min) {
        let out = { at, size };

        if (align === "End")         out.at   = at + slack;
        else if (align === "Center") out.at   = at + Math.round(slack / 2);
        else if (align === "Fill")   out.size = size + slack;

        out.size = Math.max(out.size, min > 0 ? min : MIN_SIZE);
        return out;
    }

    /*
     * Some of the form's properties the surface has to answer to, since it is
     * what stands in for the form on screen: its size, how it lays children
     * out, and its colours.  Saying one thing in the grid and showing another
     * on the canvas is the failure worth avoiding here.
     */
    setFormProperty(key, value) {
        const was = this.formSize();
        /* Arrangement swaps the slot and refuses once there are children, so
         * the tree comes off and goes back on.  Serialised *before* the change,
         * because whether a child writes X/Y depends on the old answer. */
        const rebuilding = key === "Arrangement";
        const kids = rebuilding
            ? this.surface.Children.map((c) => c.Serialize(this.isFixed(this.surface)))
            : null;

        this.root.properties = this.root.properties || {};
        this.root.properties[key] = value;

        if (key === "Width" || key === "Height") {
            const { w, h } = this.formSize();
            this.syncSize();

            /* Mid-drag the baseline is the one taken when the border was
             * grabbed; from the grid, one change is one step and what is on the
             * surface now is the baseline. */
            const d = this.formDrag;
            if (d) this.adaptChildren(this.surface, w - d.startW, h - d.startH, d.base);
            else   this.adaptChildren(this.surface, w - was.w, h - was.h,
                                      this.childGeometry());
        } else if (rebuilding) {
            this.select(null);
            this.buildSurface({ properties: this.root.properties, children: kids });
        } else if (key === "Background" || key === "Foreground") {
            this.surface[key] = value;
        }
    }

    /*
     * The same, for the form's own design values.
     *
     * A form is not on the surface -- it *is* the surface -- so its properties
     * live in the root node rather than on a widget, and its design block does
     * too.  Nothing is applied here: a window title has nowhere to be shown in
     * the designer, which is exactly the case a design value is least about.
     */
    setFormDesign(key, value) {
        this.root.design = this.root.design || {};

        if (value === undefined || value === "") delete this.root.design[key];
        else                                     this.root.design[key] = value;

        /* An empty block writes no key, the way an empty `menus` does not. */
        let any = false;
        for (const k in this.root.design) any = k !== undefined;
        if (!any) delete this.root.design;
    }
};
