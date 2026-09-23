/*
 * The control palette, and what the IDE knows about a type of control: which
 * group it belongs to, what icon it is shown with, how big it starts out.
 *
 * The tables are read by more than the palette -- the control tree shows a
 * control with the palette's icon for its type, and the designer takes a new
 * control's size from `DEFAULT_SIZE` -- which is what keeps a control looking
 * the same wherever the IDE draws it.
 *
 * The palette itself is **one widget shared by every open designer**, so it is
 * the IDE's and not a designer's: the buttons dispatch to whichever form is on
 * screen, and only what the palette *offers* -- the project's components --
 * needs a rebuild.  Each designer used to decide on its own, which came to 108
 * rebuilds of the same palette in one suite run at ~160 ms each: a third of its
 * running time, and a visible hitch every time a user moved between two forms.
 */
"use strict";

Namespace("Ide");

/*
 * The palette: tabs of square buttons, one per type of control.
 *
 * An icon is recognised faster than a line of a drop-down list, and grouping by
 * what-it-is-for shows everything in the group at a glance -- which a list of
 * nine items never did.
 *
 * **Every type that can be placed is here**, and `tests/ide` asserts it against
 * `Widget.Types()` rather than against a second list. It has to, because the
 * table was quietly six short: `TreeView`, `SourceEditor`, `Terminal`, `RowList`,
 * `Overlay` and `Flow` were classes of the runtime that no button offered, and
 * the IDE's own forms are built out of five of them -- eight `RowList`s, four
 * `TreeView`s, three `SourceEditor`s. So the IDE was drawn with controls its user
 * could not place, and nothing said so: the icons were in the table below (the
 * control tree needs one for whatever a form holds), the tabs were not.
 *
 * `Views` is where the ones that show content ended up, which is what pulled
 * `TableView` out of `Data`: a table, a tree, an editor and a terminal are the
 * same kind of thing -- a window onto something the program has -- and `Data` is
 * the controls that hold a value. `Form` and `Component` are the two that are
 * deliberately absent: a form is the surface being drawn on, and a component of
 * the project has a tab of its own.
 *
 * **And a type this build cannot run is not offered**, which is a different
 * question from whether it is in the list: `Widget.Available` answers it, and
 * `Terminal` on a runtime built without VTE is the case -- the class is there, a
 * `.form` with one in it loads, and starting a child refuses. A button that
 * places a control the user cannot finish is worse than a missing button, and
 * the only warning used to be a dialog at run time.
 */
const PALETTE_TABS = [
    { name: "Basic",  types: ["Button", "Label", "Image", "Picture", "Separator", "TextBox",
                              "CheckButton", "ToggleButton", "Switch", "LinkButton"] },
    { name: "Data",   types: ["ComboBox", "SpinBox", "DecimalBox", "ListBox", "Slider",
                              "DatePicker", "Calendar", "ColorButton", "FontButton",
                              "ProgressBar", "LevelBar", "Spinner"] },
    { name: "Views",  types: ["TreeView", "TableView", "TextEditor", "SourceEditor",
                              "Terminal", "RowList", "Flow", "DrawingArea", "Video"] },
    { name: "Boxes",  types: ["Panel", "Grid", "Frame", "Expander", "Scroller", "AspectFrame"] },
    { name: "Split",  types: ["Split", "Notebook", "Switcher", "Overlay"] },
];

/*
 * Per type, icon names in order of preference: first the desktop's, which comes
 * in the system's style and follows its theme; last the one the IDE draws in
 * ide/icons, which is always there.
 *
 * The fallback is needed: of the desktop names one would call universal, this
 * machine is missing two ("text-editor-symbolic" and "focus-windows-symbolic")
 * and has two more that resolve but render blank.  An icon that is not there is
 * dropped, which on a button with no text leaves an empty square.
 */
