/*
 * The events the selection raises, as a page of the side panel.
 *
 * This is the other half of what the property grid does.  A control answers two
 * questions about itself -- what it *is* (`PropertyNames`) and what it *does*
 * (`EventNames`) -- and only the first one had a surface.  The second lived in
 * a dynamic menu, `Form -> Write handler`, which is a fine way to reach a
 * command and a poor way to read a list: it says nothing until it is opened,
 * and it closes the moment it is used.
 *
 * So the list is drawn instead, beside the properties it belongs with.  Every
 * event the selection raises, the handler each one would be written as, and a
 * mark on the ones the `.js` already answers -- which is the question somebody
 * standing in front of a form actually has: *what can this thing tell me, and
 * which of those am I already listening to?*
 *
 * Prior art: this is the Object Inspector's **Events** tab in Delphi and
 * Lazarus, and the right-hand procedure drop-down in Visual Basic.  Every
 * environment this one is in the spirit of shows the events beside the
 * properties; this is the only one that did not.
 *
 * **Nothing here decides anything.**  Which events exist is `Designer.eventsOf`,
 * which already knows a project's component from a control; which are written
 * is `FormFiles.handlersIn`; writing or jumping to one is
 * `FormFiles.openHandler`, the same call a double click on the canvas makes.
 * This class is three lookups and a list of rows, which is why a control that
 * grows an event in C shows up here without the IDE learning anything.
 *
 * One instance, on the IDE and not on the designer -- the panel is shared and
 * so is the selection, exactly like the palette.  What it keeps is a signature
 * of what it last drew, so hanging off `MainForm.refresh()` -- which runs on
 * every edit, every selection *and* every pixel of a form resize -- costs a
 * string compare rather than a rebuild.
 */
"use strict";

Namespace("Ide");

/* The mark on an event the `.js` already answers.  The same bullet the Form
 * menu uses, because it is the same fact being reported. */
const WRITTEN = "\u2022";   /* • the .js answers this one */

/* Wide enough for `ThemeChange`, which is the longest event any class raises. */
const NAME_W = 104;

/*
 * Which page of `SideTabs` this is.  Second, between the properties it belongs
 * with and the structure, which is Delphi's order and the reason for it: the
 * two pages about *the selection* are neighbours, and the palette and the tree
 * -- which are about the shape of the form -- are the other thing.
 */
const EVENTS_PAGE = 1;

Ide.Events = class Events {

    constructor(ide) {
        this.ide = ide;
        /* What the rows currently say, so an unchanged refresh does nothing. */
        this.drawn = null;
        /* Parallel to the rows: which event each one is about. */
        this.events = [];
    }

    /*
     * The control the page is about, or `null` for the form itself.
     *
     * The same target the property grid edits with nothing selected, and the
     * same one a double click on the bare canvas writes for -- `Designer.dblClick`
     * spells that `openHandler("Form", "Open")`, so "Form" is the name here too.
     */
    target() {
        return this.ide.designing ? this.ide.designer.selected : null;
    }

    /* The name a handler for this target is written under. */
    targetName() {
        const control = this.target();
        return control ? control.Name : "Form";
    }

    /*
     * Which events it raises, most derived first -- `EventNames()`'s own order,
     * whose head is the event a double click writes.
     *
     * For a control that is `Designer.eventsOf`, which answers for a component
     * of the project out of its class rather than out of the stand-in drawn for
     * it.  For the form it is the probe the grid already keeps: the form being
     * designed is not running, so there is no instance to ask and one is made
     * and never shown.
     */
    list() {
        if (!this.ide.designing) return [];

        const designer = this.ide.designer;
        const control  = designer.selected;

        if (control) return designer.eventsOf(control);
        return designer.grid.formProbe().EventNames();
    }

    /*
     * Redraw, if there is anything different to draw.
     *
     * Hung off `MainForm.refresh()`, which runs on every selection and on every
     * step of a form resize, so it answers *nothing changed* without touching
     * the source or the list: the page has to be on screen, and the signature
     * has to differ.  `tree.refresh()` next door makes the same bargain and for
     * the same reason.
     */
    fill() {
        if (!this.visible()) return;

        const name    = this.targetName();
        const events  = this.list();
        /* One read of the `.js`, and every event answered from it -- rather
         * than `hasHandler` per event, which reads it once each. */
        const written = Ide.FormFiles.handlersIn(
            this.ide.formFiles.siblingSource(), name);

        const signature = `${name}|${events.join(",")}|${written.join(",")}`;
        if (signature === this.drawn) return;

        this.drawn = signature;
        this.build(name, events, written);
    }

    /* Whether the page is on screen at all.  Hidden, it is redrawn when it is
     * shown, so nothing is lost by not keeping it up to date. */
    visible() {
        return this.ide.designing && this.ide.SidePanel.Visible &&
               this.ide.SideTabs.Current === EVENTS_PAGE;
    }

    /* The switcher moved to this page: whatever is there was drawn for another
     * selection, or for none. */
    shown() {
        this.drawn = null;
        this.fill();
    }

    build(name, events, written) {
        const list = this.ide.EventList;

        list.Clear();
        this.events = events.slice();

        if (!events.length) {
            const empty = new Label();
            empty.Text   = Locale.Text("Nothing here raises an event.");
            empty.Style  = "dim-label";
            empty.Margin = 8;
            empty.Wrap   = true;
            list.Add(empty);
            return;
        }

        for (const event of events) this.addRow(name, event, written.includes(event));
    }

    /*
     * One row: the mark, the event, and the method it is written as.
     *
     * The method name is shown whether or not it exists, because the naming
     * convention is the thing a newcomer does not know -- and it is what the
     * row is offering to write.  Dim until it is real.
     */
    addRow(name, event, exists) {
        const row = new Panel();
        row.Arrangement = "Horizontal";
        row.Spacing     = 6;
        row.Margin      = 2;
        this.ide.EventList.Add(row);      // the row first, then what is in it

        const mark = new Label();
        mark.Text  = exists ? WRITTEN : "";
        mark.Width = 12;
        row.Add(mark);

        /* Markup, because an answered event is shown in bold and the name is
         * what carries it.  An event name is an identifier: nothing to escape. */
        const label = new Label();
        label.Markup = true;
        label.Text   = exists ? `<b>${event}</b>` : event;
        label.Width  = NAME_W;
        label.HAlign = "Start";
        row.Add(label);

        const method = new Label();
        method.Text    = `${name}_${event}`;
        method.Style   = "dim-label";
        method.HExpand = true;
        method.HAlign  = "Start";
        method.Tooltip = exists
            ? Locale.Text("Go to this handler")
            : Locale.Text("Write this handler");
        row.Add(method);
    }

    /*
     * A row was activated: write the handler, or go to it.
     *
     * `openHandler` decides which of the two, exactly as it does for a double
     * click on the canvas -- so an event that is already answered is jumped to
     * rather than written twice, and this class never has to know which.
     */
    activated(index) {
        const event = this.events[index];
        if (!event) return;

        this.ide.openHandler(this.targetName(), event);
    }
};
