/*
 * forms.js -- the half of the prelude that is about widgets.
 *
 * Split out of rad.js when `Task` arrived, and the reason is the split: a
 * worker thread runs the same language and the same prelude, but it has no
 * widgets -- `bta_widgets_init` keeps each class's prototype and constructor
 * in a process-global table, so a second runtime running it would overwrite
 * the main thread's with values of its own.  The language half has to be
 * evaluable without `Widget` existing, and that is exactly what this file is
 * not.
 *
 * Evaluated straight after rad.js and before the hatches close, so the
 * captures at the top of rad.js (`defineProperty`, `prototypeOf`, `ownNames`,
 * `ownDescriptor`, `objectProto`, `hasOwn`) are still in scope: two
 * JS_EVAL_TYPE_GLOBAL evaluations share the global lexical scope, which is
 * the same fact `bta_lookup_global` exists for.
 *
 * `defaultsFor` and `sameValue` stayed in rad.js rather than coming here:
 * `Record` uses both, and neither is about widgets -- one is a bare instance
 * per class to compare against, the other is equality that understands arrays
 * and decimals.
 */
"use strict";
/*
 * A control's own bookkeeping, kept **off** the control.
 *
 * `__design` and `__item` are notes this file leaves on a widget -- what the
 * designer is showing instead of the declared value, and which component a list
 * draws its rows with.  They used to be own properties with the enumerable bit
 * off, which kept them out of `Dictionary.Keys` and out of `for...in` and was
 * enough for everything that looked.
 *
 * It is not enough for the thing that does not look: a widget's own properties
 * are supposed to be *its properties*, and these were two that were not.  See
 * [`docs/plans/strict-plan.md`](../../docs/plans/strict-plan.md) -- the whole
 * argument is there, and the short version is that `preventExtensions` cannot
 * tell a note from a typo, and a note created **later** than the widget (a
 * design value is written when the designer applies one) cannot be pre-created
 * either.
 *
 * A `WeakMap` is private to this file, invisible to `for...in`, to
 * `Dictionary.Keys`, to the serialiser and to `preventExtensions`, and it lets
 * the widget go when the widget goes.
 *
 * **Keyed by the widget, and not by a `Symbol`** -- and the reason is the
 * paragraph above, not availability.  `Symbol` *is* installed while this file
 * runs: `bta_close_hatches` takes it away only after both halves of the prelude
 * have been evaluated, and a symbol is a valid weak key on this engine besides.
 * What a symbol would buy is a symbol-keyed **own property** on the widget,
 * which is exactly the shape already ruled out: `preventExtensions` cannot tell
 * a note from a typo, it refuses one created later than the widget, and a
 * widget's own properties are supposed to be its properties.  The note has to
 * live off the widget, and a symbol does not put it there.
 *
 * `__declared` is **not** among them, and cannot be: `bta_form.c` defines and
 * writes it as the loader substitutes prose, so a bag private to this file
 * would make those writes invisible to the readers next to them.  It moved to
 * the widget's own struct instead, where both sides reach it.
 */
const designNotes = new WeakMap();
const itemNotes   = new WeakMap();

function noteBag(notes, widget) {
    let bag = notes.get(widget);
    if (!bag) {
        bag = {};
        notes.set(widget, bag);
    }
    return bag;
}

/*
 * The one both sides write: `__declared` is a getter and a setter on
 * `Widget.prototype`, answered from the widget's own struct, so what this file
 * writes and what `bta_form.c` writes are the same bag -- and neither of them is
 * an own property of the control.
 */
function declaredNotes(widget) {
    return widget.__declared || (widget.__declared = {});
}

/*
 * The name this class goes by in a .form -- qualified when it lives in a
 * namespace, bare when it does not.
 *
 * A constructor does not know its namespace: `Widgets.Stepper = class Stepper`
 * gives a ctor whose .name is "Stepper", because the class expression is what
 * was named and the assignment came after.  So it is looked up, once.
 */
