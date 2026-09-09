/*
 * The decoration the form will be shown with, drawn over the board.
 *
 * A form is a window, and a window on this desktop is not a bare rectangle: it
 * has a title bar with the form's name on it and the buttons the desktop puts
 * there.  The designer used to say which form it was with a `Label` above the
 * board -- true, and nothing like the thing being designed.
 *
 * **Where the design comes from.** Not from a picture of a title bar shipped with
 * the IDE, which would be one desktop's title bar drawn on every other one, and
 * not from reading the window manager's own theme, which is a different file
 * format per window manager.  It comes from the *style classes GTK itself uses
 * for a window's decoration* -- `titlebar` and `default-decoration` on the bar,
 * `title` on the label -- so the theme paints it exactly as it paints the real
 * thing, and it follows the desktop when the desktop changes.
 *
 * That is the trick behind andreldm's xfwm4-theme-generator, which asks the GTK
 * theme what a title bar looks like and writes the answer out as an xfwm4 theme.
 * It has to render those nodes to PNGs because a window manager cannot run GTK's
 * CSS; the designer is a GTK application already, so it can just wear the classes
 * and let the theme draw.  Measured on a desktop whose window manager was themed
 * that way, the two agree to the pixel: the bar comes out 37 px tall against the
 * 37 px the window manager reports in `_NET_FRAME_EXTENTS`, over the same
 * gradient and closed by the same border colour.
 *
 * Where the buttons go is the other half, and a guess would be wrong on half the
 * desktops there are: `Application.DecorationLayout` is the setting the window
 * manager reads too.
 */
"use strict";

Namespace("Ide");

/*
 * What a decoration layout can name, and the icons each is drawn with, in order
 * of preference -- the same bargain the palette makes: first the desktop's own,
 * which is the button the user will actually click, and last the IDE's, which is
 * always there.  The three desktop names are the ones the generator screenshots,
 * and they are as close to universal as an icon name gets.
 *
 * The fallback is needed, and by a route worth knowing about: GTK rasterises an
 * SVG icon in a worker thread and two icons that draw *text* race in pango, so
 * `Application.HasIcon` refuses those -- and `elementary-xfce` ships two of these
 * three with an editor's text layer left inside (see `bta_icon_available`).
 *
 * The choice is made name by name, as it is everywhere else in the IDE: this
 * desktop draws `window-close-symbolic` and cannot be asked for the other two,
 * and its cross is the one the user will click.  Falling back for all three
 * because one of them is missing would put the IDE's drawing where the desktop
 * had a perfectly good one -- which is the whole thing the order is against.
 * They are drawn to sit beside a stranger for exactly this reason: one span, one
 * weight, nothing of a style of their own.
 */
const DECORATION_BUTTON = {
    minimize: ["window-minimize-symbolic", "bta-window-minimize-symbolic"],
    maximize: ["window-maximize-symbolic", "bta-window-maximize-symbolic"],
    close:    ["window-close-symbolic",    "bta-window-close-symbolic"],
};

/* What is named in a layout and is *not* a button.  `icon` is the window's own,
 * which is a property of the form and worth showing; `menu` is the window menu
 * and `spacer` a gap, and neither says anything about the form being designed --
 * a menu button in a preview only invites a click that does nothing. */
const DECORATION_SKIP = ["menu", "spacer"];

/* What GTK falls back to with no setting at all, which is also what most
 * desktops say. */
const DEFAULT_LAYOUT = "icon:minimize,maximize,close";

/* The window's own icon, which is the one thing on the bar that is not a button
 * and so has no button to take its size from. */
const WINDOW_ICON_SIZE = 16;

/* The side of a window button, which is what GTK gives its own inside a
 * `windowcontrols` node: `min-height: 26px; min-width: 26px`. */
const BUTTON_SIZE = 26;

/*
 * How much the top corners are rounded by.
 *
 * The one number here that a theme cannot be asked for: GTK rounds a window
 * through `window.csd { border-radius: 8px 8px 0 0 }`, which applies to a node
 * named `window` and to nothing a form designer can build, and CSS offers no way
 * to read a computed value back.  8 is what GTK's own decoration uses, what the
 * generator slices its corner images at, and what this desktop's window manager
 * measures out to -- an 8px arc, checked against a real form's window.
 *
 * The bottom two stay square, which is what a window looks like: rounded where
 * it meets the sky, square where it meets its own body.
 */
const DECORATION_RADIUS = "8 8 0 0";

/*
 * And what the window casts on the desk under it, which is the other half of
 * looking like one: `window.csd { box-shadow: 0 3px 9px 1px rgba(0,0,0,0.5) }`,
 * copied here for the same reason the radius is -- the rule is on a node no
 * application can build.  The window manager says the same thing in its own
 * words, and the generator writes it out as `shadow_opacity=50`.
 */
const DECORATION_SHADOW = "0 3 9 1 rgba(0,0,0,0.5)";

