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
/**
 * the name a class is written under in a `.form` — qualified by its namespace,
 * which a constructor does not know by itself
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
 * The accessors forms.js adds to classes the C made are written as classes of
 * their own and copied across, rather than as `defineProperty` calls: a class
 * is a declaration the parser reads, so each one says what it is for in the
 * JSDoc comment above it the way any member does, and `Widget.Members` finds
 * it there.  A class the prelude declares and never installs is read as that
 * kind of mixin -- see `prelude_mark` in bta_widget.c.  The copy keeps what
 * `defineProperty` gave them: configurable, not enumerable.
 */
function mixIn(from, ...into) {
    for (const key of ownNames(from.prototype)) {
        if (key === "constructor") continue;
        for (const cls of into)
            defineProperty(cls.prototype, key, ownDescriptor(from.prototype, key));
    }
}

/*
 * Caption is the VB/Gambas spelling of Text.  Aliasing on the prototypes keeps
 * both names working on every control that has a caption, including in .form
 * files, since the loader just assigns properties.
 */
class Captioned {
    /** an alias of `Text` on `Form`, `Label`, `Button`, `TextBox` and `CheckButton` */
    get Caption() { return this.Text; }
    set Caption(v) { this.Text = v; }
}
mixIn(Captioned, Form, Label, Button, TextBox, CheckButton);

class FormMembers {
    /*
     * Controls: every child bound to this form, in creation order.  The .form
     * loader assigns each named control onto the form, so this is a view over
     * the form's own widget-valued properties.  (Children, by contrast, is the
     * real containment tree, one level at a time.)
     */
    /**
     * every child bound to the form by name, in creation order. `Children` is
     * the containment tree instead, one level deep
     */
    get Controls() {
        const out = [];
        for (const key in this) {
            const v = this[key];
            if (v instanceof Widget && v !== this) out.push(v);
        }
        return out;
    }

    /*
     * Menus, as the .form declared them.  Read-only on purpose: it is the spec
     * the loader was given, not the live GMenu, and a getter with no setter is
     * also how the serialiser knows to leave it out of `properties` -- it
     * belongs at the top level of the file, next to `children`.
     *
     * Empty for a form with no menus, so callers never have to check for
     * undefined.
     */
    /**
     * the menu spec as declared. It cannot be read back from GTK, which is why
     * the spec is kept; `[]` when there are none
     */
    get Menus() { return Array.isArray(this.__menus) ? this.__menus : []; }

    /*
     * Commands, as the .form declared them, and read-only for every reason
     * `Menus` is: it is the spec and not the live `GSimpleAction`, and a getter
     * with no setter is how the serialiser knows this belongs at the top level
     * of the file beside `children` rather than in `properties`.
     */
    /**
     * the commands as the `.form` declared them — the spec, not the live
     * actions; `[]` when there are none
     */
    get Actions() { return Array.isArray(this.__actions) ? this.__actions : []; }
}
mixIn(FormMembers, Form);

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


/*
 * Settable properties, walking up to (but not including) Object.prototype.
 *
 * **The most derived class that declares a name decides whether it is
 * settable**, which is the same boundary `Widget.Member` walks to and the
 * reason the guard is a `seen` list rather than a check on the result. It was
 * once "whichever class in the chain happens to have both a getter and a
 * setter", so a subclass could not take a property away: `Popover` declares
 * `Visible` getter-only -- it is the open state and assigning it would build a
 * popup surface before the window exists -- and the walk went on to `Widget`'s
 * getter/setter pair and offered, serialised and loaded a property the class
 * had just refused. A read-only override that the property grid and the
 * serialiser both ignore is what a class says *this is a question, not a
 * switch* with.
 *
 * **And a `__` name is skipped, because it is a note and not a property.** The
 * runtime keeps its own notes about a widget -- `__declared`, `__children`,
 * `__menus`, `__actions` -- as accessors on `Widget.prototype`, and
 * `__declared` is the one with a setter, since the loader and `rad.js` both
 * write it. That pair is exactly what this walk looks for, so without the line
 * below the property grid offered a note for editing. A note is readable from
 * JavaScript and is nothing a `.form` carries.
 */