Widget.TypeName = function (ctor) {
    if (!ctor || !ctor.name) return "";

    /* Own property only: class constructors inherit from their parent's, so a
     * plain `A extends B` would otherwise report B's qualified name. */
    if (hasOwn.call(ctor, "__type")) return ctor.__type;

    for (const ns of namespaces) {
        if (ns.obj[ctor.name] === ctor) {
            const full = `${ns.name}.${ctor.name}`;
            defineProperty(ctor, "__type", { value: full });
            return full;
        }
    }

    /* Not cached: a class assigned to a namespace after its first use would be
     * stuck with the bare name, and the walk above costs one property read per
     * namespace -- of which a project has a handful. */
    return ctor.name;
};

/*
 * Caption is the VB/Gambas spelling of Text.  Aliasing on the prototypes keeps
 * both names working on every control that has a caption, including in .form
 * files, since the loader just assigns properties.
 */
for (const cls of [Form, Label, Button, TextBox, CheckButton]) {
    defineProperty(cls.prototype, "Caption", {
        configurable: true,
        get() { return this.Text; },
        set(v) { this.Text = v; },
    });
}

/*
 * Controls: every child bound to this form, in creation order.  The .form
 * loader assigns each named control onto the form, so this is a view over the
 * form's own widget-valued properties.  (Children, by contrast, is the real
 * containment tree, one level at a time.)
 */
defineProperty(Form.prototype, "Controls", {
    configurable: true,
    get() {
        const out = [];
        for (const key in this) {
            const v = this[key];
            if (v instanceof Widget && v !== this) out.push(v);
        }
        return out;
    },
});

/*
 * Menus, as the .form declared them.  Read-only on purpose: it is the spec the
 * loader was given, not the live GMenu, and a getter with no setter is also how
 * the serialiser knows to leave it out of `properties` -- it belongs at the top
 * level of the file, next to `children`.
 *
 * Empty for a form with no menus, so callers never have to check for undefined.
 */
defineProperty(Form.prototype, "Menus", {
    configurable: true,
    get() { return Array.isArray(this.__menus) ? this.__menus : []; },
});

/*
 * Commands, as the .form declared them, and read-only for every reason `Menus`
 * is: it is the spec and not the live `GSimpleAction`, and a getter with no
 * setter is how the serialiser knows this belongs at the top level of the file
 * beside `children` rather than in `properties`.
 */
defineProperty(Form.prototype, "Actions", {
    configurable: true,
    get() { return Array.isArray(this.__actions) ? this.__actions : []; },
});

/* ------------------------------------------------------------------------
 * .form serialisation -- the inverse of the loader.
 *
 * Like the loader, this knows nothing about any particular control.  What is
 * worth saving is discovered: an accessor with both a getter and a setter is
 * a settable property, so it round-trips.  Read-only ones (ListBox.Count,
 * Editor.Line) are skipped because the loader could never assign them.
 *
 * Values equal to a freshly built control's are left out, so a .form file
 * says only what the designer actually changed.
 * ---------------------------------------------------------------------- */

/* Name is written as the node's `name`; Caption is an alias of Text and would
 * be written twice; Modified is editing state, not design state. */
const NOT_SAVED = ["Name", "Caption", "Modified"];

/* Only meaningful when the parent lays children out by coordinate. */
const POSITION = ["X", "Y"];

/*
 * The same question one step further along.  Inside a box a size is a *request*
 * -- a floor -- and the box decides the rest; and `Width`/`Height` report the
 * allocation when nothing was declared, which is what makes them worth reading
 * and dangerous to write down.  Saving what a control happened to measure turns
 * today's measurement into tomorrow's minimum: a notebook page measured 427 tall
 * keeps 427px of blank under the tab strip once the editor in it is hidden, at
 * every window size, and nothing on screen says why.
 *
 * So a size reaches the file only when somebody asked for one.  A control that
 * did -- a 34px button in a toolbar -- keeps it, because that is a decision and
 * not a measurement.
 */
const SIZE = ["Width", "Height"];