Ide.TitleBar = class TitleBar {

    /*
     * One per open form, like the canvas it sits on: what it shows is *this*
     * form's title and icon.  The widget is built here and handed back through
     * `panel` for the board to hold.
     */
    constructor() {
        const bar = new Panel();

        bar.Name        = "TitleBar";
        bar.Arrangement = "Horizontal";
        bar.Spacing     = 6;

        /* The whole of the design: the two classes GTK puts on the title bar it
         * builds for a window that did not ask for one of its own. */
        bar.Style  = "titlebar default-decoration";
        bar.Radius = DECORATION_RADIUS;

        /* The board is a column and a child of a box keeps to itself unless it is
         * told otherwise -- and a title bar narrower than its window is not a
         * title bar. */
        bar.HAlign = "Fill";

        this.panel   = bar;
        this.icon    = null;    // the window icon, when the layout asks for one
        this.title   = null;
        this.buttons = [];      // the ones the layout named, in the order it did

        const [start, end] = TitleBar.layout();

        for (const item of start) this.add(item);

        /*
         * The title takes what the buttons leave, and ellipsizes rather than
         * wraps: a window title is one line, and a label that asked for the
         * natural width of its text would push the bar wider than the form it is
         * the title of.
         */
        const title = new Label();
        title.Name      = "LblForm";
        title.Style     = "title";
        title.Alignment = "Center";
        title.Ellipsize = true;
        title.Expand    = true;
        bar.Add(title);
        this.title = title;

        for (const item of end) this.add(item);
    }

    /*
     * The rest of the decoration, which is not the bar's but the *window's*: it
     * is the whole of the board -- title bar and canvas together -- that has a
     * shape and casts a shadow, so it is the board that is told.
     *
     * Here rather than in the board's own file because it is one decoration: the
     * corners of the shadow have to be the corners of the bar, and two places
     * that each knew half of that would drift apart.
     */
    decorate(board) {
        board.Radius = DECORATION_RADIUS;
        board.Shadow = DECORATION_SHADOW;
    }

    /*
     * The desktop's layout, as two lists: what goes before the title and what
     * goes after it.  A layout with no colon in it is all one side, which is what
     * the setting means.
     */
    static layout() {
        const raw   = Application.DecorationLayout || DEFAULT_LAYOUT;
        const sides = raw.split(":");
        const items = (s) => (s || "").split(",")
                                      .map((name) => name.trim())
                                      .filter((name) => name &&
                                                        !DECORATION_SKIP.includes(name));

        return [items(sides[0]), items(sides[1])];
    }

    /* One element of the layout, or nothing when it is a name we draw no picture
     * for -- a layout is free to name anything, and an unknown word is not an
     * error, it is a part of the decoration this preview does not draw. */
    add(name) {
        if (name === "icon") {
            const icon = new Image();
            icon.Size    = WINDOW_ICON_SIZE;
            icon.Visible = false;   // until the form says it has one
            this.panel.Add(icon);
            this.icon = icon;
            return;
        }

        const names = DECORATION_BUTTON[name];
        if (!names) return;

        this.buttons.push(name);

        /*
         * A window button is a button, so it is one here: the theme rounds it,
         * lights it under the pointer and presses it, which is what tells a
         * person looking at the board that this is a window and not a drawing of
         * one.  `flat` is what a title bar's buttons wear -- GTK's own live in a
         * `windowcontrols` node no application can build, and every theme that
         * styles them styles `.flat` and `.titlebutton` the same way.
         *
         * The size is GTK's own, and so is the way of getting it: a title button
         * is `padding: 0` and 26 square inside `windowcontrols`, a node no
         * application can build.  Said here instead, or the button's ordinary
         * padding (4px, plus a 26px floor of its own) makes the bar 43px tall
         * against the 37 the desktop draws.
         */
        const button = new Button();

        /* The first one that draws: the desktop's, and the IDE's only where the
         * desktop has none -- which is what `paletteIcon` does for every other
         * icon the IDE shows. */
        button.Icon      = names.find((icon) => Application.HasIcon(icon)) || "";
        button.Style     = `flat titlebutton ${name}`;
        button.Padding   = 0;
        button.Width     = BUTTON_SIZE;
        button.Height    = BUTTON_SIZE;
        /* Round, like GTK's own: `windowcontrols button > image` is a circle,
         * and what a person sees of that is the highlight under the pointer. */
        button.Radius    = BUTTON_SIZE / 2;
        button.VAlign    = "Center";
        button.Focusable = false;   /* chrome: Tab belongs to the form's controls */
        this.panel.Add(button);
    }

    /*
     * What the window will be called: the form's `Text` if it has one, its class
     * otherwise -- the order a window title follows, and the class is what a form
     * with no caption is known by.
     */
    set Text(text) { this.title.Text = text; }
    get Text()     { return this.title.Text; }

    /* The window's icon, from the form's own `Icon` property.  A name the theme
     * does not have is dropped by the runtime and would leave a hole in the bar,
     * so it is asked about first. */
    set Icon(name) {
        if (!this.icon) return;
        const has = !!name && Application.HasIcon(name);

        this.icon.Icon    = has ? name : "";
        this.icon.Visible = has;
    }
    get Icon() { return this.icon ? this.icon.Icon : ""; }

    /* A component is not a window: it has no title bar to preview, which is the
     * same reason the property grid offers it no `Text`. */
    set Visible(on) { this.panel.Visible = on; }
    get Visible()   { return this.panel.Visible; }
};
