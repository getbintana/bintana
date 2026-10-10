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

/* What the button beside the filter offers: the tree's own menu and the way
 * to drop the filter. Commands only, for the reason above. */
const TREE_OPTIONS = [
    { action: "ActTrExpand" },
    { action: "ActTrCollapse" },
    { separator: true },
    { action: "ActTrClearFilter" },
    { separator: true },
    { action: "ActTrRename" },
    { action: "ActDelCtl" },
    { action: "ActRaise" },
    { action: "ActLower" },
];

/* What the columns start at with no remembered width; see Session.divider. */
const CONTROLS_W = 280;
const CENTER_W   = 520;
const OUTLINE_W  = 260;     /* the editor's outline: the editor takes the rest */
const PALETTE_H  = 200;     /* the palette (two rows) and its title */

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
        this.treeFind    = null;
        this.treeOptions = null;
        this.barButtons  = [];
        this.btnDelCtl   = null;
        this.btnRaise    = null;
        this.btnLower    = null;
        this.sideTabs    = null;
        this.propTitle   = null;
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
        this.paletteBook.VExpand = true;
        this.sideSplit.Add(this.titled(Locale.Text("Toolbox"), this.paletteBook));

        this.widgetTree = new TreeView();
        this.widgetTree.Name    = "WidgetTree";
        this.widgetTree.Expand  = true;
        this.widgetTree.HExpand = true;
        this.widgetTree.VExpand = true;
        /* A filter over it, which is the property grid's bargain: typed here,
         * applied by `ControlTree` for whichever form is showing. */
        this.treeFind = new TextBox();
        this.treeFind.Name        = "TreeFind";
        this.treeFind.HExpand     = true;
        this.treeFind.Margin      = 4;
        this.treeFind.Icon        = "edit-find-symbolic";
        this.treeFind.Placeholder = Locale.Text("Filter controls");
        this.treeFind.Tooltip     = Locale.Text("Show only the controls whose name or type contains this");


        /* ...and the menu of what can be done to the tree. Built here and given
         * its `Menu` in `bind`, once the page is in the window. */
        this.treeOptions = new Button();
        this.treeOptions.Name    = "TreeOptions";
        this.treeOptions.Tooltip = Locale.Text("Tree options");
        this.treeOptions.Icon    = TAB_ACTION_ICON.find((n) => Application.HasIcon(n)) || "";
        if (!this.treeOptions.Icon) this.treeOptions.Text = "\u22ef";
        this.treeOptions.On("Click", () => this.treeOptions.PopupMenu(0, 0));

        const findRow = new Panel();
        findRow.Arrangement = "Horizontal";
        findRow.HAlign      = "Fill";
        findRow.Style       = "linked";     /* one control: entry and button joined */
        this.treeFind.Margin = 0;
        findRow.Margin       = 4;
        findRow.Add(this.treeFind);
        findRow.Add(this.treeOptions);

        this.sideSplit.Add(this.titled(Locale.Text("Structure"), this.widgetTree,
                                       findRow));

        this.controlsBox.Add(this.sideSplit);
        this.controlsBox.Add(this.buildBar());

        this.page.Add(this.controlsBox);
        this.page.Add(this.centerSplit);

        this.buildProperties();

        this.page.Position        = this.ide.session.divider("PageSplit",   CONTROLS_W);
        this.centerSplit.Position = this.ide.session.divider("CenterSplit", CENTER_W);
        /* The panel keeps its room and the canvas takes the rest: see Session. */
        this.ide.session.settle(this.centerSplit, "CenterSplit");
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

        /* `Position` is the editor's width, since the first half is the editor,
         * so the outline's is what is left of the room the tabs have. */
        const room  = this.ide.Tabs.Bounds().Width || (this.ide.Bounds().Width - CONTROLS_W);
        this.page.Position = this.ide.session.divider("EditSplit",
                                                      Math.max(300, room - OUTLINE_W));

        /* The outline keeps its width and the editor takes the rest -- and
         * with no choice made yet, the width it is declared at: see Session. */
        this.ide.session.settle(this.page, "EditSplit", OUTLINE_W);
    }

    /* A panel's title above its content, so each side panel says what it is
     * the way the outline does. `text` arrives already through `Locale.Text`:
     * the literal has to be at the call site for the extractor to find it. */
    titled(text, content, under) {
        const box = new Panel();
        box.Arrangement = "Vertical";
        box.HExpand     = true;
        box.VExpand     = true;

        const head = new Label();
        head.HAlign = "Start";
        head.Margin = 4;
        head.Style  = "heading";
        head.Text   = text;
        box.Add(head);
        if (under) box.Add(under);      /* between the title and what it titles */
        box.Add(content);
        return box;
    }

    /* The buttons under the control tree, pointing at the IDE's own commands:
     * one assignment decides whether they are available. The last three walk
     * the pages of the page container the selection is in. They lived in a
     * bar drawn under that container on the canvas, which covered the form
     * whenever the container reached its bottom edge -- here they cover
     * nothing. */
    buildBar() {
        const bar = new Panel();
        bar.Name        = "DesignBar";
        bar.Arrangement = "Horizontal";
        bar.Height      = 36;
        bar.Margin      = 2;
        bar.Spacing     = 4;
        bar.Style       = "toolbar";

        for (const row of [
                ["ActDelCtl", "edit-delete-symbolic", Locale.Text("Delete control")],
                ["ActRaise",  "go-up-symbolic",       Locale.Text("Bring to front")],
                ["ActLower",  "go-down-symbolic",     Locale.Text("Send to back")],
                null,
                ["ActPrevPage", "go-previous-symbolic", Locale.Text("Previous page (Ctrl+Page Up)")],
                ["ActNextPage", "go-next-symbolic",     Locale.Text("Next page (Ctrl+Page Down)")],
                ["ActAddPage",  "list-add-symbolic",    Locale.Text("Add page")]]) {
            if (!row) {
                const sep = new Separator();
                sep.Orientation = "Vertical";
                bar.Add(sep);
                continue;
            }
            const [action, icon, tip] = row;
            const b = new Button();
            b.Icon    = icon;
            b.Tooltip = tip;
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

        /* What the two pages below speak about; `PropertyGrid.fill` writes it. */
        this.propTitle = new Label();
        this.propTitle.Name   = "PropTitle";
        this.propTitle.HAlign = "Start";
        this.propTitle.Margin = 4;
        this.propTitle.Style  = "heading";
        this.propTitle.Text   = Locale.Text("Inspector");
        this.sidePanel.Add(this.propTitle);

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
        caption.Style   = "heading";
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

        this.widgetTree.Menu    = TREE_MENU;
        this.treeOptions.Menu   = TREE_OPTIONS;
        for (const [button, action] of this.barButtons) button.Action = action;
    }
};