/* Settable properties, walking up to (but not including) Object.prototype. */
function settableProperties(widget) {
    const names = [];
    for (let p = prototypeOf(widget); p && p !== objectProto;
         p = prototypeOf(p)) {
        for (const key of ownNames(p)) {
            const d = ownDescriptor(p, key);
            if (d && typeof d.get === "function" && typeof d.set === "function"
                && !names.includes(key)) {
                names.push(key);
            }
        }
    }
    return names.sort();
}

function savableValue(v) {
    const t = typeof v;
    /* A `Decimal` is an object and **is** savable: `JSON.stringify` writes it
     * through its own `toJSON`, so a `.form` carries its machine text and the
     * setter reads it back.  Without this a decimal property -- a `DecimalBox`'s
     * `Value` -- was skipped in silence, which is a value the file never had. */
    return t === "string" || t === "number" || t === "boolean" || Array.isArray(v)
        || v instanceof Decimal;
}

/*
 * What the file said, for a property something has since substituted.
 *
 * The loader leaves a note -- `[declared, applied]` -- whenever it puts a value
 * on a control that is not the one written in the `.form`: prose that went
 * through the catalogue, or a design value the designer applied over it.  The
 * serialiser reads the *current* value of every property, so without the note a
 * form opened in Spanish and saved would come back with the Spanish in it and
 * the original gone.  That is the `Width`/`Height` trap exactly: today's
 * substitution written down as tomorrow's declaration.
 *
 * The note is only believed while what was applied is still what is there.
 * Anything that assigned since -- the property grid, application code -- is the
 * newer truth and wins, which is what makes this self-correcting: the grid does
 * not have to tell the serialiser it edited something.
 */
function declaredValue(widget, key, current) {
    const note = widget.__declared && widget.__declared[key];
    return note && sameValue(current, note[1]) ? note[0] : current;
}

function collectProperties(widget, isRoot, parentIsFixed) {
    /* A user's Form1 has no defaults of its own; compare against a bare Form. */
    const defaults = defaultsFor(isRoot ? Form : widget.constructor);
    const out = {};

    /* Arrangement leads: the loader applies properties before children, and a
     * container refuses to be re-arranged once it has any. */
    if ("Arrangement" in widget && !sameValue(widget.Arrangement, defaults.Arrangement)) {
        out.Arrangement = widget.Arrangement;
    }

    /* A form always carries its own size: it is the design, and there is no box
     * around it to decide otherwise. */
    const request = isRoot || parentIsFixed ? null : widget.SizeRequest();

    /*
     * A control bound to a command does not write its own `Enabled`, because it
     * does not have one: the command does, and the loader refuses to assign it.
     *
     * Without this, saving a form while a command was disabled -- which is an
     * ordinary state, since a command needing a selection has none when the
     * window opens -- wrote `"Enabled": false` onto every control naming it, and
     * the file **would not load again**. Found by serialising the first form
     * that had one.
     */
    const commanded = "Action" in widget && widget.Action !== "";

    for (const key of settableProperties(widget)) {
        if (key === "Arrangement" || NOT_SAVED.includes(key)) continue;
        if (key === "Enabled" && commanded) continue;
        if (POSITION.includes(key) && (isRoot || !parentIsFixed)) continue;
        /* Negative is GTK's own "no request", which is what a widget starts
         * with; a declared 0 is a decision like any other and is kept. */
        if (request && SIZE.includes(key) && request[SIZE.indexOf(key)] < 0) continue;

        const value = declaredValue(widget, key, widget[key]);
        if (!savableValue(value)) continue;
        if (sameValue(value, defaults[key])) continue;

        out[key] = value;
    }
    return out;
}

/*
 * The design values of one control, as the node's `design` block.
 *
 * A separate dictionary and not a marker inside `properties`, because the two
 * answer different questions: `properties` is what the application will run
 * with, `design` is what the *designer* should show so a form whose text the
 * code fills in can still be laid out.  Android's `tools:` namespace is the same
 * idea, and `strip` is the precedent for a node saying something that is neither
 * its type nor a property.
 *
 * Nothing here can reach a running application: the only code that applies a
 * design value is AddNode's designing branch, which the runtime never takes.
 */