/*
 * The names each prototype declares, and which of them are settable.
 *
 * **The walk was the most expensive thing in the runtime**, and it is on the
 * path the property grid takes on every selection and the serialiser takes on
 * every control of every save: a descriptor for every name of every prototype
 * in the chain -- 87 of them for a `Button` -- and **233 microseconds a
 * call**, measured.
 *
 * So the answer is cached per prototype, and **validated by the number of
 * names the prototype has**: a member added or removed rebuilds the entry,
 * and a prototype that did not change costs one array. Measured over 20000
 * calls: 4650 ms -> 1222 ms, **233 us -> 61 us**.
 *
 * A prototype whose members are *replaced* -- the same number, a different
 * kind -- is not noticed, and that is the one case left: the runtime changes
 * a prototype at load time and nothing else does.
 */
const settableCache = new WeakMap();

function settableProperties(widget) {
    const out  = [];
    const seen = new Set();

    for (let p = prototypeOf(widget); p && p !== objectProto;
         p = prototypeOf(p)) {
        let entry = settableCache.get(p);
        const names = ownNames(p);

        if (!entry || entry.count !== names.length) {
            const ok = [];
            for (const key of names) {
                const d = ownDescriptor(p, key);
                ok.push(!!(d && typeof d.get === "function" &&
                           typeof d.set === "function" &&
                           !key.startsWith("__")));
            }
            entry = { count: names.length, names, ok };
            settableCache.set(p, entry);
        }

        /*
         * **Every name is marked seen, not only the settable ones**: the most
         * derived class that declares a name decides whether it is settable,
         * and a read-only override has to be able to take a property away --
         * which is the whole of the rule the comment above states.
         */
        for (let i = 0; i < entry.names.length; i++) {
            const key = entry.names[i];
            if (seen.has(key)) continue;
            seen.add(key);
            if (entry.ok[i]) out.push(key);
        }
    }
    return out.sort();
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
/**
 * every settable property, found along the prototype chain — including the ones
 * a component of your own declares
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

Form.Signatures     = { Serialize: "()", SaveForm: "(path)", Bind: "(record)",
                        Rows: "(record)", Reload: "()" };
Notebook.Signatures = { Serialize: "(parentIsFixed)" };
Container.Signatures = { AddNode: "(node)", BuildChildren: "(node)" };

/** this widget as a `.form` node */
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
/** this notebook as a `.form` node, its pages' captions included */
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
/** the whole file, keyed by class */
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

/** `Serialize()` plus `File.Save`, pretty-printed */
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
/**
 * prints the whole subtree with the geometry GTK really allocated. **Reach for
 * this instead of a screenshot**, in a test and while working
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
/**
 * the widget: the inverse of `Serialize`. A missing dictionary applies nothing,
 * so `Apply(maybe)` is safe
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
/**
 * what the `.form` said, whatever has been assigned since — which is what makes
 * `Fill` possible on a control that has already been filled once
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
/**
 * fills the **declared** text as a template: a `Label` declared `"{0} files"`
 * and filled with `12` reads *12 files*, and the number stays out of the
 * catalogue
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
/**
 * a container: the component the **designer** draws in it while a form is being
 * laid out, and how many. `of: ""` removes it. Unreachable from a running
 * application, which builds the real rows itself
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

class ItemMembers {
    /**
     * `{ of, count }`, or `null`. While it is set the serialiser writes that
     * key and **no children**: what is in the container is a drawing and not
     * the form's
     */
    get Item() {
        const bag = itemNotes.get(this);
        if (!bag || !bag.of) return null;
        return bag.count === undefined ? { of: bag.of }
                                       : { of: bag.of, count: bag.count };
    }
}
mixIn(ItemMembers, Widget);

