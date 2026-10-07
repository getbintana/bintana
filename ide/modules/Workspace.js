/*
 * The work area of one open file: what sits below the tab strip.
 *
 * **One per tab, and it is the strip that made it so.** A notebook puts its
 * pages under its own strip, so a palette or a property panel shared between
 * tabs cannot be under it: it stands beside the whole notebook, at full
 * height, and the strip stops where the editor's edge does -- which reads as
 * the panels belonging to nothing in particular. The two panels and the canvas
 * are one workspace, and a workspace is what a tab holds.
 *
 * It costs what it looks like it costs, and that was measured with Sysprof
 * before the choice was made: the whole workspace is ~7 ms with an empty
 * palette, the palette -- forty-odd buttons and their icons -- is most of it
 * at ~14 ms in the IDE, against the 44-211 ms a form tab already costs to
 * open (the canvas, the designer, and the form built for real). A person
 * cannot feel that, which is why the palette is built here too instead of
 * being the one piece moved between pages.
 *
 * The widgets are **built here and not declared in `MainForm.form`**, because
 * a `.form` is loaded once and these exist once per tab. The names are the
 * same on every page -- `WidgetTree`, `PropGrid`, `SideTabs` -- and events
 * dispatch by name with only the page on screen raising any, exactly as the
 * per-tab canvases already did; `TabSet.placeContent` repoints
 * `ide.<name>` at the active one.
 */
"use strict";

Namespace("Ide");

/*
 * The control tree's context menu.
 *
 * **Every entry points at a command and so carries no name.** A named item is
 * published on the form, and there is now one tree per form tab: the second
 * tree's `MnuTrRename` would be a second menu taking the first one's name,
 * which the runtime refuses now -- and rightly, because the first went dead
 * when it was allowed. The commands act on whichever tree is showing.
 *
 * This is the same reason the canvas menu is commands only (`CANVAS_MENU` in
 * TabSet.js), arrived at from the other side: there, one menu assigned to many
 * canvases; here, one tree per canvas.
 */
const TREE_MENU = [
    { action: "ActTrRename" },
    { action: "ActDelCtl" },
    { separator: true },
    { action: "ActRaise" },
    { action: "ActLower" },
    { separator: true },
    { action: "ActTrExpand" },
    { action: "ActTrCollapse" },
];

/* What the columns start at with no remembered width; see Session.divider. */
const CONTROLS_W = 280;
const CENTER_W   = 520;
const SIDE_W     = 520;     /* the editor's outline, same idea */
const PALETTE_H  = 140;