function collectDesign(widget) {
    const bag = designNotes.get(widget);
    if (!bag) return null;

    const out = {};
    let   any = false;
    for (const key in bag) {
        out[key] = bag[key];
        any = true;
    }
    return any ? out : null;
}

function serializeChildren(container) {
    /*
     * A component is a black box: what is inside it belongs to its own .form and
     * is rebuilt from there, so writing it here would save the same tree twice
     * and load it back doubled.
     */
    if (container instanceof Component) return null;

    /*
     * ...and so is a list showing its design-time item. What is in it is a
     * drawing of the `item` the node declares, not this form's: writing it here
     * would turn three drawn rows into three real ones that the application then
     * builds again underneath. The same bargain one line up, for the same
     * reason.
     */
    if (container.Item) return null;

    const kids = container.Children;
    if (!kids || kids.length === 0) return null;

    const fixed = container.Arrangement === "Fixed";
    return kids.map((child) => child.Serialize(fixed));
}

/*
 * A widget as a .form node. `parentIsFixed` decides whether X/Y are part of
 * its identity or noise; a detached subtree is assumed to be laid out the RAD
 * way.
 */
/*
 * The properties a designer can offer for this widget: everything settable,
 * discovered the same way the serialiser discovers it, so a property grid and
 * a .form file can never disagree about what exists.
 */
Widget.prototype.PropertyNames = function () {
    return settableProperties(this).filter((key) => key !== "Caption");
};

/*
 * The parameters of the methods written here rather than in C.
 *
 * A method of a class in the table declares its signature in a one-line comment
 * beside the entry and the build turns those into a table; a method written in
 * JavaScript has nowhere to put one, because `Function.length` is a count and
 * not a name. So the class states them, exactly as a component of the project
 * does with its own `static Signatures` -- and `Widget.Signature(type, name)`
 * reads either. `Form` and `Notebook` override `Serialize`, so each declares
 * its own; a subclass's declaration is found at its own step of the walk.
 */
Widget.Signatures = {
    PropertyNames: "()",
    Serialize:     "(parentIsFixed)",
    Apply:         "(properties)",
    Dump:          "()",
    Declared:      "(name)",
    Fill:          "(...values)",
    SetDesign:     "(name, value)",
    DesignValue:   "(name)",
    SetItem:       "(of, count)",
};

Form.Signatures     = { Serialize: "()", SaveForm: "(path)" };
Notebook.Signatures = { Serialize: "(parentIsFixed)" };
Container.Signatures = { AddNode: "(node)", BuildChildren: "(node)" };

Widget.prototype.Serialize = function (parentIsFixed = true) {
    const node = { type: Widget.TypeName(this.constructor) };
    if (this.Name) node.name = this.Name;

    node.properties = collectProperties(this, false, parentIsFixed);

    const design = collectDesign(this);
    if (design) node.design = design;

    /* Written as it was set, and read by nothing here: see SetItem. */
    const item = this.Item;
    if (item) node.item = item;

    const children = "Children" in this ? serializeChildren(this) : null;
    if (children) node.children = children;

    return node;
};

/*
 * A notebook writes what is in its tab strip along with its pages, each marked
 * with the end it sits at.
 *
 * It has to be said here rather than discovered: `Children` counts pages -- that
 * is what a page means -- so the generic walk cannot see a strip widget, and a
 * form that had one would lose it the first time it was saved.  The same reason
 * `Tabs` exists, and the same reason a Form writes its `menus` by hand.
 */
Notebook.prototype.Serialize = function (parentIsFixed = true) {
    const node = Widget.prototype.Serialize.call(this, parentIsFixed);

    for (const where of ["Start", "End"]) {
        const control = this.GetAction(where);
        if (!control) continue;

        /* A strip widget has no coordinates: the strip decides where it goes. */
        const child = control.Serialize(false);
        child.strip = where;
        (node.children = node.children || []).push(child);
    }
    return node;
};

