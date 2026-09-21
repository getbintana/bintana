/*
 * The property grid: one row per property, the name on the left and, on the
 * right, the control it is edited with.
 *
 * Which control that is is decided by the *value*, not by a table of names: a
 * property that declares what it accepts (`PropertyOptions`) comes out as a
 * drop-down, a number as a spin, a boolean as a two-item drop-down, a colour as
 * a swatch, and everything else as a text field.  So a property added to a
 * widget in C shows up here edited properly with nothing to change in the IDE,
 * which is the same bet `PropertyNames` is.
 *
 * With nothing selected the grid edits **the form itself**, whose properties are
 * not a control's: the form is not on the surface, it *is* the surface, so they
 * are read from and written to the root node -- and a never-shown instance
 * (`formProbe`) answers what the list, the defaults and the drop-downs are.
 *
 * One per designer, like the control tree: `PropGrid` is a single widget, but
 * what it shows is this form's selection.  Each editor **carries its own
 * handler** (`editor.On("Change", ...)`), so a rebuilt grid drops the previous
 * set with the controls they belonged to; nothing of the grid's is left on the
 * IDE's form to be taken back off.  The one exception is the sample menu, whose
 * entries are menu *items* rather than widgets and so have nowhere to carry one.
 *
 * The grid is rebuilt only when the set of properties changes: while a control
 * is dragged, X and Y refresh dozens of times a second, and rebuilding the
 * widgets on every refresh would take the focus and the cursor away from
 * whoever is typing.
 */
"use strict";

Namespace("Ide");

/*
 * Properties one *picks* rather than types, and the button that opens the
 * chooser from inside the field.  A name out of thousands and a colour out of
 * a wheel are not things anybody types from memory.
 */
/* The button inside the Columns field, best first: the desktop's own if it has
 * one, and ours otherwise -- the same order every icon here is chosen in. */
const COLUMN_PICK = ["view-table-symbolic", "view-grid-symbolic",
                     "document-edit-symbolic", "bta-table-symbolic"];

const ICON_PICK  = ["edit-find-symbolic", "system-search-symbolic", "edit-find"];

/* The button that empties a chooser row -- a colour or a font back to the
 * theme's. Best first, the desktop's own before ours, like every icon here. */
const ICON_CLEAR = ["edit-clear-symbolic", "edit-clear", "window-close-symbolic"];

/* The button inside the Style field, which offers the classes we know of --
 * the project's stylesheet and the theme's -- without claiming to be the list. */
const STYLE_PICK = ["view-list-symbolic", "open-menu-symbolic", "pan-down-symbolic"];

/*
 * The button inside a prose field, which fills it with a plausible sample.
 *
 * Lorem is not a runtime feature and deliberately so: this writes **literal
 * text** into the node's `design` block, so the file holds real words rather
 * than an `@sample/lorem` the loader would have to understand.  Nothing to
 * resolve, nothing to invent, and the text is stable between runs -- which is
 * what makes two screenshots comparable.
 */
const ICON_SAMPLE = ["edit-paste-symbolic", "insert-text-symbolic",
                     "document-edit-symbolic", "edit-paste"];

/*
 * What a design value can be filled with.  Enough kinds to lay a form out, and
 * no more: the point is to see the shape of the text, not to generate data.
 *
 * Fixed strings and not a generator, for the same reason the file holds
 * literals: a sample that changed on every click would make the .form churn.
 */
const SAMPLES = [
    ["Words",     "Lorem ipsum dolor"],
    ["Sentence",  "Lorem ipsum dolor sit amet, consectetur adipiscing elit."],
    ["Paragraph", "Lorem ipsum dolor sit amet, consectetur adipiscing elit. " +
                  "Sed do eiusmod tempor incididunt ut labore et dolore magna " +
                  "aliqua. Ut enim ad minim veniam, quis nostrud."],
    ["Name",      "Ana María Rodríguez"],
    ["City",      "San Miguel de Tucumán"],
    ["Email",     "ana.rodriguez@ejemplo.com"],
    ["Date",      "2026-08-13"],
    ["Number",    "1.234,56"],
    ["Long word", "Esternocleidomastoideo"],
];

/*
 * The design values that are not prose, by the class that has them.
 *
 * **A design value is for what the code fills in**, and prose is the commonest
 * shape of that rather than the definition of it. A `Label` whose text arrives
 * at run time lays out against a sample sentence; a `TableView` whose rows
 * arrive at run time lays out against a *count*, and there is no sentence that
 * can stand in for three rows. `Count` is settable and is the on-demand mode, so
 * writing one puts that many rows on the canvas with the columns already drawn
 * over them -- which is the whole of what a table looks like.
 *
 * **A list here and not a question for the control**, which is the exception to
 * this file's habit of asking. `TextProperties()` exists because the *loader*
 * consumes it: those are the properties it looks up in the catalogue. Nothing in
 * a running program would ever read "which properties may carry a design
 * count", so a runtime member for it would be published for one reader, and that
 * reader is the designer. The palette's list of types is in the IDE for the same
 * reason: what the designer offers is the IDE's business.
 *
 * One entry, and that is the honest size of it today. `ListBox.Items`,
 * `ComboBox.Items` and `Notebook.Tabs` are already prose, so the three of them
 * fill from the mode as it was; a `TableView`'s rows were the only list in the
 * runtime that is counted rather than named.
 */
const DESIGN_NUMBERS = { TableView: ["Count"] };

/*
 * The two rows a list gets in design mode, which are not properties of anything.
 *
 * They are the node's `item` key -- what a list draws while it is being designed
 * and the application never sees -- so they are spelled the way the file spells
 * them, and dotted the way `Columns.Text` already is: one row per thing that can
 * be worth something, and no invented vocabulary between the grid and the file.
 *
 * Offered only where a container's children come from code, which is what
 * `Placement: "Order"` says (a `RowList`, a `Flow`). A container drawn in
 * coordinates has its children in the file: there is nothing to stand in for.
 */
const ITEM_OF    = "Item.of";
const ITEM_COUNT = "Item.count";
const ITEM_KEYS  = [ITEM_OF, ITEM_COUNT];

/*
 * What a top-level window has no use for.  Everything else its class offers is
 * offered here, so a property added to Form in C turns up in the grid with
 * nothing changed -- which is the invariant the whole project rests on, and
 * which a hand-written list of three quietly broke.
 */
const FORM_HIDDEN = [
    "Name",                             // a form is identified by its class
    "X", "Y",                           // where a window goes is the desktop's
    "Expand", "HExpand", "VExpand",     // no parent to absorb slack from
    "HAlign", "VAlign",                 // these answer to a surface; a window is on none
    "MinWidth", "MinHeight",            // the floor a *stretched* control keeps
    "Margin",                           // margin against what?
    "Tooltip",                          // a window has nothing to hover
    "DragData",                         // a window is not dragged into anything
    "Visible", "Enabled", "Focusable",  // written to the .form they open it hidden or dead
];

/* --- how the rows are grouped --------------------------------------------
 *
 * Alphabetical was one list of forty names with `Name` somewhere in the middle,
 * which is the wrong order for every question anybody asks of this panel. The
 * order now is: what a control *is*, then what makes it that kind of control,
 * then how it looks, where it sits, and how it behaves.
 *
 * Three of the five groups are written down here. The fourth -- **what the
 * widget's own class adds** -- is not, and cannot be: a property added to a
 * class in C has to turn up in the right group with nothing changed in the IDE,
 * which is the bet the whole grid is built on. It is worked out instead: every
 * concrete widget is asked what it has, and what they *all* have is the base
 * every control inherits. What a Slider has beyond that is a Slider's.
 *
 * The runtime does not offer the prototype chain to answer this with -- the
 * reflection that would walk it is deleted on purpose, `Object.getPrototypeOf`
 * included -- so the intersection is not a shortcut, it is the way. It is also
 * exact: a property every widget has *is* base, whatever declared it.
 */
const ESSENTIAL = ["Name", "Text"];