Ide.Workspace = class Workspace {

    /**
     * @param {MainForm} ide
     * @param {boolean}  design   a `.form` page rather than an editor
     */
    constructor(ide, design) {
        this.ide    = ide;
        this.design = design;

        /* Null on the half a page does not have, so every reader is answered
         * either way and `placeContent` can repoint without asking why. */
        this.controlsBox = null;
        this.centerSplit = null;
        this.sideSplit   = null;
        this.paletteBook = null;
        this.widgetTree  = null;
        this.barButtons  = [];
        this.btnDelCtl   = null;
        this.btnRaise    = null;
        this.btnLower    = null;
        this.sideTabs    = null;
        this.propBox     = null;
        this.propDesign  = null;
        this.propFind    = null;
        this.propGrid    = null;
        this.eventsBox   = null;
        this.eventList   = null;
        this.outlineBox  = null;
        this.outlineList = null;

        /* The room the canvas or the editor is given. A box, and empty: what
         * goes in it is the tab's business (a canvas, an editor, or a
         * document's bar and preview). */
        this.main = new Panel();
        this.main.Name        = "MainBox";
        this.main.Arrangement = "Vertical";
        this.main.HExpand     = true;
        this.main.VExpand     = true;

        this.sidePanel = new Panel();
        this.sidePanel.Name        = "SidePanel";
        this.sidePanel.Arrangement = "Vertical";
        this.sidePanel.Spacing     = 2;

        this.page = new Split();

        if (design) this.buildDesign();
        else        this.buildEditor();
    }

    /*
     * A form: the palette and the control tree on the left, the canvas and the
     * properties/events panel to the right. Two splits, because a `Split` is
     * two halves -- the left column and the centre, then the canvas and the
     * panel.
     */
    buildDesign() {
        this.page.Name  = "PageSplit";
        this.page.Grows = "End";        /* the centre takes the new room */

        this.centerSplit = new Split();
        this.centerSplit.Name  = "CenterSplit";
        this.centerSplit.Grows = "Start";   /* the canvas grows, the panel does not */
        this.centerSplit.Add(this.main);
        this.centerSplit.Add(this.sidePanel);

        this.controlsBox = new Panel();
        this.controlsBox.Name        = "ControlsBox";
        this.controlsBox.Arrangement = "Vertical";
        this.controlsBox.Spacing     = 2;

        this.sideSplit = new Split();
        this.sideSplit.Name        = "SideSplit";
        this.sideSplit.Arrangement = "Vertical";
        this.sideSplit.Grows       = "End";   /* the tree grows, the palette does not */

        this.paletteBook = new Notebook();
        this.paletteBook.Name    = "Palette";
        this.paletteBook.HExpand = true;
        this.sideSplit.Add(this.paletteBook);

        this.widgetTree = new TreeView();
        this.widgetTree.Name    = "WidgetTree";
        this.widgetTree.Expand  = true;
        this.widgetTree.HExpand = true;
        this.widgetTree.VExpand = true;
        this.sideSplit.Add(this.widgetTree);

        this.controlsBox.Add(this.sideSplit);
        this.controlsBox.Add(this.buildBar());

        this.page.Add(this.controlsBox);
        this.page.Add(this.centerSplit);

        this.buildProperties();

        this.page.Position        = this.ide.session.divider("PageSplit",   CONTROLS_W);
        this.centerSplit.Position = this.ide.session.divider("CenterSplit", CENTER_W);
        this.sideSplit.Position   = this.ide.session.divider("SideSplit",   PALETTE_H);
    }

    /*
     * A code tab: the editor and the outline. No palette and no property
     * panel: what those speak about is a selection, and a file has none.
     */
    buildEditor() {
        this.page.Name  = "EditSplit";
        this.page.Grows = "Start";      /* the editor grows, the outline does not */

        this.page.Add(this.main);
        this.page.Add(this.sidePanel);

        this.buildOutline();

        this.page.Position = this.ide.session.divider("EditSplit", SIDE_W);
    }

    /* The three buttons under the control tree, pointing at the IDE's own
     * commands: one assignment decides whether they are available. */
    buildBar() {
        const bar = new Panel();
        bar.Name        = "DesignBar";
        bar.Arrangement = "Horizontal";
        bar.Height      = 36;
        bar.Margin      = 2;
        bar.Spacing     = 4;
        bar.Style       = "toolbar";

        for (const [action, icon, tip] of [
                ["ActDelCtl", "edit-delete-symbolic", "Delete control"],
                ["ActRaise",  "go-up-symbolic",       "Bring to front"],
                ["ActLower",  "go-down-symbolic",     "Send to back"]]) {
            const b = new Button();
            b.Icon    = icon;
            b.Tooltip = Locale.Text(tip);
            b.Style   = "flat";
            b.Resize(34, 30);
            bar.Add(b);
            this.barButtons.push([b, action]);
        }
        this.btnDelCtl = this.barButtons[0][0];
        this.btnRaise  = this.barButtons[1][0];
        this.btnLower  = this.barButtons[2][0];
        return bar;
    }

    /* The right column of a form: what the selection *is* and what it *does*,
     * which is Delphi's Object Inspector and Lazarus's, and the order they put
     * them in. */
    buildProperties() {
        this.sideTabs = new Switcher();
        this.sideTabs.Name    = "SideTabs";
        this.sideTabs.Expand  = true;
        this.sideTabs.HExpand = true;
        this.sideTabs.VExpand = true;

        this.propBox = new Panel();
        this.propBox.Name        = "PropBox";
        this.propBox.Arrangement = "Vertical";
        this.propBox.Spacing     = 2;

        const row = new Panel();
        row.Name        = "PropDesignRow";
        row.Arrangement = "Horizontal";
        row.Margin      = 4;
        row.Spacing     = 6;

        const caption = new Label();
        caption.Name    = "PropDesignLabel";
        caption.HExpand = true;
        caption.Text    = Locale.Text("Design values");
        caption.Tooltip = Locale.Text("Edit what the designer shows instead of what the application will run with");
        row.Add(caption);

        this.propDesign = new Switch();
        this.propDesign.Name    = "PropDesign";
        this.propDesign.VAlign  = "Center";
        this.propDesign.Tooltip = caption.Tooltip;
        row.Add(this.propDesign);
        this.propBox.Add(row);

        /* A view setting and not an edit: one looks for `Margin` and then
         * walks the form with it still typed. */
        this.propFind = new TextBox();
        this.propFind.Name        = "PropFind";
        this.propFind.HExpand     = true;
        this.propFind.Margin      = 4;
        this.propFind.Icon        = "edit-find-symbolic";
        this.propFind.Placeholder = Locale.Text("Filter properties");
        this.propFind.Tooltip     = Locale.Text("Show only the properties whose name contains this");
        this.propBox.Add(this.propFind);

        this.propGrid = new RowList();
        this.propGrid.Name    = "PropGrid";
        this.propGrid.Expand  = true;
        this.propGrid.HExpand = true;
        this.propGrid.VExpand = true;
        this.propBox.Add(this.propGrid);

        this.eventsBox = new Panel();
        this.eventsBox.Name        = "EventsBox";
        this.eventsBox.Arrangement = "Vertical";
        this.eventsBox.Spacing     = 2;

        this.eventList = new RowList();
        this.eventList.Name    = "EventList";
        this.eventList.Expand  = true;
        this.eventList.HExpand = true;
        this.eventList.VExpand = true;
        this.eventList.Tooltip = Locale.Text("Double click an event to write its handler, or to go to it");
        this.eventsBox.Add(this.eventList);

        this.sideTabs.Append(this.propBox,   Locale.Text("Properties"));
        this.sideTabs.Append(this.eventsBox, Locale.Text("Events"));
        this.sidePanel.Add(this.sideTabs);
    }

    /* The other half of the right column, on the tabs where there is no
     * selection to speak about: what is in the file on screen. */
    buildOutline() {
        this.outlineBox = new Panel();
        this.outlineBox.Name        = "OutlineBox";
        this.outlineBox.Arrangement = "Vertical";
        this.outlineBox.Expand      = true;
        this.outlineBox.HExpand     = true;
        this.outlineBox.VExpand     = true;

        const caption = new Label();
        caption.Name    = "LblOutline";
        caption.HAlign  = "Start";
        caption.Margin  = 4;
        caption.Style   = "caption-heading";
        caption.Text    = Locale.Text("Outline");
        this.outlineBox.Add(caption);

        this.outlineList = new ListBox();
        this.outlineList.Name    = "OutlineList";
        this.outlineList.Expand  = true;
        this.outlineList.HAlign  = "Fill";
        this.outlineList.HExpand = true;
        this.outlineList.VAlign  = "Fill";
        this.outlineList.VExpand = true;
        this.outlineBox.Add(this.outlineList);

        this.sidePanel.Add(this.outlineBox);
    }

    /*
     * Called once the page is in the window, and **not from the constructor**:
     * a `Menu` names handlers and an `Action` names a command on the *form*,
     * and a widget that has been added to nothing has none -- both refuse.
     * `TabSet.open` appends the page and calls this immediately after.
     */
    bind() {
        if (!this.design) return;

        this.widgetTree.Menu = TREE_MENU;
        for (const [button, action] of this.barButtons) button.Action = action;
    }
};