/* A form serialises to the whole file, keyed by class rather than type. */
Form.prototype.Serialize = function () {
    const out = {
        format: "bintana-form/1",
        class: Widget.TypeName(this.constructor),
        properties: collectProperties(this, true, false),
    };

    const design = collectDesign(this);
    if (design) out.design = design;

    /*
     * Before children, which is where the loader and the IDE's own files put
     * them.  A form that has none writes no key at all.
     *
     * Commands before menus, in the order the loader reads them: an item and a
     * control may both name one, so a file whose blocks were the other way
     * round would be a file that cannot be loaded.
     */
    if (this.Actions.length) out.actions = this.Actions;
    if (this.Menus.length)   out.menus   = this.Menus;

    const children = serializeChildren(this);
    if (children) out.children = children;

    return out;
};

Form.prototype.SaveForm = function (path) {
    File.SaveJson(path, this.Serialize());
};

/*
 * The widget tree as text, with what GTK actually allocated.
 *
 * A window says in a dozen lines what a screenshot says in a picture, and unlike
 * a picture it can be diffed, asserted on, and read without eyes.  Bounds() and
 * not Width/Height on purpose: those report the *request*, and the whole point
 * is to see what came out the other end.
 *
 *   Panel1        160x120 @(16,16)
 *     Button1     110x34  @(20,20)  "Save"
 *     Label1  hidden
 */
Widget.prototype.Dump = function (indent = "") {
    const at   = this.Bounds();
    const kind = this.constructor.name;
    const name = this.Name || "(unnamed)";

    let line = `${indent}${name}  ${kind} ${at.Width}x${at.Height} @(${at.X},${at.Y})`;
    if (!this.Visible) line += "  hidden";

    /* Only what a control shows: a container's Text is its title, a list's is
     * its selection, and either is worth seeing. */
    try {
        if (typeof this.Text === "string" && this.Text !== "") {
            const text = this.Text.length > 40 ? `${this.Text.slice(0, 40)}...` : this.Text;
            line += `  ${JSON.stringify(text)}`;
        }
    } catch (e) { /* a control whose Text throws has nothing to show */ }

    const kids = "Children" in this ? this.Children : [];
    for (const child of kids) line += `\n${child.Dump(`${indent}  `)}`;

    return line;
};

/*
 * The other direction: build a live widget from a .form node.  The C loader
 * does exactly this while opening a form; having it in JS too is what lets the
 * designer show a form it is not running.
 */
/*
 * Every property in a dictionary, assigned.  The other half of Serialize: that
 * one turns a control into a node's `properties`, this one turns them back.
 *
 * Published rather than left as a loop everyone writes again -- applying a bag
 * of settings to a control is what a .form does, what a designer does, and what
 * an application restoring its own state does.  A missing dictionary applies
 * nothing, so the caller never has to check.
 */
Widget.prototype.Apply = function (properties) {
    for (const key in properties) this[key] = properties[key];
    return this;
};

/*
 * What the `.form` declared for a property, whatever has been put on it since.
 *
 * For anything the loader did not substitute this is just the current value,
 * which is the honest answer: nothing has been standing in for it.
 */
Widget.prototype.Declared = function (name) {
    const note = this.__declared && this.__declared[name];
    return note ? note[0] : this[name];
};

/*
 * The declared Text as a template, filled in with these arguments.
 *
 *     "properties": { "Text": "{0} files, {1} unsaved" }
 *     this.LblStatus.Fill(files.length, dirty.length);
 *
 * Which is the point: in a RAD environment writing text in code is the
 * exception, and a label with a number in it was the most common reason to
 * break that rule.  Here the template stays in the `.form` -- designable,
 * translated on load, extracted with everything else -- and the code passes
 * data rather than prose.
 *
 * It re-reads the *declared* template every time rather than keeping one, so
 * calling it twice does not fill in its own output; and it goes through
 * Locale.Text, so the template a translator wrote is the one that gets the
 * arguments -- with the holes wherever that language needs them.
 *
 * Named Fill and not Format because `Format` is already a DatePicker property,
 * and a method that shadows a property breaks silently the moment a `.form`
 * assigns it (see TreeView.ExpandNode for the same collision).
 */
