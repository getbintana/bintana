/*
 * The menu bar the form will be shown with, drawn over the board.
 *
 * A menu is not a widget -- a GTK4 menu is a `GMenu` wired to actions -- which
 * is the reason the designer edits menus in a dialog and, for a long time, the
 * reason the board did not show them at all.  The two do not follow from each
 * other: what the board needs is not *the* widget, it is something that looks
 * and behaves like one, and the decoration above it has been made that way
 * since the title bar arrived (see TitleBar.js).
 *
 * So the bar is a `Panel` with a `Label` per top level menu, and the drop-downs
 * are **real menus**: every widget has a `Menu` and a `PopupMenu`, so a label
 * that opens one is all a menu bar entry is.  Nothing here was added to the
 * runtime.
 *
 * **Where the design comes from, and where TitleBar's trick stops working.**
 * The title bar can wear the theme's own decoration because GTK styles it
 * through *classes*: `.titlebar`, `.default-decoration`, `.title`.  A menu bar
 * is styled through a **node name**, and a node name is not something an
 * application can put on a widget.  Extracted from the stylesheet GTK carries
 * inside libgtk-4 (4.22.4), which is the theme this runs under when the desktop
 * has none of its own -- and the theme CI runs under:
 *
 *     menubar                 { padding: 0px; box-shadow: inset 0 -1px rgba(0,0,0,0.1) }
 *     menubar > item          { min-height: 16px; padding: 4px 8px }
 *     menubar > item:selected { box-shadow: inset 0 -3px #3584e4; color: #1b6acb }
 *
 * `Style = "menubar"` would therefore do **nothing** here.  Some themes add a
 * `.menubar` alias -- Greybird's GTK4 sheet says `menubar, .menubar` -- and
 * wearing it would look right on those and stay unstyled on the default one,
 * which is the wrong way round for a preview: it would follow *some* desktops.
 *
 * So the bar is assembled out of what the theme does offer an application:
 * `background` is the window colour a menu bar is drawn on (Adwaita gives
 * `menubar` no background of its own), and an entry says the theme's own
 * `padding: 4px 8px` by hand -- exactly as TitleBar says `windowcontrols`' 26 by
 * hand, and for the same reason.
 *
 * **An entry is a `Label` and not a `Button`, and that is measured.**  A button
 * was the obvious choice and it comes out eight pixels too tall: GTK gives
 * `button` a `min-height: 24px` that applies to its *content*, so with the menu
 * bar's own 4px of padding above and below, and its border, the smallest a
 * button can be is 34.  A real bar is **27**.  A label has no floor of its own,
 * so a row of them with `padding: 4px 8px` comes out at 27 exactly -- checked
 * against a real bar in the same window, twice, before this was written.  What
 * a menu bar entry does is show a word and open a menu, and a label does both.
 *
 * **The height is measured, not chosen.** The IDE is itself a form with menus,
 * so its own window has a real `GtkPopoverMenuBar` in it, under this desktop's
 * theme and this desktop's font.  `Bounds()` reports in window coordinates, so
 * how far down the IDE's first control starts *is* the height of a real menu
 * bar.  The preview is not *given* that height -- it comes out at it -- so the
 * two are compared instead, and `tests/ide` fails if a desktop ever makes them
 * disagree rather than quietly putting the canvas in the wrong place.
 *
 * Two things are left over as differences.  The **hover**: a `menubar > item`
 * lights up with a 3px underline and a label does nothing.  And the **hairline**
 * a real bar draws inside its own height with `box-shadow: inset 0 -1px`, which
 * a `Separator` would reproduce at the cost of a 28th pixel -- and the height is
 * the half of this that the canvas depends on, so the pixel wins.  What marks
 * the boundary instead is already there: the designer draws the form's own
 * border around the canvas, which starts exactly where the bar ends.  Closing
 * either gap needs a stylesheet, and the IDE must not grow one -- a rule of ours
 * would repaint the IDE itself, the same reason the canvas does not wear the
 * project's classes.
 *
 * **What is previewed is not live.** The spec is sanitised first; see
 * `sanitise`, which is where the three reasons are.
 */
"use strict";