/*
 * `FontScale` and `Opacity` sit with `Font` and not in the group at the end.
 *
 * The last group is where a property nothing knows about falls, and these two
 * fell there: they are Widget's own, so they are not the control's; they are in
 * neither list, so they were "the rest". But they are the two things the
 * desktop's own type classes are made of -- `.title-1` is a weight and a size,
 * `.dim-label` is `opacity: 0.55` -- which is appearance and nothing else. The
 * class editor has had them next to the font all along; this is the same grid
 * saying the same thing.
 *
 * `Border` fell there for the same reason and is the same mistake: it is a
 * width, a style and a colour drawn around the control, which is appearance by
 * any reading. The list to check this one against is `Sheet.props` -- what a
 * class in `app.css` is allowed to say is exactly the look a control can be
 * given by hand -- and `Border` is in it, between the opacity and the radius.
 */
const APPEARANCE = ["Background", "Foreground", "Font", "FontScale", "Opacity",
                    "Style", "Border", "Radius", "Shadow", "Padding"];

const LAYOUT = ["X", "Y", "Width", "Height", "MinWidth", "MinHeight",
                "Margin", "ColumnSpan",
                "HAlign", "VAlign", "Expand", "HExpand", "VExpand"];

/*
 * What every widget has, worked out once.
 *
 * Once per run of the IDE and not once per grid: it is a fact about the
 * runtime, and the runtime does not change while it is running. The widgets it
 * makes to ask are deleted again -- a probe left behind is a GTK widget with no
 * parent, which is a leak nobody would ever see.
 */
let baseCache = null;

function baseProperties() {
    if (baseCache) return baseCache;

    let common = null;
    for (const type of Widget.Types()) {
        let probe;
        try {
            probe = Widget.New(type);
        } catch (e) {
            continue;                   /* abstract: Widget, Control, Container */
        }

        /* A window is not a control and is not part of the answer: what is
         * being worked out is what every *control* has. It is also the one kind
         * that has to be closed rather than deleted, and making one to throw it
         * away would be a window built per question. */
        if (probe instanceof Form) {
            probe.Close();
            continue;
        }

        const names = probe.PropertyNames();
        common = common === null ? names
                                 : common.filter((k) => names.includes(k));
        probe.Delete();
    }

    baseCache = common || [];
    return baseCache;
}

/*
 * Properties another property turns off.
 *
 * A row that does nothing is worse than a row that is not there: it invites an
 * edit, takes it, saves it into the `.form`, and changes nothing on the screen.
 * Each of these answers with the name of the property responsible, so the grid
 * can say *why* it is grey rather than just being grey.
 *
 * Only pairs that are really inert, checked against the widget rather than
 * assumed: `Lines` is Pango's cap on a wrapped label and a label that does not
 * wrap has one line by construction; `ValuePosition` is where a number that is
 * not drawn would go; a `ProgressBar`'s `Text` is only shown when it is asked
 * for; and a `Picture` under a `Zoom` is the size the zoom makes it, which is
 * what `Fit` stops deciding.
 */
const USELESS = {
    Lines:         (t) => (t.Wrap === false ? "Wrap" : ""),
    ValuePosition: (t) => (t.ShowValue === false ? "ShowValue" : ""),
    Text:          (t) => (t.constructor.name === "ProgressBar" && !t.ShowText
                               ? "ShowText" : ""),
    Fit:           (t) => (t.Zoom ? "Zoom" : ""),
};

/*
 * ...and the pair the *parent* decides, which is the one that matters most in a
 * RAD designer: on a fixed surface a control is placed at X/Y and nothing
 * absorbs slack; inside a box the box places it and the alignment is how it
 * asks for room. Each set is inert in the other's world -- measured: a Button
 * given `HExpand`, `Expand` and `HAlign = Fill` on a fixed surface is allocated
 * exactly the same rectangle as one given none of them.
 */
const PLACED_BY_BOX     = ["X", "Y"];
const PLACED_BY_ANCHORS = ["HAlign", "VAlign", "Expand", "HExpand", "VExpand"];

/* Width of the name column. */
const PROP_LABEL_W = 96;

/* How far the spin of a numeric property goes.  It is a sanity limit, not a
 * per-property rule: the grid has to be able to show what the control is
 * already worth, and some numbers are legitimately negative -- a coordinate
 * while a control is being placed, or the Index of a list with nothing
 * selected. */
const NUMBER_MIN = -9999;
const NUMBER_MAX = 9999;

/*
 * **How precise a numeric property is gets asked of the control, not listed
 * here.**
 *
 * Every number used to get a spin with no decimals, which quietly destroyed
 * every value that was not whole: `Opacity = 0.55` came back `1`, a `SpinBox`'s
 * `Step = 0.05` came back `0`, and the row that did it looked like an ordinary
 * edit.
 *
 * A list of the fractional ones is the obvious fix and cannot be right. Measured
 * across the catalogue there are eight names, and `Value` is one of them with a
 * different answer per class -- fractional on a `LevelBar` and a `ProgressBar`,
 * which are readings, whole on a fresh `SpinBox` and `Slider`, which carry their
 * own `Decimals` -- so a table keyed by the property name cannot say it. Nor can
 * one keyed by name *and* class: a `Slider` at `Decimals = 3` really does hold
 * `0.125`, and its class says otherwise. The answer is not a property of the
 * name, and not of the class either. It belongs to **the control as it stands.**
 *
 * So the question goes to a throwaway wearing the selection's own properties,
 * straight off `Serialize()`: hand it a number with six decimals and count how
 * many came back. It is the round trip `Ide.Sheet.owned` makes with a CSS rule
 * and the one `bta_icon_available` makes with an icon -- ask the thing, rather
 * than keep an opinion about it.
 *
 * The live control cannot be the one asked: assigning `Min` to find out about it
 * would clamp the `Value` beside it, and putting `Min` back does not put the
 * `Value` back. A copy can be disturbed freely, which is what it is for.
 *
 * `sync` refreshes it, because that is where both things that change the answer
 * arrive -- another control selected, or an edit to this one. `applyEditor` ends
 * in `fill`, so setting `Decimals` to 3 re-asks and the `Value` row grows its
 * decimals in the same beat.
 *
 * The cost is one `Serialize` per refresh and one widget per actual change of
 * state -- ~0.3 ms, measured -- against a spin that silently rounded every value
 * it was handed.
 */
const FRACTION_PROBE  = 0.123456;  /* six decimals, and in range for all of them */
const PROBE_DIGITS    = 6;         /* how many were offered, so how many mean "all" */
const FRACTION_DIGITS = 2;         /* what a row offers when the control has no say */
const FRACTION_STEP   = 0.05;

/*
 * **How many decimals, and not whether any.** Counting is what closes the case
 * the yes/no question could not: a `Slider` told `Decimals = 3` holds 0.125, and
 * a row offering the two that "fractional" means would store it as 0.13 -- a row
 * refusing what the control beside it accepts.
 *
 * So the probe carries six decimals and the answer is how many came back:
 *
 *   - none, and the property is whole -- `Width`, `Margin`, `TabIndex`;
 *   - all six, and it did not round at all, so it has no precision of its own and
 *     the row offers two to type into -- `Opacity`, `FontScale`, a `SpinBox`'s
 *     `Step`;
 *   - somewhere between, and that is the control's own answer and the row takes
 *     it: a `Slider` at `Decimals = 3` says three, a `Terminal`'s `FontScale`
 *     says two, a `ProgressBar`'s `Value` says four, being a percentage kept as
 *     a fraction.
 *
 * Put back afterwards: the widget asked is a throwaway in every case but the
 * form's, whose probe is kept and answers other questions.
 */
function fractionDigits(widget, key) {
    let before;
    try { before = widget[key]; } catch (e) { return 0; }
    if (typeof before !== "number") return 0;

    let kept = 0;
    try {
        widget[key] = FRACTION_PROBE;
        kept        = digitsOf(widget[key]);
    } catch (e) {
        kept = 0;                   /* refused it outright: whole numbers only */
    }
    try { widget[key] = before; } catch (e) { /* nothing better to do */ }

    if (kept === 0) return 0;
    return kept < PROBE_DIGITS ? kept : FRACTION_DIGITS;
}

/* How many decimals a value actually carries, so showing it cannot round it:
 * a spin with two of them stores 0.125 as 0.13. */
function digitsOf(value) {
    if (!Number.isFinite(value)) return 0;

    const text = String(value);
    const dot  = text.indexOf(".");
    return dot < 0 ? 0 : text.length - dot - 1;
}