/**
 * what the *designer* shows instead; `""` removes it. Unreachable from a
 * running application
 */
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
/** the value `SetDesign` gave that property, or `undefined` */
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

/*
 * **A drawing publishes nothing on the form it is drawn on.** A control's
 * `Menu` and a table's `HeaderMenu` put every item on the form by name, and a
 * drawing's form is the *designer's* -- so a drawn menu replaced the host's
 * own items of the same name (the IDE drawing its own `MainForm.form` took the
 * real tab strip's menu away), dispatched to the host's handlers, and took its
 * accelerators. Now that a second menu taking a name is refused, it would
 * refuse instead and the control would become a stand-in. So in a drawing the
 * two are kept as the file says -- a note the serialiser writes back, the same
 * one a translated caption leaves -- and not built. The menu bar is the
 * designer's own preview (`Ide.MenuBar`), which sanitises for the same reasons.
 */
/*
 * `Action` joins them for the same reason: it is looked up among the actions of
 * the form the control is on, which in a drawing is the IDE's.  A command the
 * IDE has not got (`ActSettings` in bintana-project) threw, so every button
 * bound to one became a grey stand-in -- and one it *has* (`ActOpen`) bound the
 * drawn button to the IDE's own command, which it would then run.
 */
const DRAWN_NOT_BUILT = ["Menu", "HeaderMenu", "Action"];