const PALETTE_ICON = {
    Button:   ["input-mouse-symbolic",      "bta-button-symbolic"],
    Label:    ["insert-text-symbolic",      "bta-label-symbolic"],
    Image:    ["insert-image-symbolic",     "bta-image-symbolic"],
    /* A photograph and not an icon, which is the whole difference between the
     * two controls -- so the picture on the button is a picture. */
    Picture:  ["image-x-generic-symbolic",  "bta-image-symbolic"],
    /* One line and not a document: the desktop's `text-editor-symbolic` draws a
     * page being written on, which is the *editor* below and not a field. */
    TextBox:  ["bta-textbox-symbolic"],
    /* One entry, because there is one control: a `CheckButton` is a tick until
     * it is given a `Group` and one of a set afterwards. The tick is what it is
     * when it arrives, so that is the picture on the button. */
    CheckButton: ["checkbox-checked-symbolic", "bta-checkbox-symbolic"],
    /* Three the desktop *does* have a picture for, which is the ordinary case:
     * a spinner is work turning, a link is a link, and an expander is the
     * disclosure triangle every toolkit draws. Checked against both this desktop
     * and Adwaita, since a name only one of them has is an icon that passes CI
     * and comes out blank here (tests/icons.sh). */
    Spinner:     ["content-loading-symbolic", "process-working-symbolic"],
    LinkButton:  ["insert-link-symbolic",     "web-browser-symbolic"],
    Expander:    ["pan-end-symbolic"],
    /* A reading, in blocks: the theme's brightness glyph where there is one, and
     * ours where there is not -- it used to fall back to `view-continuous`, which
     * is the `Scroller`'s, and on this desktop the two came out identical. */
    LevelBar:    ["display-brightness-symbolic", "bta-level-symbolic"],
    ComboBox: ["pan-down-symbolic",         "bta-combobox-symbolic"],
    SpinBox:  ["value-increase-symbolic",   "bta-spinbox-symbolic"],
    /* A field with a point in it, which is what it is: a `SpinBox` that holds a
     * decimal exactly. The calculator is the desktop's picture for a number
     * being worked with; ours is behind it because a name only one theme has is
     * a blank button on the next (tests/icons.sh). */
    DecimalBox: ["accessories-calculator-symbolic", "bta-decimalbox-symbolic"],
    ListBox:  ["view-list-symbolic",        "bta-listbox-symbolic"],
    /*
     * The two date controls, and they must not share a picture: a `DatePicker` is
     * a field and a `Calendar` is the month, which is exactly the difference the
     * user is choosing between. So the month keeps the theme's calendar page --
     * with ours behind it, because this desktop's `x-office-calendar-symbolic` is
     * one of the elementary files that positions its drawing with a `transform`,
     * so it resolves and draws nothing -- and the field is drawn as a field with
     * a page in it.
     */
    DatePicker:  ["bta-datepicker-symbolic"],
    Calendar:    ["x-office-calendar-symbolic", "bta-calendar-symbolic"],
    /*
     * The other two pickers, beside the one that picks a date.  `color-select`
     * and `font-select` are among the ~127 GTK carries inside its own library, so
     * they resolve whatever the theme is -- but a theme that ships its own
     * *wins*, and this desktop's `color-select-symbolic` is a `transform` away
     * from being blank. With nothing behind it that left the palette's colour
     * button empty on the machine this was written on, which is what the drawn
     * fallback is for.
     */
    ColorButton: ["color-select-symbolic", "bta-color-symbolic"],
    FontButton:  ["font-select-symbolic", "font-x-generic-symbolic"],
    /*
     * These four the desktop has no icon for -- the same as Split and Switcher.
     * A toggle is not a switch, a progress bar is not a scroller and a slider is
     * not a speaker, and reaching for the nearest theme name would put a picture
     * of the wrong control on the button.  So they are the IDE's own, and there is
     * no theme name worth trying first.
     */
    ToggleButton: ["bta-toggle-symbolic"],
    ProgressBar:  ["bta-progress-symbolic"],
    Slider:       ["bta-slider-symbolic"],
    Switch:       ["bta-switch-symbolic"],
    /* A rule, and not a list: `view-list-symbolic` was first here and it is the
     * `ListBox`'s, so those two buttons were the same picture. */
    Separator:  ["bta-separator-symbolic"],

    /* --- the views: a window onto something the program has ---------------- */
    /* Neither of the first two names is in Adwaita or on this desktop, so in
     * practice both of these are ours; the theme name stays first for the
     * desktop that does have it. */
    TreeView:   ["view-list-tree-symbolic",  "bta-tree-symbolic"],
    TableView:  ["view-table-symbolic",      "bta-table-symbolic"],
    /*
     * The two editors, and the difference between them is the gutter -- so that
     * is what the two drawings differ by. The desktop's `text-editor-symbolic`
     * is a page being written on, which is the *plain* one: prose. It has no
     * name for a source editor, the same as it has none for a box or a split.
     */
    TextEditor:   ["text-editor-symbolic", "bta-editor-symbolic"],
    SourceEditor: ["bta-source-symbolic"],
    Terminal:   ["utilities-terminal-symbolic"],
    /* Rows holding controls, where a `ListBox` holds strings: the icon says so,
     * and it no longer borrows the list's. */
    RowList:    ["bta-rowlist-symbolic"],
    /* Items of their own size, wrapping -- deliberately not a grid of equal
     * cells, which is what the `Grid` below is. */
    Flow:       ["bta-flow-symbolic"],
    /* The one control whose content is neither text nor rows: a curve on a
     * surface, which is what the handler puts there. The desktop has no name for
     * it -- `applications-graphics-symbolic` is a drawing *application*, and on
     * this desktop it is one of the ones that resolve and draw nothing. */
    DrawingArea: ["bta-drawing-symbolic"],
    /* Motion rather than a moment: a strip of film, which is what the theme
     * draws for anything video. `video-display-symbolic` was first here and
     * lost: it is a *monitor* -- the icon a display-settings panel uses -- so
     * on the palette it read as a screen and not as a clip.
     * `video-x-generic-symbolic` is in Adwaita and on this desktop alike, with
     * ours (a frame with a play triangle) behind it like every other first
     * name here. */
    Video: ["video-x-generic-symbolic", "bta-video-symbolic"],

    /* --- the containers ---------------------------------------------------- */
    /* A box is not a grid: `view-grid-symbolic` was first on both of these and
     * the two came out identical, so the grid keeps it and the panel is ours. */
    Panel:    ["bta-panel-symbolic"],
    Grid:     ["view-grid-symbolic",        "bta-grid-symbolic"],
    Frame:    ["focus-windows-symbolic",    "bta-frame-symbolic"],
    /* The desktop has no idea what a box or a split is: these are the IDE's
     * own, and the only ones for which no theme name is even worth trying. */
    Split:    ["bta-hsplit-symbolic"],
    Notebook: ["view-paged-symbolic",       "bta-notebook-symbolic"],
    /* Neither does it know a switcher from a notebook: the difference is the
     * strip, so the icon is the strip. */
    Switcher: ["bta-switcher-symbolic"],
    /* Layers, offset so both show. `view-paged-symbolic` was first here too,
     * which is the `Notebook`'s -- and a notebook shows one page where an
     * overlay shows all of them at once. */
    Overlay:  ["bta-overlay-symbolic"],
    Scroller: ["view-continuous-symbolic", "bta-panel-symbolic"],
    /* A proportion kept inside the room there is, which is what "fit best" has
     * meant since every image viewer had that button -- and the one drawn here
     * says the same thing with the leftover bands in it. */
    AspectFrame: ["zoom-fit-best-symbolic", "bta-aspect-symbolic"],

    /* Not on the palette, but on the control tree -- which shows whatever the
     * form holds, and a form is not on the palette either. One table for both,
     * so a control looks the same wherever the IDE draws it. */
    Form:       ["window-new-symbolic",      "bta-frame-symbolic"],
};