Namespace("Ide");

/* The theme's own metrics for a `menubar > item`, said here because the node
 * that carries them is not one an application can build. */
const ITEM_PADDING = "4 8";

/*
 * What a menu bar is tall, until a real one has been measured -- what was
 * measured on the machine this was written on, and nothing more.
 *
 * The IDE's own `.form` carries the same number written by hand and gets it
 * wrong: a 720 window over a `Pages` declared 692 says 28, and a real bar is 27.
 * One pixel does not show; on a desktop with a larger font it is not one pixel,
 * which is the whole argument for asking rather than declaring.
 *
 * It is only ever the answer before the IDE's window has been laid out, and the
 * designer re-checks the canvas against it on every refresh, so a first answer
 * that came from here is corrected by the next one that does not.
 */
const BAR_HEIGHT = 27;

/*
 * The prefix every name this module invents starts with.
 *
 * It has to be one no form in the IDE uses, because these land on the IDE's own
 * form beside `MnuOpen` and `BtnSave` -- and it is checked rather than assumed:
 * `tests/ide` asserts that previewing a menu leaves the IDE's own items alone.
 */
const PREVIEW = "Prv";

Ide.MenuBar = class MenuBar {

    /*
     * One per open form, like the canvas and the title bar it sits between.  The
     * IDE's form is needed and not just the widget: events dispatch by name *on
     * a form*, so that is where the handlers for the entries and for the items
     * go -- the same way the palette installs `Pal_Button_Click` (Palette.js).
     *
     * Nothing is built here.  A `Menu` can only be given to a widget that is
     * already bound to a form (`bta_widget.c`: "a widget with no form yet has
     * nowhere to dispatch to"), and at construction the board is not in the tree
     * yet.  The first bar is built by the first `setSpec`, which comes from
     * `Designer.refresh`.
     */
    constructor(ide) {
        this.ide    = ide;
        this.serial = MenuBar.serial++;

        const panel = new Panel();

        panel.Name        = `${PREVIEW}Bar${this.serial}`;
        panel.Arrangement = "Horizontal";
        panel.Spacing     = 0;
        panel.HAlign      = "Fill";
        /* The colour a menu bar is drawn on: the theme gives `menubar` none of
         * its own, so what shows through is the window. */
        panel.Style = "background";
        /* A `menubar` has none, and a Panel that takes the theme's puts nine
         * pixels down the left of the bar and five above every entry. */
        panel.Padding = 0;

        /* Until a form with menus is opened.  A form without them shows none,
         * which is what its window will do. */
        panel.Visible = false;

        this.panel     = panel;
        this.items     = [];    // the top level entries, in the order declared
        this.signature = null;  // what was last built, so it is not built again
        this.owned     = [];    // names this put on the form, to take back off

        /*
         * The bar itself opens the editor: a double click, which is what a double
         * click means everywhere else in the designer, and the right button,
         * which is what the canvas and the tree already answer to.  Both on the
         * *background* of the bar and not on an entry -- an entry's two buttons
         * are spoken for, one dropping its menu and the other opening it too,
         * since a right click shows the menu of the nearest widget that has one.
         */
        this.ide[`${panel.Name}_DblClick`]  = () => this.edit();
        this.ide[`${panel.Name}_MouseDown`] = (x, y, button) => {
            if (button === 3) this.edit();
        };
    }

    /*
     * The menus of the form being designed, as the `.form` declares them, and
     * the `actions` beside them -- an item may be a place a command appears
     * rather than a command, and then its label is the command's.
     *
     * Called from `Designer.refresh`, which runs on every edit *and every change
     * of selection*, so it answers the cheap question first: a signature of what
     * would be built, against what was.  Rebuilding on every call would also
     * close whatever drop-down the user had open.  The control tree earns its
     * place on the same call the same way (`ControlTree.shape`).
     *
     * Answers whether anything changed, since what changed is a height, and the
     * designer has to resize the canvas when it does.
     */
    setSpec(menus, actions) {
        const spec      = Array.isArray(menus) ? menus : [];
        const signature = JSON.stringify([spec, actions || []]);

        if (signature === this.signature) return false;
        this.signature = signature;

        this.clear();
        this.panel.Visible = spec.length > 0;

        for (let i = 0; i < spec.length; i++) this.add(spec[i], i, actions);
        return true;
    }

    /* One top level menu: the word that shows its title and drops it. */
    add(node, index, actions) {
        const name  = `${PREVIEW}${this.serial}Item${index}`;
        const entry = new Label();

        entry.Name = name;
        /* A control has no mnemonic in this language, so a `_File` left as it
         * came would be shown with the underscore in it -- which is not what the
         * bar will look like.  The menu below keeps its own: those items go into
         * a real GMenu, and that parses them. */
        entry.Text = MenuBar.plain(node.text || node.name || "");
        /* The theme's own numbers for a `menubar > item`. */
        entry.Padding = ITEM_PADDING;

        /* **In the tree first.** A `Menu` names handlers on the form, so a widget
         * with no form yet has nowhere to dispatch to -- the runtime says so
         * where the property is set, and it is the loader's order too: bind the
         * control, then apply the properties. */
        this.panel.Add(entry);

        const children = Array.isArray(node.children) ? node.children : [];

        entry.Menu = this.sanitise(children, `${index}`, actions);

        this.items.push(entry);
        this.owned.push(name);

        /* Under the word, where a menu goes -- not over it.  The right button
         * needs no handler: it shows the menu of the nearest widget that has
         * one, which is this. */
        this.ide[`${name}_MouseDown`] = (x, y, button) => {
            if (button === 1) entry.PopupMenu(0, this.panel.Height);
        };
    }

    /*
     * The spec as it can safely be built **on the IDE's own form**, which is what
     * owns every widget on the board.  Three things would otherwise happen, and
     * none of them quietly:
     *
     *   1. A menu item is exposed on the form by its name (`make_item`, in
     *      `bta_menu.c`), so a previewed `MnuOpen` would *replace* the IDE's own
     *      `MnuOpen`.
     *   2. It dispatches by that name too -- `<name>_Click`, looked up on the
     *      form -- so clicking the preview would run the IDE's handler.  Opening
     *      a project by looking at a picture of a menu.
     *   3. A `shortcut` becomes an accelerator through
     *      `gtk_application_set_accels_for_action`, which is **the whole
     *      application**: a designed form with `<Control>s` in its menu would
     *      take Ctrl+S away from the IDE.
     *
     * So every item is renamed after its path -- deterministically, so rebuilding
     * the same menu reuses the same names instead of leaving a trail of them on
     * the form -- and no shortcut travels.  What the accelerators are is shown by
     * the menu editor, which is where they are edited.
     *
     * One more thing travels that cannot be stopped from here: a menu label goes
     * through the catalogue of the process that builds it (`append_item` calls
     * `bta_locale_lookup`), and this one is the IDE's.  So a designed item whose
     * text happens to be a string the IDE translates is drawn translated in the
     * preview.  The top level entries are not affected -- a `Text` assigned from
     * JS is not prose the loader read.
     */
    sanitise(list, path, actions) {
        const out = [];

        for (let i = 0; i < list.length; i++) {
            const node = list[i];
            const key  = `${path}_${i}`;

            if (node.separator) {
                out.push({ separator: true });
                continue;
            }

            /* A submenu needs no name of its own: the runtime asks for children
             * first and appends it by its label alone. */
            if (Array.isArray(node.children)) {
                out.push({ text: node.text || "",
                           children: this.sanitise(node.children, key, actions) });
                continue;
            }

            const name = `${PREVIEW}${this.serial}_${key}`;
            const item = { name,
                           text: node.text || MenuBar.actionText(node, actions) };

            /* A tick is worth showing -- it is the shape of the item, and ticking
             * a preview costs nothing.  `dynamic` is not: its entries are
             * assigned by the running application, so previewing one draws an
             * empty submenu, which says less than the plain item does.  `radio`
             * is a mark on those entries and is refused without them, so the two
             * go together. */
            if (node.check) item.check = true;

            out.push(item);

            /* What the item really is, so a click can open the handler it is
             * really named after.  An item that points at a command has no
             * handler of its own -- the command has it, and running the *IDE's*
             * command of that name is the bug this whole function is about -- so
             * that one opens the editor instead. */
            this.owned.push(name);
            this.ide[`${name}_Click`] = node.name
                ? () => this.ide.openHandler(node.name, "Click")
                : () => this.edit();
        }
        return out;
    }

    /* The menus themselves are edited where they have always been edited.  The
     * menu item and not the method under it, which is how the IDE reaches its
     * own commands. */
    edit() {
        this.ide.MnuMenus.Click();
    }

    /*
     * Everything this put on the IDE's form, taken back off.  Not housekeeping:
     * the names are the IDE's own namespace, and both a menu item and a closure
     * over this designer are strong references -- a form closed with its menus
     * still hanging off `MainForm` leaves a stale item answering to a name, and
     * holds the page that was closed.
     */
    clear() {
        for (const name of this.owned) {
            delete this.ide[name];                 /* the item, put there by the runtime */
            delete this.ide[`${name}_Click`];      /* the handlers, put there by this */
            delete this.ide[`${name}_MouseDown`];
        }
        this.owned = [];
        this.items = [];
        this.panel.Clear();
    }

    /* The page is closing and takes its canvas with it -- but not these, which
     * were never on it. */
    dispose() {
        this.clear();
        this.signature = null;
        this.panel.Visible = false;

        delete this.ide[`${this.panel.Name}_DblClick`];
        delete this.ide[`${this.panel.Name}_MouseDown`];
    }

    /*
     * How much of the window the bar takes, which is height the form's surface
     * does **not** have: `Form.Width/Height` is the size of the *window*, and the
     * runtime prepends the bar inside it.  So the board is `Width x Height` and
     * the canvas is what is left over, which is what the designer draws on.
     *
     * A real bar's height and not the one this happens to be allocated, and the
     * difference matters in one direction only: the canvas must give up what the
     * window will, whatever the preview came out at.  They agree -- an entry is a
     * label for exactly that reason -- and `Drawn` is what lets a test say so.
     */
    get Height() {
        return this.panel.Visible ? MenuBar.realHeight(this.ide) : 0;
    }

    /* What it actually came out at, which is only ever asked as a question. */
    get Drawn() {
        return this.panel.Visible ? this.panel.Bounds().Height : 0;
    }

    get Visible()   { return this.panel.Visible; }
    set Visible(on) { this.panel.Visible = on && this.items.length > 0; }

    /*
     * How tall a real menu bar is on this desktop, under this theme and this
     * font -- asked of a real one rather than assumed.
     *
     * The IDE is a form with menus, so its own window has a `GtkPopoverMenuBar`
     * prepended above its surface.  `Bounds()` answers in window coordinates and
     * the surface starts below the bar, so where the IDE's first control begins
     * is the bar's height.  Measured once: it can only change with the theme,
     * and a theme does not change under a running application.
     */
    static realHeight(ide) {
        if (MenuBar.measured) return MenuBar.measured;

        const at = ide.Pages && ide.Pages.Bounds();
        if (at && at.Y > 0) MenuBar.measured = at.Y;

        return MenuBar.measured || BAR_HEIGHT;
    }

    /*
     * A label without its mnemonic.  GTK's rule: `_` marks the letter to
     * underline and `__` is a literal one, so both are answered in one pass --
     * a `_` followed by an optional second is replaced by whatever that second
     * was, which drops the marker and keeps the pair.
     */
    static plain(text) {
        return text.replace(/_(_?)/g, "$1");
    }

    /* An item that points at a command shows the command's label unless it
     * brought one of its own -- the rule the runtime follows, said here because
     * the preview does not have the commands themselves. */
    static actionText(node, actions) {
        const found = (actions || []).find((a) => a.name === node.action);
        return (found && found.text) || node.action || "";
    }
};

/* One per open form, and the names they put on the IDE's form have to differ:
 * two designers previewing two forms are two sets of items, and the second must
 * not answer to the first one's names. */
Ide.MenuBar.serial = 0;
/* The measurement, shared: it is a fact about the desktop, not about a form. */
Ide.MenuBar.measured = 0;