Widget.prototype.Fill = function (...args) {
    const declared = String(this.Declared("Text"));
    const filled   = Locale.Text(declared, ...args);

    this.Text = filled;

    /*
     * The filled text stands in for the declared template exactly as a
     * translation does, so it leaves the same kind of note -- otherwise saving a
     * form whose labels had been filled in would write "1 unsaved of 7" into the
     * file where the template belongs, which is the trap this note exists for.
     */
    declaredNotes(this).Text = [declared, filled];
    return this;
};

/*
 * The value the *designer* shows for a property, over whatever the file says.
 *
 * Only the designer applies these, so this is how it writes one: the note keeps
 * the declared value, so saving still writes the real one to `properties` and
 * the design value to `design`.  An empty value removes it -- a design value of
 * nothing would show nothing, which is the state it is there to avoid.
 */
/*
 * What a list holds while it is being designed: a component, some number of
 * times.
 *
 * A list is filled by the program, so in a designer it is an empty box, and a
 * form is laid out *around* one -- how tall its rows are decides whether what is
 * under it collides. This is the answer Android's `tools:listitem` gives, and
 * the same one: a design-time item the editor draws and the application never
 * sees. Here it names a **component**, because that is the only thing the two
 * sides can agree on -- the form's own code can build the same class, so the
 * drawing and the program are the same widget rather than two that drift.
 *
 * **The runtime carries it and applies nothing**, which is what `design` already
 * does and for the same reason: the file has to survive a round trip through a
 * designer that opened it, and only the serialiser sees every node. A designer
 * cannot put the key back by itself, because `Serialize` recurses past it for
 * anything nested.
 *
 * It is a hidden note and not a property, so `settableProperties` never finds
 * it: it must not turn up in a property grid, in `properties`, or in
 * `PropertyNames()`. `Item` hands back exactly what the node will hold, so there
 * is one spelling of it and not two.
 */
Widget.prototype.SetItem = function (of, count) {
    const name = String(of || "").trim();

    if (!name) {
        const had = itemNotes.get(this);
        if (had) delete had.of;
        return this;
    }
    const n = Math.round(Number(count));
    const bag = noteBag(itemNotes, this);

    bag.of = name;
    if (Number.isFinite(n) && n > 0) bag.count = n;
    else delete bag.count;
    return this;
};

defineProperty(Widget.prototype, "Item", {
    get() {
        const bag = itemNotes.get(this);
        if (!bag || !bag.of) return null;
        return bag.count === undefined ? { of: bag.of }
                                       : { of: bag.of, count: bag.count };
    },
    configurable: true,
});

Widget.prototype.SetDesign = function (name, value) {
    const declared = this.Declared(name);

    if (value === undefined || value === "") {
        const design = designNotes.get(this);
        if (design) delete design[name];
        if (this.__declared) delete this.__declared[name];
        this[name] = declared;
        return this;
    }

    noteBag(designNotes, this)[name] = value;
    this[name]                       = value;
    declaredNotes(this)[name]        = [declared, value];
    return this;
};

/* What the designer is showing instead of the declared value, or undefined. */
Widget.prototype.DesignValue = function (name) {
    const bag = designNotes.get(this);
    return bag ? bag[name] : undefined;
};

/*
 * Prose through the catalogue, the way the C loader does it on its way in.
 *
 * `Apply` deliberately does *not* do this: it is the published "assign a bag of
 * properties" method, so `btn.Apply({ Text: customer.Name })` would look a
 * customer's name up in the catalogue -- which is the data-joins-the-catalogue
 * bug that kept translation out of the setters.  A `.form` node is different:
 * its strings are literals written by whoever designed the form.
 */
function translateDeclared(value) {
    if (typeof value === "string") return Locale.Text(value);
    if (Array.isArray(value)) {
        return value.map((v) => (typeof v === "string" ? Locale.Text(v) : v));
    }
    return value;
}