/* The first one that exists.  The ide/icons ones are in the search path just
 * like the theme's, so asking about all of them works the same way. */
function paletteIcon(type) {
    return (PALETTE_ICON[type] || []).find((name) => Application.HasIcon(name)) || "";
}

/*
 * Asked of the runtime, per type, once -- and it is `PALETTE_TABS` that is
 * filtered rather than each tab's buttons, so a group whose every type is
 * missing loses its tab too rather than showing an empty gallery.
 */
const PALETTE_TABS_HERE = PALETTE_TABS
    .map((tab) => ({ name: tab.name,
                     types: tab.types.filter((t) => Widget.Available(t)) }))
    .filter((tab) => tab.types.length);

const PALETTE = PALETTE_TABS_HERE.flatMap((tab) => tab.types);

/* The project's own components get a tab of their own, after the runtime's. */
const COMPONENT_TAB  = "Project";
const COMPONENT_ICON = ["application-x-addon-symbolic", "bta-component-symbolic"];
const COMPONENT_SIZE = [200, 60];

const PALETTE_BUTTON = 40;      // side of the square button, in pixels

/* A sensible starting size per type, in pixels. */
const DEFAULT_SIZE = {
    Button:   [110, 34],
    Label:    [110, 24],
    Image:    [64, 64],
    /*
     * One pixel tall, because that is what a separator *is*: it paints its whole
     * allocation, so twelve high is a line twelve thick rather than a line with
     * room around it. The room goes on `Margin`.
     *
     * Which does make it a small thing to aim at once it is placed. It is
     * selected the two ways anything hard to hit is: the control tree, and a
     * rubber band over it. Adding one from the palette selects it, so the grid
     * is already pointed at it when it appears.
     */
    Separator: [160, 1],
    TextBox:  [160, 34],
    CheckButton: [140, 28],
    Picture:     [200, 140],
    Spinner:     [32, 32],
    LinkButton:  [140, 30],
    LevelBar:    [160, 20],
    Expander:    [220, 120],
    ComboBox: [140, 34],
    SpinBox:  [90, 34],
    ListBox:  [180, 100],
    /* Wider than a list and about as tall: a table with one column of room is a
     * table nobody can read, and the first thing one does to a narrow one is
     * widen it. */
    TableView: [280, 120],
    ToggleButton: [110, 34],
    /* A switch is the one control with no caption inside it, so the box is the
     * switch itself and not room for words: GTK's own, rounded up. */
    Switch:       [56, 32],
    ProgressBar:  [180, 24],
    Slider:       [180, 30],
    DatePicker:   [130, 34],
    /* A swatch and a specimen, which is the difference between the two: a colour
     * button holds nothing but the colour, so it starts near the 44 wide GTK
     * asks for; a font button writes the font's name *in* the font, and
     * "Cantarell Bold 12" already measures 131. */
    ColorButton:  [64, 34],
    FontButton:   [160, 34],
    Panel:    [160, 120],
    Grid:     [220, 120],
    Frame:    [180, 120],
    Split:    [240, 140],
    Scroller: [200, 140],
    Notebook: [220, 140],
    Switcher: [220, 140],
    Overlay:  [200, 140],
    /* 16:9 of the 220 a container gets here, so what is placed already shows the
     * proportion it exists for rather than a square that happens to be one. */
    AspectFrame: [220, 124],
    Flow:     [220, 140],
    /* A month is as big as a month, and this is the measured size of one rather
     * than a round number: `Width` is a *minimum*, so a calendar asked for 160
     * renders 249 anyway and the `.form` would be saying something untrue. Asking
     * for 250 was untrue in the other direction -- one pixel of slack a fixed
     * surface does not hand out, since it allocates the natural size. `tests/ide`
     * asserts the placed control is drawn at exactly the size asked for, which is
     * what keeps this number honest. */
    Calendar: [249, 222],
    TreeView: [180, 130],
    RowList:  [180, 130],
    /* All three start wide, because all three are read in lines: an editor
     * showing twenty columns and a terminal wrapping every command are the first
     * thing anybody widens. The prose one is a little shorter -- an observations
     * field is three or four lines, where a source file is a screen. */
    /* A surface has no natural size at all -- there is nothing inside it to
     * measure -- so one placed without this would be 0x0 and draw nothing. */
    DrawingArea:  [240, 160],
    TextEditor:   [280, 110],
    SourceEditor: [280, 160],
    Terminal:     [320, 180],
    /* Room for 16:9 footage with a little chrome to spare, like the terminal:
     * a video narrower than this is the first thing anybody widens. */
    Video:        [320, 180],
};