/* Equal for the purposes of "did this edit change anything": arrays compare by
 * content, because an Items list rebuilt from the same strings is the same list. */
function sameJsonValue(a, b) {
    if (a === b) return true;
    if (Array.isArray(a) || Array.isArray(b)) {
        return JSON.stringify(a) === JSON.stringify(b);
    }
    return false;
}

Ide.PropertyGrid = class PropertyGrid {

    /** @param {Ide.Designer} designer */
    constructor(designer) {
        this.designer = designer;

        /* What it shows, what it edits with, and whose. */
        this.propKeys = [];
        this.editors  = {};
        this.builtFor = undefined;

        /* The stand-in the "does this property keep a fraction" question is put
         * to, what it was built from, and what it has answered so far. See
         * `fractionProbe`: it wears the selection's own properties, so the
         * answer is the control's and not the class's. */
        this.fracProbe   = null;
        this.fracOwned   = false;
        this.fracState   = undefined;
        this.fracProps   = {};
        this.fracAnswers = new Map();

        /* Raised while the grid is the one writing: assigning a value to an
         * editor fires its event exactly as if the user had touched it. */
        this.updating = false;

        /* The sample menu: which field it was opened for, and whether its
         * entries have been wired yet.  See `pickSample` -- those entries are
         * menu *items*, so they are the one part of this grid that cannot carry
         * a handler of its own. */
        this.sampleKey     = null;
        this.samplesWired  = false;

        /* Which property of which control the open undo entry belongs to; see
         * `beginEdit`. */
        this.editKey    = null;
        this.editTarget = null;

        /*
         * Whether the grid is editing the `design` block instead of
         * `properties`.  One switch for the whole grid rather than a second row
         * per property: the two *are* two dictionaries on the node, and editing
         * one at a time is what they are.
         *
         * Per designer, like the selection -- what is a sensible mode for the
         * form being laid out is not one for the next tab.
         */
        this.designMode = false;

        /* What is typed in the filter box, lowercased; "" is everything. */
        this.filter = "";

        /* What each row of the grid is about, in the order the rows were added:
         * one property for a property row, a group's worth for a heading. It is
         * what `PropGrid_Filter` answers from, since what GTK hands us is a row
         * index and the rows themselves say nothing about which key they edit. */
        this.rowInfo = [];
    }

    get ide() { return this.designer.ide; }

    /* What the grid is about: the primary of the selection, or nothing at all --
     * which is the form itself.  It is the designer's, and read from there so
     * the two can never disagree. */
    get target() { return this.designer.selected; }

    /*
     * Takes the panel over.  The grid is one widget for every open form, so the
     * designer being switched to fills it in with its own selection.
     *
     * Behind `updating`, because building the grid assigns values to editors and
     * a control that is assigned a value reports a change exactly as if someone
     * had touched it.  Without the flag, switching to a tab pushed three entries
     * onto that tab's undo stack and marked it dirty -- an edit nobody made.
     */
    adopt() {
        this.updating = true;
        try {
            /* The mode is this designer's, so the switch shows this designer's
             * answer -- behind `updating`, since assigning to a Switch reports
             * a click exactly as if someone had flipped it. */
            this.ide.PropDesign.Active = this.designMode;
            this.fill();
        } finally {
            this.updating = false;
        }
    }

    /*
     * The switch at the head of the panel.
     *
     * One switch for the whole grid rather than a second row per property,
     * because `properties` and `design` *are* two dictionaries on the node and
     * editing one at a time is what they are.  Changing mode is not an edit: it
     * must not push an undo entry or mark the form dirty, which is what
     * `updating` is for -- the lesson a ColorButton taught this file.
     */
    setDesignMode(on) {
        if (this.designMode === on) return;

        this.designMode = on;
        this.updating   = true;
        try {
            this.build(this.allKeys());
            this.sync();
        } finally {
            this.updating = false;
        }
    }

    /*
     * The filter box over the grid.
     *
     * A view setting and not an edit: it survives selecting another control,
     * the way a search field does everywhere -- one looks for `Margin` and then
     * walks the form with it still typed.
     *
     * **Nothing is rebuilt to filter.** The grid holds every row its selection
     * has and the list hides the ones that do not match, which is what
     * `RowList.Refilter` and the `Filter` event are for: one question per row per
     * letter typed, against forty editors destroyed and forty built. That also
     * makes filtering *not an edit* in the literal sense -- a half-typed value in
     * a field that is filtered out and comes back is still there, because it is
     * the same field.
     */
    setFilter(text) {
        const wanted = String(text || "").trim().toLowerCase();
        if (wanted === this.filter) return;

        this.filter = wanted;
        this.ide.PropGrid.Refilter();
    }

    /* What the filter lets through: the property's own name, matched anywhere
     * in it, so `col` finds both `Columns` and `ColumnSpan`. */
    matches(key) {
        return !this.filter || key.toLowerCase().includes(this.filter);
    }

    /*
     * And what one row of the grid answers, which is what GTK asks us: a property
     * row when its own name matches, a heading when anything under it does -- so a
     * group whose every row is filtered out takes its title with it.
     */
    rowVisible(index) {
        const info = this.rowInfo[index];
        if (!info) return true;

        return info.some((key) => this.matches(key));
    }

    fill() {
        const keys = this.allKeys();

        if (this.builtFor !== this.target ||
            JSON.stringify(keys) !== JSON.stringify(this.propKeys)) {
            this.build(keys);
        }
        this.sync();
    }

    allKeys() {
        /*
         * Design mode is about prose and nothing else.  A geometry has no design
         * value to speak of -- where a control sits *is* the design -- so the
         * mode filters the grid down to what the runtime declares as text, which
         * makes it a short list and an unambiguous one.
         */
        if (this.designMode) return this.designKeys();

        /*
         * A stand-in gets the few properties the designer really owns: its name
         * and where it sits.  The rest of the grid would be the Label's, which
         * the component knows nothing about and the next save would drop -- and
         * a property one can edit and lose is worse than one that is not shown.
         */
        /* A stand-in gets what the designer really owns -- its name and where
         * it sits -- plus whatever its class declares, read from the source. */
        if (this.target && this.target.__node) {
            return [...STANDIN_PROPS,
                    ...this.designer.componentProps(this.target.__node.type)];
        }

        /* With nothing selected the grid switches to editing the form itself.
         * Its properties are not a control's -- the form is not on the surface,
         * it *is* the surface -- so they come from the root node. */
        if (this.target) {
            return this.target.PropertyNames().filter((key) => {
                const value = this.target[key];
                return typeof value !== "function" && value !== undefined;
            });
        }
        return this.designer.root ? this.formProps() : [];
    }

    /*
     * Which rows design mode offers: the properties the runtime says hold prose.
     *
     * Asked of the control rather than matched against a list of names, so a
     * widget added to the runtime in C turns up here with nothing changed --
     * `TextProperties()` is the same bargain `PropertyNames()` is.  It is also
     * what keeps a `SourceEditor`'s source text out of the mode entirely.
     *
     * A stand-in answers from its class's `static TextProperties`, read out of
     * the source -- the same declaration `TextProperties()` publishes for a
     * control written in C, said on the other side of the process line.
     *
     * A class that declares none keeps the permissive answer it always had:
     * everything it has, since nothing here can tell which of its strings a
     * person reads.  They go into the node either way.
     */
    designKeys() {
        if (this.target && this.target.__node) {
            const type = this.target.__node.type;
            return this.designer.componentTexts(type) ||
                   this.designer.componentProps(type);
        }
        /* The prose, and after it whatever this class counts instead of
         * naming -- see DESIGN_NUMBERS. Last, because the prose is what the
         * mode is mostly for and a row order is a reading order. */
        if (this.target) {
            return [...this.target.TextProperties(), ...this.designNumbers(),
                    ...(this.canShowItem() ? ITEM_KEYS : [])];
        }

        /* The form itself: its title is prose, and a window has nothing to
         * hover, so Tooltip is out for the same reason it is out of the normal
         * grid. */
        return this.formProbe().TextProperties()
                   .filter((key) => !FORM_HIDDEN.includes(key));
    }

    /* The numeric design values this target has, or none. A stand-in has none:
     * what a component counts is its own class's business and the designer
     * cannot ask it. */
    designNumbers() {
        if (!this.target || this.target.__node) return [];
        return DESIGN_NUMBERS[this.typeName()] || [];
    }

    isDesignNumber(key) {
        return this.designMode &&
               (this.designNumbers().includes(key) || key === ITEM_COUNT);
    }

    /* Whether this target is a list whose rows the program builds -- the only
     * kind of container with anything to stand in for. */
    canShowItem() {
        return !!this.target && !this.target.__node &&
               "Children" in this.target && this.target.Placement === "Order";
    }

    isItemKey(key) { return ITEM_KEYS.includes(key); }

    /*
     * The form being designed is not running -- the surface stands in for it --
     * so there is no instance to ask.  One is made here and never shown: the
     * property list, the drop-down values and the factory defaults all come
     * from it, which puts a form's grid on exactly the footing a control's is
     * on.  Kept, because building a window per grid refresh would be silly.
     */
    formProbe() {
        const kind = (this.designer.root && this.designer.isComponent(this.designer.root.class))
            ? "Component" : "Form";

        if (!this.probe || this.probeKind !== kind) {
            this.probe     = kind === "Component" ? new Component() : new Form();
            this.probeKind = kind;
        }
        return this.probe;
    }

    /* What the form itself offers.  A component has no title bar, so it has no
     * Text either: offering one would write a property into its .form that the
     * class it belongs to has no idea what to do with. */
    formProps() {
        const hide = (this.designer.root && this.designer.isComponent(this.designer.root.class))
            ? [...FORM_HIDDEN, "Text"] : FORM_HIDDEN;

        return this.formProbe().PropertyNames().filter((key) => !hide.includes(key));
    }

    /*
     * The rows, in groups: what it is, what makes it that kind of thing, how it
     * looks, where it sits, how it behaves.
     *
     * Only the first two are about *this* widget, which is why they are first --
     * and the last three are the same three lists for every control in the
     * project, which is why they are last and in that order. A property the
     * runtime grows that none of the lists knows about falls into the last
     * group, where the rest of the general ones already are.
     *
     * Design mode is one short list of prose and gets no headings: five of them
     * over eight rows would be filing cabinet for a shelf.
     */
    groupsOf(keys) {
        if (this.designMode) return [{ title: "", keys }];

        const base = baseProperties();
        const rest = keys.filter((k) => !ESSENTIAL.includes(k));

        const pick = (names) => names.filter((k) => rest.includes(k));

        const own    = rest.filter((k) => !base.includes(k));
        const look   = pick(APPEARANCE);
        const place  = pick(LAYOUT);
        const others = rest.filter((k) => !own.includes(k) &&
                                          !look.includes(k) && !place.includes(k));

        return [
            /* In the order they are written and not sorted: `Name` is the first
             * question and `Text` the second. */
            { title: Locale.Text("Essential"),
              keys: ESSENTIAL.filter((k) => keys.includes(k)) },
            { title: this.typeName(),   keys: own },
            { title: Locale.Text("Appearance"), keys: look },
            { title: Locale.Text("Layout"),     keys: place },
            { title: Locale.Text("Behaviour"),  keys: others },
        ].filter((g) => g.keys.length);
    }

    /*
     * What to call the group of the widget's own properties: the kind of thing
     * it is. Not translated -- it is the class's name, the same word the palette
     * and the `.form` use.
     */
    typeName() {
        if (this.target && this.target.__node) return this.target.__node.type;
        if (this.target) return this.target.constructor.name;

        return this.designer.root ? this.designer.root.class : "Form";
    }

    build(keys) {
        const grid = this.ide.PropGrid;

        /* Nothing to unwire: each handler belongs to the editor it was installed
         * on and goes when the grid is emptied.  It used to be four `delete`s a
         * key here -- and two families they did not cover (`Prop_<Key>_IconClick`
         * and `PropSample<N>_Click`), which stayed on the IDE's form holding the
         * editor and the target they closed over, one set per rebuild. */
        grid.Clear();
        this.propKeys   = keys;
        this.builtFor = this.target;
        this.editors    = {};
        this.names      = {};
        this.rowInfo    = [];

        /*
         * Every row the selection has, whatever is typed in the filter box: the
         * grid is built for a *control* and hidden for a *search*, which is what
         * lets a keystroke cost a question per row instead of a rebuild.
         */
        for (const group of this.groupsOf(keys)) {
            if (group.title) this.addHeading(group.title, group.keys);
            for (const key of group.keys) this.addRow(key);
        }

        /* The rows were filtered as they arrived -- GTK asks on insertion -- but
         * only for a row whose content was already in place. Asking once more
         * over the finished grid costs one pass and owes nothing to that order. */
        grid.Refilter();
    }

    /* A heading is a row like any other -- the grid is a list -- wearing the
     * theme's own small-and-bold class, so it needs no stylesheet of ours.
     * It is shown while anything under it is, which is what `keys` is for. */
    addHeading(title, keys) {
        const head = new Label();
        head.Text   = title;
        head.Style  = "caption-heading";
        head.Margin = 4;

        this.rowInfo.push(keys);      // before Add: GTK filters on insertion
        this.ide.PropGrid.Add(head);
    }

    addRow(key) {
        const row = new Panel();
        row.Arrangement = "Horizontal";
        row.Spacing = 6;
        row.Margin  = 2;

        this.rowInfo.push([key]);
        this.ide.PropGrid.Add(row);   // the row first, then what goes inside it

        /* Markup, because a property that is not at its default is shown in
         * bold and the name is what carries it. A property name is an
         * identifier, so there is nothing in it to escape. */
        const label = new Label();
        label.Markup = true;
        label.Text   = key;
        label.Width  = PROP_LABEL_W;
        row.Add(label);

        const editor = this.makeEditor(key);
        editor.Name    = `Prop_${key}`;
        editor.HExpand = true;

        /*
         * The way back to "whatever the theme says".
         *
         * A button of the row's, and not part of the control: a `ColorButton` is
         * a swatch and a `FontButton` shows a font, and neither has any idea of
         * *none* -- which is a value here, and the one most controls are in. It
         * lived inside those two controls until this row took it over, and the
         * box it needed there was what a theme class landed on instead of the
         * button. This is a program that builds rows of controls for a living;
         * the runtime is not.
         *
         * **The two of them go in a `linked` panel**, which is the theme's own
         * way of saying "these are one control": the swatch gives up its right
         * corners and its right border, the clear gives up its left ones, and
         * they meet. Which is what the pair *is* -- a value and the way back to
         * none of it -- and it reads that way now instead of as a control with
         * something loose beside it.
         *
         * The wrapper is there because the class needs the pair as its **direct**
         * children: Adwaita writes `.linked:not(.vertical) > colorbutton > button`
         * and `> fontbutton > button`, so the class has to sit one level above the
         * two and no further. On the row itself it would take in the name label,
         * which is not part of the control and has no business being linked to it.
         *
         * And the clear is **not** `flat` in here. Those rules set radii and
         * borders and nothing else, while `button.flat` blanks background and
         * border-colour outright -- so a flat member of a linked pair draws as a
         * swatch with a squared-off edge and empty space beside it, which is worse
         * than either. Linking a button means letting it be a button.
         */
        if (this.clearable(key)) {
            const group = new Panel();
            group.Arrangement = "Horizontal";
            group.Style       = "linked";
            group.HExpand     = true;
            row.Add(group);           // the group first, then what goes inside it

            group.Add(editor);

            const clear = new Button();
            /* Named for what it is and not to dispatch by -- the handler is the
             * button's own.  The name is how a test finds it on the row. */
            clear.Name    = `PropClear_${key}`;
            clear.Icon    = ICON_CLEAR.find((n) => Application.HasIcon(n)) || "";
            clear.Tooltip = Locale.Text("Back to the theme's");
            /* Assigning `""` is what clearing *is* -- the same value the .form
             * would carry -- and it goes out to GTK and comes back as a real
             * Change, so the apply is the one that would have run anyway. */
            clear.On("Click", () => {
                editor.Value = "";
                this.applyEditor(key);
            });
            group.Add(clear);
        } else {
            row.Add(editor);
        }

        this.editors[key] = editor;
        this.names[key]   = label;
        this.bindEditor(key, editor);
    }

    /*
     * Which property the user is pointing at: the row whose editor has the
     * focus, or `""` when none of them has it.
     *
     * Asked by F1, and answered by asking the editors rather than by keeping a
     * *current row* of our own -- the grid is built out of ordinary controls, so
     * where the focus is *is* the answer, and a second copy of it would be one
     * more thing to keep in step with the rebuilds this class does.
     */
    currentProperty() {
        for (const key in this.editors)
            if (this.editors[key] && this.editors[key].Focused) return key;
        return "";
    }

    /* Which rows carry that button: the two whose control cannot say "none" on
     * its own, which is the same pair that is edited by a chooser. */
    clearable(key) {
        return !this.designMode && (this.isColor(key) || this.isFont(key));
    }

    /* The control a property is edited with, chosen by what the property is
     * capable of being worth. */
    makeEditor(key) {
        /*
         * A design value is always prose, so it is always a text field -- with
         * the button that fills it with a sample, which is the same
         * button-inside-the-field the Icon row uses.  The placeholder behind an
         * empty one shows the real value (see `sync`), which is what makes
         * "no design value" and "a design value of nothing" stop looking alike.
         */
        if (this.designMode && key === ITEM_OF) {
            /* The project's components, and "" for none: what a list may draw is
             * a closed list, unlike prose, so it is a drop-down and not a field
             * somebody has to spell a class name into. */
            const combo = new ComboBox();
            combo.Items = ["", ...this.designer.components.map((c) => c.name)];
            return combo;
        }

        if (this.designMode) {
            const box = new TextBox();

            /* The sample button is for prose. A menu offering *Lorem ipsum* and
             * *San Miguel de Tucumán* for how many rows a table shows would be
             * the widget saying something false about what it wants. */
            if (!this.isDesignNumber(key)) {
                box.Icon    = ICON_SAMPLE.find((n) => Application.HasIcon(n)) || "";
                box.Tooltip = Locale.Text("Fill with a sample");
            } else {
                box.Tooltip = Locale.Text("How many the designer shows; the application decides the real number");
            }
            return box;
        }

        const value   = this.propertyValue(key);
        /*
         * The form has no live widget to ask, so the probe answers for it --
         * which is what gets Arrangement a drop-down instead of a text box.
         *
         * A stand-in has one and must not be asked: it is a Label, and a
         * component property that happens to share a name with one of Label's
         * would be offered the Label's values.  Its class is read instead, and
         * one that declares no list gets the text field it always had.
         */
        const options = this.target && this.target.__node
            ? this.designer.componentOptions(this.target.__node.type, key)
            : (this.target ? this.target.PropertyOptions(key)
                           : this.formProbe().PropertyOptions(key));

        if (options) {
            const combo = new ComboBox();
            /* What the control holds today goes in the list even if it is not
             * among the offered values: the grid shows what is there, not what
             * ought to be. */
            combo.Items = options.includes(value) ? options : [value, ...options];
            return combo;
        }
        /*
         * **Style is typed, and offered -- not chosen from a closed list.**
         *
         * It was a drop-down, and a drop-down was wrong twice over. The property
         * takes a *list* of classes (`"card title-3"`), and a combo can only ever
         * put one in: across the thirty-nine `.form` files here not one carries a
         * combination, while the IDE's own code uses three at a time, because from
         * code you can. And which classes exist is the theme's answer, the
         * project's, and that of whatever theme the person has installed -- so a
         * closed list was a menu claiming to be complete for a vocabulary that is
         * open by definition.
         *
         * The button inside the field offers what we do know, and **appends**
         * rather than replaces, which is what a list-valued property wants. The
         * row's tooltip says which CSS node the class will land on; the vocabulary
         * itself is in docs/widgets.md, generated from the theme by
         * `tests/styles.sh`.
         */
        if (key === "Style") {
            const box = new TextBox();
            box.Icon    = STYLE_PICK.find((n) => Application.HasIcon(n)) || "";
            box.Tooltip = Locale.Text("Add a class");
            return box;
        }

        if (typeof value === "boolean") {
            const combo = new ComboBox();
            combo.Items = ["false", "true"];
            return combo;
        }
        if (typeof value === "number") {
            const spin = new SpinBox();
            spin.Min = NUMBER_MIN;
            spin.Max = NUMBER_MAX;

            /* How many decimals it gets is `sync`'s, and only `sync`'s: the
             * answer follows the control's own state, so it has to be re-asked
             * after an edit and not settled once when the row is made. */
            return spin;
        }

        /*
         * A colour is a swatch, not six hex digits: the row shows what the
         * value *is* and opens the desktop's chooser when pressed, with a
         * clear beside it because "" -- whatever the theme says -- is a value
         * one needs a way back to.
         */
        if (this.isColor(key)) return new ColorButton();

        /* A font is shown *in* itself, which is what a font button is for, and
         * cleared back to the theme's the same way a colour is. */
        if (this.isFont(key)) return new FontButton();

        /*
         * An icon name is picked out of thousands, so the field carries the
         * button that opens the chooser -- the same TextBox.Icon the folder
         * field in NewProjectForm uses, which is what that property is for.
         *
         * Recognised by name, which is a convention rather than something the
         * runtime declares: `Name` is already special here for the same kind of
         * reason.
         */
        const box = new TextBox();
        if (key === "Icon") {
            box.Icon    = ICON_PICK.find((n) => Application.HasIcon(n)) || "";
            box.Tooltip = Locale.Text("Choose an icon");
        } else if (key === "Columns") {
            /* The JSON stays editable behind it -- it is the value, and someone
             * will want to paste one. The button is for the other ninety-nine
             * times: a column carries a heading, a width and an alignment, and
             * typing `[{"Text":"Name","Width":200}]` is not editing. */
            box.Icon    = COLUMN_PICK.find((n) => Application.HasIcon(n)) || "";
            box.Tooltip = Locale.Text("Edit the columns");
        }
        return box;
    }

    /* The editors are created on the fly, so each carries its own handler --
     * which is what lets the grid be rebuilt on every change of selection
     * without a list of names to take back off the IDE's form.
     *
     * A drop-down and a spin apply as soon as they change -- choosing is already
     * deciding.  A text field waits for Enter: applying on every keystroke would
     * rename a control once per letter typed. */
    bindEditor(key, editor) {
        const apply = () => this.applyEditor(key);

        if (editor instanceof ComboBox)          editor.On("Select",   apply);
        else if (editor instanceof SpinBox)      editor.On("Change",   apply);
        else if (editor instanceof ColorButton)  editor.On("Change",   apply);
        else if (editor instanceof FontButton)   editor.On("Change",   apply);
        else                                     editor.On("Activate", apply);

        /*
         * The icon inside the field opens the chooser, and what comes back is
         * applied as if it had been typed and entered.
         *
         * **Only where there is an icon to click.**  In design mode this used to
         * be wired on every editor, and two of the three shapes `makeEditor`
         * builds there cannot raise it: the `ITEM_OF` drop-down is a `ComboBox`,
         * which has no field to put a button in, and a design *number* is a
         * `TextBox` deliberately given no sample button -- offering *Lorem ipsum*
         * for how many rows a table shows would be the widget saying something
         * false.  Both were handlers that could never fire, and under dispatch by
         * name nothing said so.  Asked of the icon rather than by repeating
         * `makeEditor`'s condition, so the two cannot drift apart.
         */
        if (this.designMode) {
            if (editor instanceof TextBox && editor.Icon)
                editor.On("IconClick", () => this.pickSample(key));
        } else if (key === "Icon") {
            editor.On("IconClick", () => this.pickIcon(key));
        } else if (key === "Columns") {
            editor.On("IconClick", () => this.editColumns(key));
        } else if (key === "Style") {
            editor.On("IconClick", () => this.pickStyle(key));
        }
    }

    /*
     * The sample menu, popped from the button inside the field.
     *
     * A popup on a widget rather than a form of its own: it is nine fixed
     * choices, and what comes back is written into the field and applied as if
     * it had been typed -- so the .form ends up holding the words themselves.
     */
    pickSample(key) {
        const editor = this.editors[key];

        editor.Menu = SAMPLES.map(([label, text], i) => ({
            name: `PropSample${i}`, text: label,
        }));

        /*
         * **The one place in this grid that still dispatches by name**, because
         * a menu item is not a widget and has nowhere to carry a handler.
         *
         * So it is wired **once** and reads which field it was opened for out of
         * `sampleKey`, rather than being rewired per click with a closure over
         * that click's editor.  Written the closure way -- which it was -- every
         * open replaced nine handlers on the IDE's form with nine more, and the
         * set that stayed there held the editor and the control of whichever
         * field was sampled last, for the life of the process, with nothing to
         * delete them.
         */
        this.sampleKey = key;

        if (!this.samplesWired) {
            for (const [i, [, text]] of SAMPLES.entries()) {
                this.ide[`PropSample${i}_Click`] = () => {
                    const target = this.editors[this.sampleKey];
                    if (!target) return;    /* the grid was rebuilt under the menu */

                    target.Text = text;
                    this.applyEditor(this.sampleKey);
                };
            }
            this.samplesWired = true;
        }
        editor.PopupMenu(0, 0);
    }

    /*
     * The classes on offer, in a dialog.
     *
     * A form of its own and not a popup menu, which is what this was first: a
     * menu can show a name and nothing else, cannot show what is already on the
     * control, and makes a combination something one builds a popup at a time --
     * while `Style` is a *list*. The icon chooser settled this shape already; a
     * list of names is widgets.
     *
     * What comes back replaces the whole value, which is why the dialog is given
     * what is there: it puts those first and ticked, including a class typed by
     * hand that no stylesheet here has heard of.
     */
    pickStyle(key) {
        const editor = this.editors[key];

        this.ide.stylePicker =
            StyleForm.pick(editor.Text, this.styleClasses(),
                           { node: this.styleNode(), type: this.typeName(),
                             /* A class that dresses `> children` needs a control that
                              * takes controls: what a ListBox holds is strings. */
                             container: !!this.target && "Children" in this.target,
                             /* Where a class of one's own is written: app.css, so it
                              * can be worn by every control that wants it. */
                             project: this.ide.project,
                             /* The picker opens the class editor itself, so it is the
                              * one that has to leave it reachable. */
                             ide: this.ide },
                           (value) => {
            editor.Text = value;
            this.applyEditor(key);
        });
    }

    isColor(key) {
        if (key === "Background" || key === "Foreground") return true;

        /* And a colour button's own `Value`, which is a colour because of what
         * is holding it. See `isFont` for why this is asked of the control. */
        return key === "Value" && this.target instanceof ColorButton;
    }

    /*
     * The same question for a font, and the same two answers: `Font`, which
     * every widget has, and a `FontButton`'s `Value`.
     *
     * **Asked of the control and not listed per type.** A `ColorButton`'s
     * `Value` is a colour for the same reason `Background` is one, so it is
     * edited with the same swatch and cleared with the same button -- the IDE
     * offered the two controls from the palette and then edited the very value
     * they exist to pick as six characters of text. What decides is the class of
     * the thing selected, which is a fact and not a convention.
     */
    isFont(key) {
        if (key === "Font") return true;
        return key === "Value" && this.target instanceof FontButton;
    }

    /*
     * The selection as a throwaway: same class, same properties.
     *
     * The live control cannot be the one asked -- assigning `Min` to ask about it
     * would clamp the `Value` beside it, and putting `Min` back does not put the
     * `Value` back. A copy can be disturbed freely, which is the whole reason it
     * exists.
     *
     * The state is `Serialize()`'s dictionary, which is exactly what differs from
     * a fresh one of the class, so it is both the properties to apply and the
     * fingerprint that says whether anything changed. A stand-in has no class
     * here to make one of and the form has no class at all: the first gets
     * nothing, the second its own probe, which is what that probe is for.
     */
    fractionProbe() {
        const state = this.probeState();
        if (state === this.fracState) return this.fracProbe;

        if (this.fracOwned && this.fracProbe) this.fracProbe.Delete();
        this.fracProbe   = null;
        this.fracOwned   = false;
        this.fracState   = state;
        this.fracAnswers = new Map();

        if (!this.target) {
            this.fracProbe = this.formProbe();
            return this.fracProbe;
        }
        if (this.target.__node) return null;   /* a stand-in: not ours to make */

        try {
            const made = Widget.New(this.target.constructor.name);
            for (const entry of Dictionary.Entries(this.fracProps)) {
                try { made[entry.Key] = entry.Value; }
                catch (e) { /* one it will not take */ }
            }
            this.fracProbe = made;
            this.fracOwned = true;
        } catch (e) {
            this.fracProbe = null;                /* a class we cannot make */
        }
        return this.fracProbe;
    }

    /* What the probe would have to be, as one string: the class and the
     * properties that differ from a fresh one of it. */
    probeState() {
        if (!this.target) return "Form";

        const type = this.target.constructor.name;
        if (this.target.__node) return `${type}:standin`;

        try {
            this.fracProps = this.target.Serialize().properties || {};
        } catch (e) {
            this.fracProps = {};
        }
        return `${type}:${JSON.stringify(this.fracProps)}`;
    }

    /*
     * How many decimals this property holds, on this control as it stands.
     *
     * Reads the probe rather than asking for one: `sync` refreshes it once, at
     * the top, and then asks this per numeric row -- so the `Serialize` that
     * decides whether the probe is still good is paid once per refresh of the
     * grid and not once per row of it.
     */
    digitsFor(key) {
        if (!this.fracProbe) return 0;

        if (!this.fracAnswers.has(key))
            this.fracAnswers.set(key, fractionDigits(this.fracProbe, key));
        return this.fracAnswers.get(key);
    }

    /*
     * What the Style drop-down offers: the classes the project's own stylesheet
     * declares, then the theme's.  app.css is found by name, exactly as the
     * runtime finds it -- nothing in project.json points at it, so nothing here
     * has to be configured either.
     *
     * Read fresh rather than cached: a class written into app.css in the editor
     * beside this grid has to be choosable without reopening anything, and the
     * grid is only rebuilt when the set of properties changes.
     *
     * What the canvas cannot do is *wear* them.  The designer draws real
     * controls in the IDE's process, and a stylesheet is loaded per process, so
     * a class of the project's is offered here and shows up when the project is
     * run.  The theme's own do show, because they are this process's too.
     */
    styleClasses() {
        const path = this.ide.project
            ? File.Join(this.ide.project, "app.css") : null;
        const own  = [];

        try {
            if (path && File.Exists(path)) {
                /* Comments out of the way first: prose is full of things that
                 * read as a class ("e.g.") and none of them are one. */
                const src = File.Load(path).replace(/\/\*[^]*?\*\//g, " ");
                /* `.name`, wherever it appears: `.a.b` is two classes and
                 * `button.danger` is one.  A number cannot be caught by it --
                 * "0.55" has no letter after the dot. */
                const re = /\.([A-Za-z_-][A-Za-z0-9_-]*)/g;
                let m;

                while ((m = re.exec(src)) !== null)
                    if (!own.includes(m[1])) own.push(m[1]);
            }
        } catch (e) {
            /* Unreadable sheet: the theme's classes are still true. */
        }

        /*
         * The project's first: they are the answer more often. The theme's come
         * from `Ide.Styles`, which is generated from the theme itself
         * (`tests/styles.sh --json`) -- there used to be a list of twenty-three
         * names written out here, and a hand-written list is the thing this
         * codebase has been bitten by twice.
         *
         * No leading `""` any more: the row is a text field, so the way back
         * from a class is deleting it, and an empty entry in a chooser of
         * checkboxes would be a box that means nothing.
         */
        const theme = Ide.Styles.all.map((c) => c.name);

        return [...own.sort(), ...theme.filter((name) => !own.includes(name))];
    }

    /* The icon chooser is a Bintana form -- a list of names is widgets. The
     * colour one is a control of its own, because a swatch is what a colour
     * looks like and a wheel is not something the widget set can be. */
    pickIcon(key) {
        this.ide.iconPicker = IconForm.pick(String(this.propertyValue(key) || ""), (name) => {
            this.editors[key].Text = name;
            this.applyEditor(key);
        });
    }

    /*
     * The columns of a TableView, in a dialog rather than as JSON.
     *
     * What comes back is written into the field and applied as if it had been
     * typed and entered -- so it goes through the same setter, the same
     * validation and the same one undo entry as any other property edit, and
     * this method knows nothing about what a column is.
     */
    editColumns(key) {
        const now = this.propertyValue(key);

        this.ide.columnEditor = ColumnForm.edit(Array.isArray(now) ? now : [],
            (cols) => {
                this.editors[key].Text = JSON.stringify(cols);
                this.applyEditor(key);
            });
    }

    /* The editors show what the control holds now.  A flag marks that the grid
     * is the one writing, because assigning a value to an editor fires its event
     * exactly as if the user had touched it. */
    /* What the designer is showing instead of the declared value, wherever this
     * target keeps it. */
    designValue(key) {
        /* The `item` key is the node's own and lives on the control, which is
         * where the serialiser reads it from. */
        if (this.isItemKey(key)) {
            const item = this.target && this.target.Item;
            if (!item) return undefined;
            return key === ITEM_OF ? item.of : item.count;
        }
        if (!this.target) {
            const bag = (this.designer.root && this.designer.root.design) || {};
            return bag[key];
        }
        if (this.target.__node) return (this.target.__node.design || {})[key];
        return this.target.DesignValue(key);
    }

    /* And what the file actually says, which is what shows through an empty
     * field as its placeholder. */
    declaredFor(key) {
        /* Nothing stands behind the item's name; behind the count stands the
         * number the designer draws when the file does not say. */
        if (key === ITEM_OF)    return "";
        /* `PREVIEW_ROWS` is Designer's: every file under `ide` shares one
         * lexical scope, which is the same reason `Palette` reads `Chrome`'s
         * SELECT_COLOR. */
        if (key === ITEM_COUNT) return PREVIEW_ROWS;
        if (!this.target) return this.formProperty(key);
        if (this.target.__node) return (this.target.__node.properties || {})[key];
        return this.target.Declared(key);
    }

    sync() {
        this.updating = true;
        try {
            /* Before the rows: the probe the fraction question is put to follows
             * the control's own state, and an edit is the thing that changes it.
             * `applyEditor` ends in `fill`, so this is the beat after one. */
            this.fractionProbe();

            const written = this.writtenKeys();

            for (const key of this.propKeys) {
                const editor = this.editors[key];

                this.showState(key, written.has(key));

                /*
                 * An empty field means "no design value, the real one is used",
                 * and the placeholder says which that is.  Without it the two
                 * states -- nothing set, and set to nothing -- would look
                 * identical, and there would be no way to see what you were
                 * standing in for.
                 */
                if (this.designMode) {
                    const design = this.designValue(key);
                    editor.Text        = design === undefined ? "" : String(design);
                    editor.Placeholder = this.show(this.declaredFor(key));
                    continue;
                }

                const value  = this.propertyValue(key);

                if (editor instanceof SpinBox) {
                    /*
                     * As many decimals as the control holds, and never fewer
                     * than the number in hand carries -- the digits are what a
                     * spin *stores*, so a box with two of them holds 0.125 as
                     * 0.13. A whole-number property answers 0 to both, and the
                     * spin is the integer one it always was.
                     */
                    const digits = Math.max(this.digitsFor(key), digitsOf(value));

                    if (editor.Decimals !== digits) {
                        editor.Decimals = digits;
                        editor.Step     = digits ? FRACTION_STEP : 1;
                    }
                    editor.Value = value;
                }
                else if (editor instanceof ColorButton) editor.Value = this.show(value);
                else if (editor instanceof FontButton)  editor.Value = this.show(value);
                else if (editor instanceof ComboBox)    this.showInCombo(editor, value);
                else                                    editor.Text = this.show(value);
            }
        } finally {
            this.updating = false;
        }
    }

    /*
     * **Bold is "this is in the file".**
     *
     * Which is the same question as "is this not at its default", and asked the
     * way the file itself asks it: `Serialize` writes only what differs from a
     * fresh instance of the class, so the keys it returns are exactly the ones
     * the `.form` will carry. Nothing here decides what a default is -- the
     * runtime already does, and a second opinion would eventually disagree with
     * the file.
     *
     * In design mode it means the same thing about the other dictionary: a row
     * is bold when it has a design value of its own.
     *
     * `Name` is the one property this never marks, and rightly: a node carries
     * its name as a field of its own rather than inside `properties`, so it is
     * never in the dictionary -- and it needs no marking, being the first row of
     * the first group.
     */
    writtenKeys() {
        if (this.designMode) {
            return new Set(this.propKeys.filter(
                (key) => this.designValue(key) !== undefined));
        }

        /* A stand-in and the form both keep their properties in a node, since
         * neither is the live control the grid is editing. */
        const node = this.target ? (this.target.__node || null)
                                 : this.designer.root;
        if (node) return new Set(Dictionary.Keys(node.properties));

        try {
            return new Set(Dictionary.Keys(this.target.Serialize().properties));
        } catch (e) {
            return new Set();
        }
    }

    /*
     * What the row looks like: bold when the file carries it, grey when
     * something else has turned it off, and a tooltip that says which something.
     */
    showState(key, written) {
        const label = this.names[key];
        if (label) label.Text = written ? `<b>${key}</b>` : key;

        const because = this.disabledReason(key);
        const editor  = this.editors[key];

        editor.Enabled = !because;
        if (label) label.Enabled = !because;

        /* The row's tooltip is why it is off, and when it is on, whatever the
         * row has to say for itself. Set here rather than where the editor is
         * built because this runs on every sync and would overwrite it. */
        const says = because || this.rowHint(key);

        editor.Tooltip = says;
        if (label) label.Tooltip = says;
    }

    /*
     * What a row says for itself, which today is one row: `Style`.
     *
     * **A class goes on one node, and that node decides which of the theme's
     * rules can reach it** -- `button.suggested-action` reaches a `Button` and
     * never a `ColorButton`, whose node is `colorbutton`. A class written for
     * another node is accepted, saved into the `.form`, and does nothing, which
     * is the quietest failure this runtime has; the node is the one fact that
     * turns it from *"it did not work"* into *"of course not"*.
     *
     * `CssNode()` is asked of the control rather than kept in a table here --
     * the runtime asks GTK, so it cannot drift from what the widget is.
     */
    rowHint(key) {
        if (key !== "Style") return "";

        const node = this.styleNode();
        return node ? Locale.Text(
            "The class goes on this control's {0} node. One written for another " +
            "node is saved and does nothing.", node) : "";
    }

    /* The node the class would land on, or "" when there is no live control to
     * ask: a stand-in is a node in a file, and the designer does not have the
     * component's class to build one from. */
    styleNode() {
        if (this.target && this.target.__node) return "";

        try {
            return (this.target || this.formProbe()).CssNode();
        } catch (e) {
            return "";
        }
    }

    /*
     * Why this row is turned off, or "" when it is not.
     *
     * The sentence is the point: a grey row with no explanation is a bug report
     * waiting to happen, and every one of these has an answer as short as "the
     * box places it".
     */
    disabledReason(key) {
        const target = this.target;
        if (this.designMode || !target) return "";

        /* Where a control sits is the parent's rule, and each half is inert
         * under the other. A stand-in is placed like anything else.
         *
         * Asked of the container rather than of a boolean, because there are
         * three answers and not two: a stack does not place a child either, and
         * telling the author that "the box decides" about a control in an
         * `Overlay` sends them looking for a box that is not there. */
        const places = this.designer.placementOf(this.designer.parentOf(target));

        if (places === "Layers" && PLACED_BY_BOX.includes(key))
            return Locale.Text("An overlay stacks its children: HAlign and VAlign place this one.");
        if (places === "Single" && PLACED_BY_BOX.includes(key))
            return Locale.Text("This container gives its one child the whole of its room.");
        if (places !== "Coordinates" && PLACED_BY_BOX.includes(key))
            return Locale.Text("The box this control is in decides where it goes.");
        if (places === "Coordinates" && PLACED_BY_ANCHORS.includes(key))
            return Locale.Text("On a fixed surface a control keeps the place and size it was given.");

        /* And the pairs inside one widget, asked of the widget itself. A
         * stand-in has none of them: what it is standing in for is a class this
         * project cannot ask. */
        const off = !target.__node && USELESS[key] ? USELESS[key](target) : "";
        return off ? Locale.Text("Does nothing while {0} is off.", off) : "";
    }

    /* A ComboBox rejects what is not in its list, which is what one wants from a
     * drop-down but not when the control is already worth that. */
    showInCombo(combo, value) {
        const text = this.show(value);
        if (!combo.Items.includes(text)) combo.Add(text);
        combo.Text = text;
    }

    propertyValue(key) {
        if (!this.target) return this.formProperty(key);

        /* A stand-in is a Label wearing a component's name: the component's own
         * properties are not on it, they are in the node it came from. */
        if (this.target.__node && !STANDIN_PROPS.includes(key)) {
            const p = this.target.__node.properties || {};
            return key in p ? p[key] : "";
        }
        return this.target[key];
    }

    show(value) {
        return Array.isArray(value) ? JSON.stringify(value) : String(value);
    }

    /* What the editor holds, already in the property's type: the string "false"
     * assigned to a boolean would come out true. */
    editorValue(key) {
        const editor  = this.editors[key];
        const current = this.propertyValue(key);

        if (editor instanceof SpinBox)     return editor.Value;
        if (editor instanceof ColorButton) return editor.Value;
        if (editor instanceof FontButton)  return editor.Value;
        if (typeof current === "boolean") return editor.Text === "true";
        if (Array.isArray(current)) {
            const parsed = JSON.parse(editor.Text);
            if (!Array.isArray(parsed)) throw new Error("a JSON list was expected");
            return parsed;
        }
        return editor.Text;
    }

    formProperty(key) {
        const p = (this.designer.root && this.designer.root.properties) || {};
        if (key === "Width")  return this.designer.formSize().w;
        if (key === "Height") return this.designer.formSize().h;

        /* What the .form says, or what a fresh form would answer.  A real value
         * of the right type matters: the editor is chosen by it, so a boolean
         * that came back as "" would be edited in a text box. */
        return key in p ? p[key] : this.formProbe()[key];
    }

    /* The form is not a control, so its property is not assigned to a widget but
     * to the root node, which is what gets saved. */
    applyFormProperty(key, value) {
        if ((key === "Width" || key === "Height") &&
            (!Number.isFinite(value) || value <= 0)) {
            Message.Error("{0}: {1} is not a valid size.", key, value);
            this.sync();
            return;
        }

        this.beginEdit(key);
        this.designer.setFormProperty(key, value);
        this.fill();
        this.designer.chrome.position();
        this.designer.touch();
    }

    /*
     * A spin sends one event per click on the arrow and per keystroke, so an undo
     * entry per event would make the history useless.  Consecutive changes to the
     * same property of the same control count as a single edit; any other action
     * of the designer closes it -- `Designer.pushUndo` says so, since whatever it
     * is pushing is not the edit that was open.
     */
    beginEdit(key) {
        if (this.editKey === key && this.editTarget === this.target) return;

        this.designer.pushUndo();
        this.editKey    = key;
        this.editTarget = this.target;
    }

    closeEdit() {
        this.editKey    = null;
        this.editTarget = null;
    }

    /* What each editor of the grid fires. */
    /*
     * What type a component's property is, without its class to ask.
     *
     * What the node already holds says it, and `editorValue` has already read
     * the editor in that type.  For one being set for the first time there is
     * nothing to go on but the text -- so it is read as the JSON it is about to
     * become, because a `.form` *is* JSON and `5` and `"5"` are not the same
     * thing in it.  Anything that is not a JSON scalar stays a string, which is
     * what a name or a caption should be.
     */
    componentValue(value, current) {
        if (current !== "" && current !== undefined) return value;
        if (typeof value !== "string") return value;

        try {
            const parsed = JSON.parse(value);
            return (typeof parsed === "number" || typeof parsed === "boolean")
                ? parsed : value;
        } catch (e) {
            return value;
        }
    }

    /*
     * What goes into the block: the text as typed, or a real number for the rows
     * that are counted.
     *
     * **A number and not the digits**, so the `.form` holds `3` and the loader's
     * own setter gets what it expects -- the same care `componentValue` takes
     * with a component's property. Empty is empty in both cases: it is how a
     * design value is removed.
     *
     * `undefined` means the value was refused and said so, which is the one
     * answer the caller must not write.
     */
    designTyped(key, text) {
        const typed = String(text).trim();

        if (!this.isDesignNumber(key) || typed === "") return text;

        const n = Number(typed);
        if (!Number.isFinite(n) || n < 0 || Math.round(n) !== n) {
            Message.Error("{0}: {1} is not a number of rows.", key, typed);
            this.sync();
            return undefined;
        }
        return n;
    }

    /*
     * The item a list draws, which is one key made of two rows: whichever was
     * edited is taken from the grid and the other from what is already there.
     *
     * It goes through the designer rather than being written here, because
     * changing it is not a value changing -- the rows on the canvas have to go
     * and be drawn again, and a list that holds controls of its own has to be
     * told no.
     */
    applyItem(key, value) {
        const item  = (this.target && this.target.Item) || {};
        const of    = key === ITEM_OF    ? String(value).trim() : (item.of || "");
        const count = key === ITEM_COUNT ? value : item.count;

        if (key === ITEM_OF && of === (item.of || "")) return;
        if (key === ITEM_COUNT && count === item.count) return;

        this.designer.setItem(this.target, of, count);
        this.sync();
    }

    /*
     * A design value, written wherever this target keeps it.
     *
     * Undoable and dirtying like any other edit, and it needs nothing of its own
     * for that: undo is a snapshot of the serialised tree, and the `design` block
     * is part of that tree now.
     */
    applyDesign(key, value) {
        if (sameJsonValue(value, this.designValue(key) ?? "")) return;

        this.beginEdit(key);

        if (!this.target)                this.designer.setFormDesign(key, value);
        else if (this.target.__node) {
            const node = this.target.__node;
            node.design = node.design || {};
            if (value === "") delete node.design[key];
            else              node.design[key] = value;
        } else {
            this.target.SetDesign(key, value);
        }

        this.sync();
        this.designer.chrome.position();
        this.designer.touch();
    }

    applyEditor(key) {
        if (this.updating || !this.propKeys.includes(key)) return;

        if (this.designMode) {
            const typed = this.designTyped(key, this.editors[key].Text);
            if (typed === undefined) return;

            if (this.isItemKey(key)) this.applyItem(key, typed);
            else                     this.applyDesign(key, typed);
            return;
        }

        let value;
        try {
            value = this.editorValue(key);
        } catch (e) {
            Message.Error(`${key}: ${e.message}`);
            this.sync();
            return;
        }

        /*
         * An edit that changes nothing is not an edit.  `updating` guards
         * the grid while it fills itself in, but a `ColorButton` and a
         * `FontButton` report their change on GTK's own time -- after the flag
         * is back down -- so filling the grid arrived here anyway, three times,
         * pushing three undo entries and marking a form dirty that nobody had
         * touched.  It went unnoticed while every tab switch threw the undo
         * stack away; a designer that survives one shows it immediately.
         */
        if (sameJsonValue(value, this.propertyValue(key))) return;

        if (!this.target) {
            this.applyFormProperty(key, value);
            return;
        }

        /* The name is not a property like the others: the code's handlers go
         * with it, and that is not undoable. */
        if (key === "Name") {
            this.designer.renameControl(String(value).trim());
            return;
        }

        /*
         * A component's own property is not on the stand-in -- the designer
         * does not have its class -- so it is written where it lives and where
         * the runtime will read it from: the node.
         */
        if (this.target.__node && !STANDIN_PROPS.includes(key)) {
            const node = this.target.__node;

            this.beginEdit(key);
            node.properties = node.properties || {};
            node.properties[key] = this.componentValue(value, this.propertyValue(key));

            this.sync();
            this.designer.touch();
            return;
        }

        this.beginEdit(key);
        try {
            this.target[key] = value;
        } catch (e) {
            Message.Error(`${key}: ${e.message}`);
            this.sync();
            return;
        }

        this.fill();
        this.designer.chrome.position();
        this.designer.touch();
    }
};