function applyNode(widget, node, designing) {
    const properties = node.properties || {};
    const texts      = widget.TextProperties();

    for (const key in properties) {
        const declared = properties[key];
        const applied  = !designing && texts.includes(key)
            ? translateDeclared(declared) : declared;

        widget[key] = applied;

        /* Every declared piece of prose leaves a note, substituted or not: see
         * Declared() and Fill(), which need to know what the file said about a
         * control whose text has since been filled in.  Through the accessor,
         * so the note lives on the widget's struct and not on the widget. */
        if (texts.includes(key)) {
            declaredNotes(widget)[key] = [declared, applied];
        }
    }

    /*
     * A design value only exists while a form is being drawn.  The runtime
     * never takes this branch -- the C loader has no idea `design` is a key --
     * so a design value cannot reach a running application even by accident.
     */
    if (designing) {
        for (const key in node.design || {}) widget.SetDesign(key, node.design[key]);
    }
}

/*
 * `designing` says this tree is a *drawing* of an application rather than one:
 * prose is left as the file wrote it (so the designer shows msgids and a save
 * cannot bake a translation into the file), and the `design` block is applied
 * over the properties.
 *
 * A parameter and not a property of the container, because it has to hold for
 * the whole subtree being built and a container's children change parents; the
 * designer already turns `Anchored` off by hand for the same kind of reason.
 */
Container.prototype.AddNode = function (node, designing = false) {
    /* Widget.New and not a global by name: a project's own classes -- a
     * component's above all -- live in the global lexical scope and never land
     * on the global object, so looking one up there finds nothing. */
    const widget = Widget.New(node.type);
    if (node.name) widget.Name = node.name;

    /*
     * `strip` puts the control in a Notebook's tab strip instead of making it a
     * page.  A notebook's children *are* its pages, so without a word for it
     * there was no way to declare the one other thing a notebook can hold --
     * and a strip widget added from code was lost by the next save.
     *
     * Named before it goes in, because that is what its events are looked up
     * by, and the properties applied after, exactly as for a page.
     */
    if (node.strip && "SetAction" in this) this.SetAction(widget, node.strip);
    else                                   this.Add(widget);

    applyNode(widget, node, designing);

    for (const child of node.children || []) {
        widget.AddNode(child, designing);
    }
    return widget;
};

/* Replaces this container's contents with the node's children. */
Container.prototype.BuildChildren = function (node, designing = false) {
    this.Clear();
    for (const child of node.children || []) this.AddNode(child, designing);
};

/* ------------------------------------------------------------------------
 * Records -- the shape data has, declared once.
 *
 * A control declares its properties and everything else *discovers* them: the
 * serialiser writes what it finds, a property grid edits it, a drop-down appears
 * for a property that says what it accepts.  Data had no equivalent -- nothing
 * that is to an invoice what Button is to a button -- so every program that read
 * a JSON file did the same three things by hand: name the keys, check them, and
 * complain about them.
 *
 *   class Customer extends Record {
 *       static Fields = {
 *           Name:  Field.Text({ required: true, max: 80 }),
 *           Since: Field.Date(),
 *           Level: Field.Enum(["Retail", "Wholesale"]),
 *       };
 *   }
 *
 * What that produces is **ordinary accessors on the prototype**, so a record is
 * discovered by exactly the machinery a widget is -- and a field written by hand
 * (a computed one, a check nothing here can express) is a field like any other.
 * Declaring is only how the accessors get written; it is not a second place the
 * shape lives.
 *
 * The values live in a bag this file can reach and an application cannot, which
 * is what makes the setter the only way in: assigning "" to a required field
 * throws, and there is no `customer._Name` to go around it with.  Reading a file
 * is the one thing that has to get past the setters -- a row that no longer
 * satisfies today's rules must still be readable, or it can never be corrected
 * -- so `Load` fills the bag itself and reports what it could not accept.
 * ---------------------------------------------------------------------- */

/*
 * Per kind: what a field of it starts at, and the options it takes beyond the
 * common ones.  Anything else is a typo, and a typo in a declaration deserves a
 * complaint when it is declared rather than a property that silently is not
 * checked.
 */