function applyNode(widget, node, designing) {
    const properties = node.properties || {};
    const texts      = widget.TextProperties();

    for (const key in properties) {
        const declared = properties[key];

        if (designing && DRAWN_NOT_BUILT.includes(key)) {
            declaredNotes(widget)[key] = [declared, widget[key]];
            continue;
        }
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
/** builds a live widget from a `.form` node and adds it */
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
/** replaces the contents with that node's children */
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

/* ------------------------------------------------------------------------
 * A form that edits a record.
 *
 * `Record` on the form says which shape it edits; `DataField` on a control
 * says which field of it that control shows; `Bind()` puts a record on the
 * screen and takes it back when the person is done with a field.
 *
 * **The three are ordinary properties**, so all three are designable,
 * serialisable and editable with no other change -- the invariant the runtime
 * rests on.  What is written here is the half a `.form` cannot say: when the
 * value moves, and what happens when the field refuses it.
 *
 * The design is `docs/plans/data-plan.md`, and it was argued on two screens
 * written by hand (`examples/quote` and `examples/clients`).  Three things
 * that plan found and this follows:
 *
 * - **The value moves when the control is done being edited**, on `Activate`
 *   and on losing the focus -- not on every keystroke, which would refuse a
 *   half-typed word and a date in the middle of being written.
 * - **A form that shows a record reads it straight back**, because every
 *   assignment to a control raises a real `Change`.  The guard is here, once,
 *   and not in every form that binds something.
 * - **A refusal belongs beside the field**, not in a dialog: twelve fields
 *   and an exception is twelve dialogs.
 * ------------------------------------------------------------------------ */

/* The field a control shows, and the sentence it last refused.  Both are the
 * runtime's own notes on a control, so they live in a WeakMap and not on the
 * control: a widget's own properties are exactly its properties, and the
 * strict mode is the test that this landed. */
const dataFields  = new WeakMap();
const fieldErrors = new WeakMap();

class DataMembers {
    /** the field this control shows, or `""` */
    get DataField() {
        return dataFields.get(this) || "";
    }
    set DataField(value) {
        if (value === undefined || value === null || value === "") {
            dataFields.delete(this);
            fieldErrors.delete(this);
            return;
        }
        if (typeof value !== "string")
            throw new TypeError(`DataField: expected a field name, got ${typeof value}`);
        dataFields.set(this, value);
    }

    /**
     * the sentence of the last refusal on this control, or `""`.  **Read-only**:
     * the binding sets it and the program reads it -- what a person is told
     * about it is the program's to decide -- and a setter would put a row for
     * it in every property grid
     */
    get Error() {
        return fieldErrors.get(this) || "";
    }
}
mixIn(DataMembers, Widget);

/* The record a form edits, and the one it is showing, and the guard.  All
 * three are the runtime's notes; the first is a property the file carries. */
const formRecords = new WeakMap();
const formSources = new WeakMap();
const formRows    = new WeakMap();
const boundState  = new WeakMap();
const listened    = new WeakMap();

class BoundMembers {
    /*
     * The file the form's records come from, or `""`.
     *
     * **`Record` says what a record is; `Source` says which records.** They
     * are two on purpose (`docs/plans/data-plan.md`): the same `Customer` is
     * readable from a file, from a table and later from a reply over HTTP,
     * and two screens over the same shape are two sources.
     *
     * **A connection's table** -- `sales.clients`, where `sales.conn` says
     * where the SQLite database is -- or **a file of the project**, holding an
     * array of records or one object, for a source that is one record.
     */
    /** the file the form's records come from, or `""` */
    get Source() {
        return formSources.get(this) || "";
    }
    set Source(value) {
        if (value === undefined || value === null || value === "") {
            formSources.delete(this);
            formRows.delete(this);
            return;
        }
        if (typeof value !== "string")
            throw new TypeError(`Source: expected a file, got ${typeof value}`);
        formSources.set(this, value);
        formRows.delete(this);
    }

    /** the shape this form edits -- the name of a record class -- or `""` */
    get Record() {
        return formRecords.get(this) || "";
    }
    set Record(value) {
        if (value === undefined || value === null || value === "") {
            formRecords.delete(this);
            return;
        }
        if (typeof value !== "string")
            throw new TypeError(`Record: expected a class name, got ${typeof value}`);
        formRecords.set(this, value);
    }
}
mixIn(BoundMembers, Form);

/* What kind of value a raw one is.  **The kind is observed, not declared**:
 * it is what the member holds when it is read, which cannot drift from the
 * control -- and the field says what it is, through `PropertyInfo`. */
function valueKind(v) {
    if (typeof v === "string")  return "text";
    if (typeof v === "number")  return "number";
    if (typeof v === "boolean") return "bool";
    if (v instanceof Decimal)     return "decimal";
    return "";
}

/* The value as the field of that kind wants it.  A field is strict -- it
 * refuses a number where it wants text -- so this is where the two meet:
 * the control's value is shaped into what the field takes, and the field's
 * own checks have the last word. */
function asField(kind, raw) {
    switch (kind) {
    case "text": case "enum": case "date": case "time": case "datetime":
        return asText(raw);
    case "int": case "number":
        return asNumber(raw);
    case "bool":
        return asBool(raw);
    case "decimal":
        /* The field takes text, a number or a decimal, and takes the decimal
         * as it is: converting it to a double would lose the very thing it
         * exists for. */
        return raw;
    default:
        return undefined;   /* bytes, record, list: not a control's value */
    }
}

/* And the value as the control of that kind wants it -- the other
 * direction, which is the same table read the other way round. */
function asControl(kind, value) {
    switch (kind) {
    case "text":    return asText(value);
    case "number":  return asNumber(value);
    case "bool":    return asBool(value);
    case "decimal": return value;
    default:        return undefined;
    }
}

function asText(v) {
    if (typeof v === "string")  return v;
    if (typeof v === "number")  return String(v);
    if (typeof v === "boolean") return v ? "true" : "false";
    if (v instanceof Decimal)     return String(v);
    if (v === undefined || v === null) return "";
    return String(v);
}

function asNumber(v) {
    if (typeof v === "number")  return v;
    if (typeof v === "string")  return Number(v);
    if (typeof v === "boolean") return v ? 1 : 0;
    if (v instanceof Decimal)     return v.Number();
    return NaN;
}

function asBool(v) {
    if (typeof v === "boolean") return v;
    if (typeof v === "string")  return v === "true" || v === "1";
    if (typeof v === "number")  return v !== 0;
    if (v instanceof Decimal)     return v.Sign !== 0;
    return false;
}

/* The member that holds a control's value, the kind it holds, and the event
 * that says the person is done with it -- or `""` for the first two when the
 * class says it has no value.  The class says which member it is and when it
 * is done (`Widget.ValueInfo`); the kind is what that member holds now, which
 * is the answer that cannot drift from the control. */
function controlValue(control) {
    const info = Widget.ValueInfo(Widget.TypeName(control.constructor));
    const member = info && info.Member ? info.Member : "";
    if (!member)
        return { member: "", kind: "", done: "", choices: "" };
    const raw = control[member];
    return { member, kind: valueKind(raw), done: info.Done || "",
             choices: info.Choices || "" };
}

/* The controls of a form that show a field, and the field each shows.
 *
 * **The containment tree, not the named controls**: `Controls` is what the
 * form holds *by name*, which is what a `.form` gives it, and a control that
 * was built in code and added to a panel is bound just the same.  The tree is
 * walked all the way down, because a field is often shown by a control inside
 * a panel and not by one on the form itself. */
function boundControls(form) {
    const out = [];
    const walk = (node) => {
        for (const child of node.Children || []) {
            const field = child.DataField;
            if (field) out.push({ control: child, field });
            walk(child);
        }
    };
    walk(form);
    return out;
}

/* Whether a complaint is about this field.  The path of a complaint is the
 * field's name, and a name that is the beginning of another one is not this
 * one: "Name2 is required" is not about "Name". */
function complaintIs(complaint, field) {
    if (!complaint.startsWith(field)) return false;
    const next = complaint.charAt(field.length);
    return next === "" || next === " " || next === ":" || next === "[";
}

/*
 * Bind(record) -- show a record on this form.
 *
 * Every control that names a field is filled with that field's value, and
 * from then on **the control gives its value back** when the person is done
 * with it: on `Activate` and on losing the focus.  A field that refuses the
 * value marks the control with the sentence it refused with, and the control
 * gives it up again when the value is one the field takes.
 *
 * The guard is here: writing the controls raises a real `Change`, and without
 * it every display of the record would be read straight back into it.
 */
/**
 * shows a record on this form: every control that names a field is filled with
 * it, and from then on the control gives its value back when the person is
 * done with it
 */
Form.prototype.Bind = function (record) {
    if (!record || typeof record !== "object")
        throw new TypeError("Bind(record) expects a record");

    const declared = this.Record;
    if (declared && record.constructor.name !== declared)
        throw new TypeError(`Bind: this form edits ${declared}, not ` +
                            `${record.constructor.name}`);

    const bound = boundControls(this);
    const state = { record, showing: true, bound };
    boundState.set(this, state);

    try {
        for (const { control, field } of bound) {
            const info = record.PropertyInfo ? record.PropertyInfo(field) : undefined;
            if (!info)
                throw new RangeError(`Bind: ${field} is not a field of ` +
                                     `${record.constructor.name}`);

            const { member, kind } = controlValue(control);
            if (!member)
                throw new RangeError(`Bind: ${control.Name || "a control"} has ` +
                                     `no value to show ${field} in`);

            const value = asControl(kind, record[field]);
            if (value === undefined && kind !== "decimal")
                throw new RangeError(`Bind: ${control.Name || "a control"} holds ` +
                                     `a ${kind || "nothing"}, which ${field} ` +
                                     `cannot take`);

            /*
             * **The choices before the value**, and inside the guard: a
             * `Field.Enum` declares what it accepts, and a control that takes
             * a list is handed exactly that -- so a drop-down offers what the
             * field takes and cannot drift from it.  `Items` raises `Select`
             * when it is assigned, which is a real signal, and that is the
             * guard's other half.
             */
            const { choices } = controlValue(control);
            if (choices) {
                const values = record.PropertyOptions
                    ? record.PropertyOptions(field) : null;
                if (values && values.length) control[choices] = values;
            }

            control[member] = value;
        }
    } finally {
        state.showing = false;
    }

    /* What the record complains about, marked where the person is looking. */
    markErrors(this);

    for (const { control } of bound) listenTo(this, control);
    return this;
};

/**
 * the records the form's `Source` holds, as the class given
 *
 * **The class is the caller's**, because the prelude cannot resolve a name to
 * a class: a project's `class Customer` is a lexical binding, and the runtime's
 * own lookup (`Widget.New`, `Widget.Members`) answers about a name without
 * handing the class back.  A form has the class anyway -- `Bind` refuses a
 * record whose class is not the one `Record` names.
 *
 * Read once and kept: `Reload()` reads the file again.
 */
Form.prototype.Rows = function (recordClass) {
    if (!recordClass || typeof recordClass.Load !== "function")
        throw new TypeError("Rows(record) expects a Record class");

    const had = formRows.get(this);
    if (had && had.of === recordClass) return had.rows;

    const source = this.Source;
    if (!source) return [];

    const rows = rowsFrom(source, recordClass);

    formRows.set(this, { of: recordClass, rows });
    return rows;
};

/*
 * **A source is a table or a file, and it is told apart by looking.**
 *
 * `sales.clients` names a connection and a table in it, and a connection is a
 * `.conn` file beside the project's other resources:
 *
 *     { "kind": "sqlite", "path": "data/clients.db" }
 *
 * Anything else names a file, read as JSON.  That is the plan's order --
 * a declared connection first, a file of the project second -- and nothing is
 * parsed out of the string to say which: a scheme inside a value is a small
 * language inside a value (`docs/plans/data-plan.md`).
 *
 * The `.conn` is the resource the plan describes with a category, an icon and
 * a dialog, and this is it without those three: a file that says where the
 * database is.  The designer offers the tables of the connections it can open.
 */
function rowsFrom(source, recordClass) {
    const project = Application.Directory;

    /* One dot names a connection; the file's own extension is a dot too, and
     * that is why the connection is tried first and `customers.json` falls
     * through to the file it is. */
    const dot = source.indexOf(".");
    if (dot > 0) {
        const conn = `${source.slice(0, dot)}.conn`;
        const path = File.Join(project, conn);

        if (File.Exists(path)) {
            const spec = File.LoadJson(path);
            if (!spec || !spec.path)
                throw new Error(`${conn}: a connection says where its database is`);

            const table = source.slice(dot + 1);
            const db    = Database.Sqlite(File.Join(project, spec.path));

            return db.Table(table, recordClass).All();
        }
    }

    const path = File.Join(project, source);

    let doc;
    try {
        doc = File.LoadJson(path);
    } catch (e) {
        throw new Error(`Rows: ${source} is neither a connection's table nor ` +
                        `a file of the project: ${e.message}`);
    }

    const docs = Array.isArray(doc) ? doc : [doc];

    /* `Load` and not `new`: a file is read leniently, so a value the shape
     * would refuse leaves its field at the start and says so in `Problems`
     * instead of throwing the other records away. */
    return docs.map((one) => recordClass.Load(one));
}

/**
 * forgets the rows, so the next `Rows()` reads the source again
 */
Form.prototype.Reload = function () {
    formRows.delete(this);
    return this;
};

/*
 * The write-back, on the two moments the plan names.  The handler is on the
 * control itself, so it runs **before** the form's own `Activate` or
 * `LostFocus` handler -- which is what lets the program read the error the
 * binding marked in the handler it wrote for itself.
 */
function listenTo(form, control) {
    if (listened.has(control)) return;
    listened.set(control, true);

    const write = () => {
        const state = boundState.get(form);
        if (!state || state.showing) return;

        const field  = control.DataField;
        const record = state.record;
        if (!field || !record) return;

        const { member, kind } = controlValue(control);
        if (!member) return;

        const info = record.PropertyInfo ? record.PropertyInfo(field) : undefined;
        if (!info) return;

        const value = asField(info.Kind, control[member]);
        if (value === undefined) return;

        try {
            record[field] = value;
        } catch (e) {
            /* The sentence names the field, and the field is the control's:
             * the mark goes where the person is looking. */
            fieldErrors.set(control, e.message);
            return;
        }
        fieldErrors.delete(control);

        /* And the rest of the record: a field that is empty is a complaint
         * about the control that shows it.  `Validate()` and never
         * `Problems`, which is the report of a load and never clears. */
        markErrors(form);
    };

    /* **The moment the value is done, and the one every control has.**  The
     * class says which event it is -- a `TextBox` on `Activate`, a `ComboBox`
     * on `Select`, a `CheckButton` on `Click` -- and losing the focus is the
     * other one, which is what WinForms calls `OnValidation`. */
    const done = controlValue(control).done;
    if (done && !control.EventNames().includes(done))
        throw new RangeError(`Bind: ${control.Name || "a control"} does not ` +
                             `raise ${done}, which is where its value is done`);
    if (done)
        control.On(done, write);
    control.On("LostFocus", write);
};

/*
 * The complaints of the record, marked on the controls that show the fields
 * they are about.  `Validate()` is the state -- recomputed every time --
 * where `Problems` is what a load said and never clears, so validating with
 * it marks a field the person has already fixed.
 */
function markErrors(form) {
    const state = boundState.get(form);
    if (!state) return;

    let complaints = [];
    try {
        complaints = state.record.Validate() || [];
    } catch (e) {
        return;
    }

    for (const { control, field } of state.bound) {
        const about = complaints.find((c) => complaintIs(c, field));
        if (about) fieldErrors.set(control, about);
        else fieldErrors.delete(control);
    }
};

/* ---------------------------------------------------------------------
 * The window an uncaught error is shown in.
 *
 * The runtime's own, built out of the controls an application uses and not out
 * of a `.form`: it is what is shown when the application's code is what
 * failed, so it cannot depend on a project's files being where it expects them.
 * C asks for it by name (`show_error_window` in `bta_runtime.c`) and falls back
 * to a `GtkAlertDialog` when this is absent or throws -- which is the only
 * reason it may not be a class: a name in the prelude that C looks up is a
 * function nobody else is told about, lower case, outside the surface.
 *
 * A generic title, a header with the message, the backtrace apart in a monospace
 * box, and Copy beside Close.  The words are not translated: a prose position
 * the runtime owns has no catalogue to look in.  **One at a time**, as the
 * alert's `reporting_error` was: a handler that throws on a timer would
 * otherwise stack a window per tick.
 * ------------------------------------------------------------------- */
let errorWindowOpen = false;

function showError(message, stack) {
    if (errorWindowOpen) return;

    const detail = String(stack || "").trim();
    const text   = detail ? `${message}\n\n${detail}` : String(message);

    const form = new Form();
    form.Text      = "Error";
    form.Modal     = true;
    form.Center    = true;
    form.Width     = 560;
    form.Height    = detail ? 380 : 140;
    form.Arrangement = "Vertical";

    const body = new Panel();
    body.Arrangement = "Vertical";
    body.Spacing     = 12;
    body.Margin      = 18;
    body.HExpand     = true;
    body.VExpand     = true;
    form.Add(body);

    /* What happened. */
    const head = new Panel();
    head.Arrangement = "Horizontal";
    head.Spacing     = 12;
    head.HExpand     = true;

    const icon = new Image();
    icon.Icon   = "dialog-error-symbolic";
    icon.Size   = 32;
    icon.VAlign = "Start";
    icon.Style  = "error";
    head.Add(icon);

    const title = new Label();
    title.Text       = String(message);
    title.Style      = "title-4";
    title.Wrap       = true;
    title.HAlign     = "Fill";
    title.HExpand    = true;
    head.Add(title);
    body.Add(head);

    /* Where. */
    if (detail) {
        const caption = new Label();
        caption.Text   = "Backtrace";
        caption.Style  = "heading";
        caption.HAlign = "Start";
        body.Add(caption);

        const trace = new TextEditor();
        trace.Text     = detail;
        trace.ReadOnly = true;
        trace.Style    = "frame";
        trace.Font     = "Monospace 10";
        trace.Wrap     = true;
        trace.HExpand  = true;
        trace.VExpand  = true;
        body.Add(trace);
    }

    /* What to do with it. */
    const buttons = new Panel();
    buttons.Arrangement = "Horizontal";
    buttons.Spacing     = 6;
    buttons.HAlign      = "End";
    buttons.VAlign      = "End";
    body.Add(buttons);

    const copy = new Button();
    copy.Text = "Copy";
    copy.On("Click", () => { Clipboard.Copy(text); copy.Text = "Copied"; });
    buttons.Add(copy);

    const close = new Button();
    close.Text    = "Close";
    close.Default = true;
    close.Cancel  = true;
    close.On("Click", () => form.Close());
    buttons.Add(close);

    form.On("Close", () => { errorWindowOpen = false; });

    errorWindowOpen = true;
    form.Show();
}

/* ------------------------------------------------------------------------
 * `Remember`: the window as it was left.
 *
 * C says when (`form_remember` in bta_controls.c): `"restore"` before
 * `Form_Open`, `"size"` on every resize, `"save"` when the window goes.  This
 * says what, and it is the IDE's `Session` made general -- the same three
 * lessons, paid for there first:
 *
 * - **The size kept is the last one seen un-maximised.**  A maximised window
 *   reports the screen, and that size restored un-maximised is a window with no
 *   frame left to grab.  The flag is written beside it.
 * - **Nothing is written per resize.**  A drag is a hundred frames; the size is
 *   noted and written once, when the window goes.
 * - **A settings file is a file a person edits**, so every number is checked
 *   rather than trusted, and the dividers are read by the names this form has --
 *   a file cannot name a control into being moved.
 *
 * One key per form class, `window.<Class>`: the window is the person's, not the
 * project's, and two instances of one dialog are one preference.  A name in the
 * prelude that C looks up, so lower case and outside the surface.
 * ------------------------------------------------------------------- */
const REMEMBER_MIN = 50;   /* under this it never came from a resize */
const rememberedSize = new WeakMap();

function rememberKey(form) {
    return `window.${Widget.TypeName(form.constructor)}`;
}

function rememberSane(n) {
    return Number.isFinite(n) && n >= REMEMBER_MIN && n <= 100000;
}

function rememberSplits(form) {
    return form.Controls.filter(c => c instanceof Split && c.Name);
}

function rememberWindow(form, what, width, height) {
    if (what === "size") {
        if (form.Maximized || form.FullScreen) return;
        if (rememberSane(width) && rememberSane(height))
            rememberedSize.set(form, { width, height });
        return;
    }

    const key = rememberKey(form);

    if (what === "restore") {
        const saved = Settings.Get(key, null);
        if (!saved || typeof saved !== "object" || Array.isArray(saved)) return;

        const w = Number(saved.width), h = Number(saved.height);
        if (rememberSane(w) && rememberSane(h)) {
            /* Before `Maximized` and not instead of it: this is the size
             * un-maximising gives back. */
            form.Resize(w, h);
            rememberedSize.set(form, { width: w, height: h });
        }
        if (saved.maximized === true) form.Maximized = true;

        const at = saved.splits && typeof saved.splits === "object" ? saved.splits : {};
        for (const split of rememberSplits(form)) {
            if (!hasOwn.call(at, split.Name)) continue;
            const where = Number(at[split.Name]);
            if (Number.isFinite(where) && where > 0) split.Position = Math.round(where);
        }
        return;
    }

    if (what === "save") {
        const saved  = { maximized: !!form.Maximized };
        const size   = rememberedSize.get(form);
        if (size) {
            saved.width  = size.width;
            saved.height = size.height;
        }
        const splits = {};
        let any = false;
        for (const split of rememberSplits(form)) {
            if (split.Position > 0) { splits[split.Name] = split.Position; any = true; }
        }
        if (any) saved.splits = splits;
        Settings.Set(key, saved);
    }
}
