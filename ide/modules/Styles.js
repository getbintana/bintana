/*
 * What the desktop's theme says about its own style classes -- **generated**.
 *
 *   tests/styles.sh --json > the rows below
 *
 * `Style` takes any class name and always will: which ones exist is the theme's
 * answer, the project's, and that of whatever theme the person has installed, so
 * nothing here is a gate. This is what the chooser *orders* by, because a list
 * that offers `boxed-list` for a `Label` and `suggested-action` for a `Slider` is
 * a list nobody can read.
 *
 * Two things the selectors say, and both matter:
 *
 *   `on`    the nodes the theme writes the class for -- `button.flat` reaches a
 *           `Button` and never a `ColorButton`, whose node is `colorbutton`.
 *           `"any"` is a class left unqualified: it applies wherever it is put.
 *   `kids`  the class styles `> children` rather than the thing carrying it, so
 *           it needs a widget whose children really are those: `.linked > button`
 *           wants a container of buttons, `.boxed-list > row` a widget whose
 *           children are rows -- which no control here can be.
 *
 * Stale rows cost ordering and nothing else. The vocabulary itself, and the node
 * each control is, are in docs/widgets.md.
 */
"use strict";

Namespace("Ide");

Ide.Styles = class Styles {

    /* The theme this was generated from, said out loud: another desktop's may
     * differ, and the ordering is a hint rather than a fact about the machine
     * the IDE happens to be running on. */
    static get theme() { return "GTK 4.22.4, Adwaita (Default-light)"; }

    static get all() { return CLASSES; }

    /*
     * Whether a class can reach a control whose CSS node is `node`.
     *
     * A class written for another node is accepted, saved into the `.form` and
     * does nothing; a class that styles children needs children of that kind,
     * and the ones a user can place are the ones some control here *is*.
     */
    static fits(entry, node, placeable, container) {
        if (!entry) return true;
        if (entry.on.includes(node)) return true;
        if (!entry.on.includes("any")) return false;
        if (!entry.kids.length) return true;

        /*
         * It styles `> children`, so it needs children -- and children one can
         * *put there*: `toolbar` dresses the buttons inside, which a `Panel`
         * can hold and a `ListBox` cannot, since what a ListBox holds is
         * strings. A control that takes no controls is out whatever the class.
         */
        if (!container) return false;

        return entry.kids.every((k) => placeable.includes(k));
    }

    /*
     * Why it does not, **in controls rather than in nodes**.
     *
     * `boxed-list` is written `.boxed-list > row`, and saying so to somebody who
     * selected a list and got told about a `scrolledwindow` is answering a
     * question they did not ask. What they need is either the control this class
     * is for -- and there is one, by name -- or that this one keeps the part it
     * dresses inside itself, which `Style` cannot reach and a rule in `app.css`
     * can.
     *
     * `owners` maps a CSS node to the controls that are one: the IDE works it
     * out from the runtime, so it names widgets that really exist here.
     */
    static why(entry, owners) {
        if (!entry) return "";

        if (!entry.on.includes("any")) {
            const names = entry.on.flatMap((n) => owners[n] || []);

            /* Named for a node no control here *is* -- `data-table` is written
             * for the `columnview` a TableView keeps inside its scroller -- which
             * is the same answer as a class that styles children. */
            if (names.length) {
                return Locale.Text("The theme writes this one for {0}.",
                                   names.join(", "));
            }
        }
        return Locale.Text(
            "It dresses what a control keeps inside itself, which a class on the " +
            "control cannot reach. A rule of your own in app.css can: see the " +
            "styling section of docs/widgets.md.");
    }

    static find(name) {
        return CLASSES.find((c) => c.name === name) || null;
    }
};

/* Generated -- see the header. */
const CLASSES = [
    { name: "large-title",         group: "type",      on: ["any"],                                       kids: [] },
    { name: "title-1",             group: "type",      on: ["any"],                                       kids: [] },
    { name: "title-2",             group: "type",      on: ["any"],                                       kids: [] },
    { name: "title-3",             group: "type",      on: ["any"],                                       kids: [] },
    { name: "title-4",             group: "type",      on: ["any"],                                       kids: [] },
    { name: "heading",             group: "type",      on: ["any"],                                       kids: [] },
    { name: "body",                group: "type",      on: ["any"],                                       kids: [] },
    { name: "caption-heading",     group: "type",      on: ["any"],                                       kids: [] },
    { name: "caption",             group: "type",      on: ["any"],                                       kids: [] },
    { name: "title",               group: "type",      on: ["any", "label"],                              kids: [] },
    { name: "subtitle",            group: "type",      on: ["any"],                                       kids: [] },
    { name: "dim-label",           group: "type",      on: ["any"],                                       kids: [] },
    { name: "monospace",           group: "type",      on: ["any"],                                       kids: [] },
    { name: "suggested-action",    group: "buttons",   on: ["button"],                                    kids: [] },
    { name: "destructive-action",  group: "buttons",   on: ["button"],                                    kids: [] },
    { name: "flat",                group: "buttons",   on: ["arrow", "button", "entry", "modelbutton", "spinbutton", "text"], kids: [] },
    { name: "circular",            group: "buttons",   on: ["box", "button", "menubutton", "stackswitcher"], kids: ["button"] },
    { name: "image-button",        group: "buttons",   on: ["arrow", "button"],                           kids: [] },
    { name: "text-button",         group: "buttons",   on: ["arrow", "button", "checkbutton"],            kids: [] },
    { name: "error",               group: "state",     on: ["entry", "infobar", "label", "spinbutton", "text"], kids: ["revealer", "selection"] },
    { name: "warning",             group: "state",     on: ["entry", "infobar", "spinbutton", "text"],    kids: ["revealer", "selection"] },
    { name: "needs-attention",     group: "state",     on: ["button", "row"],                             kids: ["image", "label"] },
    { name: "frame",               group: "surfaces",  on: ["any"],                                       kids: [] },
    { name: "view",                group: "surfaces",  on: ["any", "columnview", "listview", "treeview"], kids: ["dndtarget", "header", "rubberband"] },
    { name: "background",          group: "surfaces",  on: ["any", "popover", "tooltip"],                 kids: ["arrow", "contents"] },
    { name: "osd",                 group: "surfaces",  on: ["any", "button", "image", "progressbar"],     kids: ["trough"] },
    { name: "toolbar",             group: "surfaces",  on: ["any"],                                       kids: ["button"] },
    { name: "linked",              group: "surfaces",  on: ["any", "combobox", "dropdown"],               kids: ["appchooserbutton", "button", "colorbutton", "combobox", "dropdown", "entry", "filechooserbutton", "fontbutton", "menubutton", "spinbutton"] },
    { name: "sidebar",             group: "surfaces",  on: ["any", "button", "image", "label", "row", "separator"], kids: ["label"] },
    { name: "content-view",        group: "surfaces",  on: ["any", "iconview"],                           kids: ["rubberband"] },
    { name: "boxed-list",          group: "lists",     on: ["any"],                                       kids: ["row"] },
    { name: "rich-list",           group: "lists",     on: ["any"],                                       kids: ["header", "row"] },
    { name: "navigation-sidebar",  group: "lists",     on: ["any"],                                       kids: ["row", "separator"] },
    { name: "data-table",          group: "lists",     on: ["columnview"],                                kids: ["listview"] },
];