Ide.Palette = class Palette {

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide     = ide;
        this.buttons = {};
        /* What the buttons were built from, so a rebuild only happens when the
         * answer would be different. */
        this.offers  = null;
    }

    get book() { return this.ide.Palette; }

    /*
     * The project's components, as the IDE found them: [{name, ...}].  They are a
     * tab of the palette like any other -- a component exists to be placed, and
     * one that cannot be placed from the palette does not exist as far as the
     * designer is concerned.
     *
     * Called on every switch between forms and on every listing, and answers
     * nothing at all when what it would build is what is already there.
     */
    offer(components) {
        const offers = (components || []).map((c) => c.name).join(",");
        if (this.book.Count && this.offers === offers) return;

        this.build(components || [], offers);
    }

    /* Rebuilt whole rather than patched: the project's tab appears and
     * disappears with the project, and there is nothing in a palette button
     * worth preserving across that. */
    build(components, offers) {
        const book  = this.book;
        const page0 = book.Count ? book.Current : 0;

        book.Clear();
        this.buttons = {};
        this.offers  = offers;

        /*
         * **A tab per library, and one for the project's own.** A library's
         * components in a tab called `Project` would be saying something untrue,
         * and one tab holding both would make "where does this come from" a thing
         * to remember rather than a thing to see. Named after the library, in the
         * order `uses` declared them, after the project's.
         */
        const mine = components.filter((c) => !c.library);
        const libs = [];

        for (const c of components) {
            if (!c.library) continue;
            let tab = libs.find((t) => t.name === c.library);
            if (!tab) libs.push(tab = { name: c.library, types: [] });
            tab.types.push(c.name);
        }

        const tabs = [
            ...PALETTE_TABS_HERE,
            ...(mine.length ? [{ name: COMPONENT_TAB, types: mine.map((c) => c.name) }] : []),
            ...libs,
        ];

        for (const tab of tabs) {
            /* A Flow and not rows of a fixed width: how many buttons go on a
             * line is the panel's business, so widening the side panel fits
             * more across instead of leaving the space empty -- and a tab with
             * a project's worth of components scrolls instead of overflowing. */
            const page = new Flow();
            page.Spacing = 4;
            page.Margin  = 4;
            book.Append(page);

            const label = new Label();
            label.Text = tab.name;
            book.SetTabLabel(book.Count - 1, label);

            /* A library's components wear the component icon too: what they are
             * is a class of somebody's, and the tab already says whose. */
            const component = tab.name === COMPONENT_TAB ||
                              libs.some((t) => t.name === tab.name);
            for (const type of tab.types) page.Add(this.button(type, component));
        }

        book.Current = Math.min(page0, book.Count - 1);
    }

    button(type, component) {
        const button = new Button();

        button.Icon = component
            ? COMPONENT_ICON.find((n) => Application.HasIcon(n)) || ""
            : paletteIcon(type);
        /* With no text, the type's name has to be somewhere. */
        button.Tooltip = type;
        /* This is what makes it draggable, and what travels when dropped. */
        button.DragData = type;
        button.Resize(PALETTE_BUTTON, PALETTE_BUTTON);

        /*
         * The handler belongs to the button, which is what lets the palette be
         * rebuilt -- a library ticked, a tab switched -- without the previous
         * set of them being deleted off the IDE's form by hand.
         *
         * It reads `ide.designer` **when it runs** rather than closing over one:
         * the palette is one widget for every open form, and a button that added
         * a control to a canvas nobody was looking at is what a closure over one
         * designer used to do.
         */
        button.On("Click", () => {
            const designer = this.ide.designer;
            if (!designer) return;      /* no form on screen: nothing to add to */

            designer.tool = type;
            designer.showTool();
            designer.addControl(type);
        });

        this.buttons[type] = button;
        return button;
    }

    /* The active type is marked in the same blue as the selection (`Chrome`'s
     * SELECT_COLOR): it is what Ctrl+Insert will add, and it helps to see which
     * one that is.  Which button is marked is the one thing that changes hands
     * when the designer being shown changes. */
    mark(tool) {
        for (const type in this.buttons) {
            const button = this.buttons[type];
            const on     = type === tool;

            /* Empty gives the theme's colour back, which is the right thing:
             * a grey of our own would look wrong on a dark theme. */
            button.Background = on ? SELECT_COLOR : "";
            button.Foreground = on ? "#ffffff" : "";
        }
    }
};
