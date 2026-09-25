/*
 * A widget factory: every control this runtime has, shown in the
 * configurations it is actually used in, on a page per family.
 *
 * The model is GTK's own `gtk4-widget-factory`, which is a `GtkStackSwitcher`
 * over a few dense pages -- a theme developer scrolls one page and sees the
 * buttons, the entries, the lists, each in several states.  This is that, with
 * a tab per family instead of three arbitrary pages: a `Switcher` at the top
 * and a `Flow` per tab, which wraps the samples into as many columns as the
 * window fits.
 *
 * ## A sample is a caption over a control
 *
 * `TABS` below is the whole of the content: a caption, the class it is a
 * sample of, and a function that builds it.  The caption is what the sample
 * *is* -- `suggested action`, `vertical`, `discrete`, `editable cells` -- so a
 * page reads as a list of the answers a control has, and not as a gallery of
 * unnamed pictures.
 *
 * The class name in the middle is not decoration: the tabs are a hand-kept
 * table, and the page for `Other` at the end is built from whatever
 * `Widget.Types()` offers that no sample named.  A control added to the
 * runtime shows up there the day it exists, so the table being behind is
 * visible instead of a missing control.
 *
 * ## What is deliberately not here
 *
 * No property grid and no list of events: that is `gtk4-demo`'s shape, and the
 * runtime already publishes it where an editor reads it -- the IDE's property
 * grid and its help.  What this window is for is the other question, *what does
 * this control look like*, which no list answers.
 *
 * Style classes are a third vocabulary and this window does not pretend to list
 * them: which ones exist is the **theme's** answer, and `tests/styles.sh` is
 * the tool that reads it off the desktop.
 *
 * Run it with `./build/bintana examples/factory`.
 */
"use strict";

/* The classes that are not a control one can place: three roots of the
 * hierarchy, the base both editors share, and the two window classes. */
const NOT_OFFERED = ["Widget", "Container", "Control", "Editor", "Form", "Component"];

/* A row of cells for the layouts that want several. */
function cells(n) {
    const box = new Panel();
    box.Arrangement = "Horizontal";
    box.Spacing = 8;
    for (let i = 1; i <= n; i++) {
        const l = new Label();
        l.Text = `${i}`;
        l.Alignment = "Center";
        l.Style = "frame";
        l.Width = 40;
        l.Height = 30;
        box.Add(l);
    }
    return box;
}

/* A page for a `Notebook` or a `Switcher`: a `Panel` holding one label. */
function page(n) {
    const p = new Panel();
    p.Arrangement = "Horizontal";
    const l = new Label();
    l.Text = Locale.Text("Page {0}", n);
    l.Alignment = "Center";
    l.HAlign = "Fill";
    l.VAlign = "Center";
    l.HExpand = true;
    l.VExpand = true;
    p.Add(l);
    return p;
}

/* A row of a `RowList`: a caption on the left, a control on the right. */
function setting(text, control) {
    const row = new Panel();
    row.Arrangement = "Horizontal";
    row.Spacing = 12;
    row.Margin = 6;

    const l = new Label();
    l.Text = text;
    l.HAlign = "Fill";
    l.HExpand = true;
    l.VAlign = "Center";
    row.Add(l);

    control.VAlign = "Center";
    row.Add(control);
    return row;
}

/* The picture the project ships, for the two controls that take a file. */
function sampleFile() {
    return File.Join(Application.Directory, "sample.png");
}

/*
 * The tabs, in order.  Each is `[caption, class, build]`: the caption says
 * which configuration it is, the class is what the sample covers, and the
 * function returns the control.
 */
const TABS = [

    [Locale.Text("Buttons"), [

        [Locale.Text("a plain button"), "Button", () => {
            const b = new Button();
            b.Text = Locale.Text("Press me");
            return b;
        }],

        [Locale.Text("with an icon"), "Button", () => {
            const b = new Button();
            b.Text = Locale.Text("New");
            b.Icon = "list-add-symbolic";
            return b;
        }],

        [Locale.Text("an icon alone"), "Button", () => {
            const b = new Button();
            b.Icon = "edit-find-symbolic";
            return b;
        }],

        [Locale.Text("suggested action"), "Button", () => {
            const b = new Button();
            b.Text = Locale.Text("Save");
            b.Style = "suggested-action";
            return b;
        }],

        [Locale.Text("destructive action"), "Button", () => {
            const b = new Button();
            b.Text = Locale.Text("Delete");
            b.Style = "destructive-action";
            return b;
        }],

        [Locale.Text("flat"), "Button", () => {
            const b = new Button();
            b.Icon = "view-more-symbolic";
            b.Style = "flat";
            return b;
        }],

        [Locale.Text("circular"), "Button", () => {
            const b = new Button();
            b.Icon = "list-add-symbolic";
            b.Style = "circular";
            return b;
        }],

        [Locale.Text("disabled"), "Button", () => {
            const b = new Button();
            b.Text = Locale.Text("Not now");
            b.Enabled = false;
            return b;
        }],

        [Locale.Text("a toggle"), "ToggleButton", () => {
            const b = new ToggleButton();
            b.Text = Locale.Text("Bold");
            return b;
        }],

        [Locale.Text("a toggle, on"), "ToggleButton", () => {
            const b = new ToggleButton();
            b.Text = Locale.Text("Bold");
            b.Active = true;
            return b;
        }],

        [Locale.Text("a check"), "CheckButton", () => {
            const c = new CheckButton();
            c.Text = Locale.Text("Check me");
            return c;
        }],

        [Locale.Text("a check, on"), "CheckButton", () => {
            const c = new CheckButton();
            c.Text = Locale.Text("Checked");
            c.Active = true;
            return c;
        }],

        [Locale.Text("radios"), "Panel", () => {
            const box = new Panel();
            box.Arrangement = "Vertical";
            box.Spacing = 4;
            const names = [Locale.Text("Left"), Locale.Text("Center"), Locale.Text("Right")];
            for (let i = 0; i < names.length; i++) {
                const r = new CheckButton();
                r.Text = names[i];
                r.Group = "factory-align";
                if (i === 1) r.Active = true;
                box.Add(r);
            }
            return box;
        }],

        [Locale.Text("a switch"), "Switch", () => new Switch()],

        [Locale.Text("a switch, on"), "Switch", () => {
            const s = new Switch();
            s.Active = true;
            return s;
        }],

        [Locale.Text("a link"), "LinkButton", () => {
            const l = new LinkButton();
            l.Text = Locale.Text("bintana on GitHub");
            l.Uri = "https://github.com/getbintana/bintana";
            return l;
        }],

    ]],

    [Locale.Text("Text"), [

        [Locale.Text("a label"), "Label", () => {
            const l = new Label();
            l.Text = Locale.Text("Words a click cannot change");
            return l;
        }],

        [Locale.Text("bold and italic"), "Label", () => {
            const l = new Label();
            l.Markup = true;
            l.Text = "<b>bold</b>, <i>italic</i> and <tt>monospace</tt>";
            return l;
        }],

        [Locale.Text("wrapped"), "Label", () => {
            const l = new Label();
            l.Wrap = true;
            l.Width = 240;
            l.Text = Locale.Text("A sentence that wraps because it was given a width to wrap at.");
            return l;
        }],

        [Locale.Text("selectable"), "Label", () => {
            const l = new Label();
            l.Selectable = true;
            l.Text = "~/Documents/notes/today.txt";
            return l;
        }],

        [Locale.Text("an entry"), "TextBox", () => {
            const t = new TextBox();
            t.Placeholder = Locale.Text("Type here");
            t.Width = 240;
            return t;
        }],

        [Locale.Text("with an icon"), "TextBox", () => {
            const t = new TextBox();
            t.Text = Locale.Text("find me");
            t.Icon = "edit-find-symbolic";
            t.Width = 240;
            return t;
        }],

        [Locale.Text("a password"), "TextBox", () => {
            const t = new TextBox();
            t.Text = "hunter2";
            t.Password = true;
            t.Width = 240;
            return t;
        }],

        [Locale.Text("read-only"), "TextBox", () => {
            const t = new TextBox();
            t.Text = Locale.Text("a value the program owns");
            t.ReadOnly = true;
            t.Width = 240;
            return t;
        }],

        [Locale.Text("digits only"), "TextBox", () => {
            const t = new TextBox();
            t.Text = "12345";
            t.Purpose = "Digits";
            t.Width = 120;
            return t;
        }],

        [Locale.Text("right aligned"), "TextBox", () => {
            const t = new TextBox();
            t.Text = "1,240.00";
            t.Alignment = "Right";
            t.Width = 140;
            return t;
        }],

        [Locale.Text("a text editor"), "TextEditor", () => {
            const e = new TextEditor();
            e.Width = 340;
            e.Height = 120;
            e.Text = Locale.Text("Prose, wrapped, not monospaced: a note, a log, observations.");
            return e;
        }],

        [Locale.Text("source, highlighted"), "SourceEditor", () => {
            const e = new SourceEditor();
            e.Width = 340;
            e.Height = 140;
            e.Language = "js";
            e.Text = "const answer = 42;\n\nfunction twice(n) {\n    return n * 2;\n}\n";
            return e;
        }],

        [Locale.Text("a terminal"), "Terminal", () => {
            const t = new Terminal();
            t.Width = 340;
            t.Height = 140;
            t.Feed(Locale.Text("Nothing is running: press Run and a shell starts here.\n"));
            return t;
        }],

    ]],

    [Locale.Text("Values"), [

        [Locale.Text("a slider"), "Slider", () => {
            const s = new Slider();
            s.Min = 0;
            s.Max = 100;
            s.Value = 60;
            s.Width = 240;
            return s;
        }],

        [Locale.Text("with its value"), "Slider", () => {
            const s = new Slider();
            s.Value = 30;
            s.ShowValue = true;
            s.Width = 240;
            return s;
        }],

        [Locale.Text("with marks"), "Slider", () => {
            const s = new Slider();
            s.Min = 0;
            s.Max = 100;
            s.Value = 50;
            s.Width = 240;
            s.Mark(0,   Locale.Text("cold"));
            s.Mark(50,  Locale.Text("warm"));
            s.Mark(100, Locale.Text("hot"));
            return s;
        }],

        [Locale.Text("vertical"), "Slider", () => {
            const s = new Slider();
            s.Orientation = "Vertical";
            s.Value = 70;
            s.Height = 140;
            return s;
        }],

        [Locale.Text("a spin"), "SpinBox", () => {
            const s = new SpinBox();
            s.Min = -10;
            s.Max = 10;
            s.Value = 3;
            return s;
        }],

        [Locale.Text("a decimal"), "DecimalBox", () => {
            const d = new DecimalBox();
            d.Value = 74.25;
            return d;
        }],

        [Locale.Text("as currency"), "DecimalBox", () => {
            const d = new DecimalBox();
            d.Format = "Currency";
            d.Value = 1240.5;
            return d;
        }],

        [Locale.Text("a progress bar"), "ProgressBar", () => {
            const p = new ProgressBar();
            p.Value = 42;
            p.Width = 240;
            return p;
        }],

        [Locale.Text("with text"), "ProgressBar", () => {
            const p = new ProgressBar();
            p.ShowText = true;
            p.Value = 42;
            p.Text = "42%";
            p.Width = 240;
            return p;
        }],

        [Locale.Text("a level bar"), "LevelBar", () => {
            const b = new LevelBar();
            b.Value = 0.62;
            b.Width = 240;
            return b;
        }],

        [Locale.Text("discrete"), "LevelBar", () => {
            const b = new LevelBar();
            b.Mode = "Discrete";
            b.Max = 5;
            b.Value = 3;
            b.Width = 240;
            return b;
        }],

        [Locale.Text("a spinner"), "Spinner", () => {
            const s = new Spinner();
            s.Active = true;
            return s;
        }],

        [Locale.Text("a date"), "DatePicker", () => {
            const d = new DatePicker();
            d.Value = Day.Today;
            return d;
        }],

        [Locale.Text("no date at all"), "DatePicker", () => {
            const d = new DatePicker();
            d.Value = "";
            return d;
        }],

        [Locale.Text("a calendar"), "Calendar", () => {
            const c = new Calendar();
            c.Mark(Day.Today);
            return c;
        }],

        [Locale.Text("a colour"), "ColorButton", () => {
            const c = new ColorButton();
            c.Value = "#3584e4";
            return c;
        }],

        [Locale.Text("a font"), "FontButton", () => new FontButton()],

    ]],

    [Locale.Text("Lists"), [

        [Locale.Text("a list box"), "ListBox", () => {
            const l = new ListBox();
            l.Width = 200;
            l.Items = [Locale.Text("First"), Locale.Text("Second"), Locale.Text("Third")];
            l.Index = 1;
            return l;
        }],

        [Locale.Text("multiple selection"), "ListBox", () => {
            const l = new ListBox();
            l.Width = 200;
            l.MultiSelect = true;
            l.Items = [Locale.Text("One"), Locale.Text("Two"), Locale.Text("Three")];
            l.Select(0);
            l.Select(2);
            return l;
        }],

        [Locale.Text("a drop-down"), "ComboBox", () => {
            const c = new ComboBox();
            c.Items = [Locale.Text("Low"), Locale.Text("Medium"), Locale.Text("High")];
            c.Index = 1;
            return c;
        }],

        /* A drop-down with items always has one chosen -- assigning `Items`
         * picks the first and `Index = -1` moves nothing -- so a field that
         * has to be able to say *nothing chosen* is given a row that means it
         * and selects that one. */
        [Locale.Text("a placeholder row"), "ComboBox", () => {
            const c = new ComboBox();
            c.Items = ["—", Locale.Text("Low"), Locale.Text("Medium"), Locale.Text("High")];
            c.Index = 0;
            return c;
        }],

        /* gtk4-demo's *String IDs*: items with an application's own name for
         * them, and the chosen one read back.  `Key` is the id and `Index` the
         * position, and a program compares the first so a translation cannot
         * move it. */
        [Locale.Text("with an application key"), "Panel", () => {
            const box = new Panel();
            box.Arrangement = "Vertical";
            box.Spacing = 4;

            const c = new ComboBox();
            c.Add(Locale.Text("Not visible"),       "never");
            c.Add(Locale.Text("Visible when active"), "when-active");
            c.Add(Locale.Text("Always visible"),    "always");
            c.Key = "when-active";

            const said = new Label();
            said.Style = "dim-label caption";

            const show = () => { said.Text = Locale.Text("key: {0}", c.Key); };
            c.On("Select", show);
            show();

            box.Add(c);
            box.Add(said);
            return box;
        }],

        [Locale.Text("rows of controls"), "RowList", () => {
            const list = new RowList();
            list.Width = 300;
            list.Height = 180;

            const sw = new Switch();
            list.Add(setting(Locale.Text("Notifications"), sw));

            const sl = new Slider();
            sl.Min = 0;
            sl.Max = 100;
            sl.Value = 40;
            sl.Width = 120;
            list.Add(setting(Locale.Text("Volume"), sl));

            const ck = new CheckButton();
            list.Add(setting(Locale.Text("Spell check"), ck));

            const sp = new SpinBox();
            sp.Min = 1;
            sp.Max = 60;
            sp.Value = 15;
            list.Add(setting(Locale.Text("Minutes"), sp));
            return list;
        }],

        /* gtk4-demo's *Selections* shows a drop-down whose items are a title, an
         * icon and a description -- a factory of widgets, not strings.  A
         * `ComboBox` holds text and nothing else, so the Bintana spelling of a
         * rich list of choices is a `RowList` with a row built by hand. */
        [Locale.Text("rows with icons"), "RowList", () => {
            const list = new RowList();
            list.Width = 320;
            list.Height = 190;

            const folders = [
                ["folder-symbolic", Locale.Text("Documents"), Locale.Text("12 files")],
                ["folder-symbolic", Locale.Text("Pictures"),  Locale.Text("348 files")],
                ["folder-symbolic", Locale.Text("Music"),     Locale.Text("56 files")],
            ];

            for (const [icon, title, sub] of folders) {
                const row = new Panel();
                row.Arrangement = "Horizontal";
                row.Spacing = 10;
                row.Margin = 6;

                const img = new Image();
                img.Icon = icon;
                img.Size = 24;
                img.VAlign = "Center";
                row.Add(img);

                const words = new Panel();
                words.Arrangement = "Vertical";
                words.Spacing = 1;
                words.HExpand = true;

                const t = new Label();
                t.Text = title;
                t.HAlign = "Fill";
                words.Add(t);

                const s = new Label();
                s.Text = sub;
                s.Style = "dim-label caption";
                s.HAlign = "Fill";
                words.Add(s);

                row.Add(words);
                list.Add(row);
            }
            return list;
        }],

        [Locale.Text("a tree"), "TreeView", () => {
            const t = new TreeView();
            t.Width = 260;
            t.Height = 180;
            t.Add("root", Locale.Text("A project"), "", "folder-symbolic");
            t.Add("form", "FactoryForm.form", "root", "text-x-generic-symbolic");
            t.Add("js", "FactoryForm.js", "root", "text-x-generic-symbolic");
            t.Add("sub", Locale.Text("A folder"), "root", "folder-symbolic");
            t.Add("leaf", "inside.js", "sub", "text-x-generic-symbolic");
            return t;
        }],

        [Locale.Text("a table"), "TableView", () => {
            const t = new TableView();
            t.Width = 400;
            t.Height = 160;
            t.Columns = [
                { Text: Locale.Text("Task"), Width: 240 },
                { Text: Locale.Text("Done"), Width: 80, Alignment: "Center" },
            ];
            t.Add([Locale.Text("Buy milk"),       Locale.Text("no")]);
            t.Add([Locale.Text("Walk the dog"),   Locale.Text("yes")]);
            t.Add([Locale.Text("Write an example"), Locale.Text("yes")]);
            return t;
        }],

        [Locale.Text("editable cells"), "TableView", () => {
            const t = new TableView();
            t.Width = 400;
            t.Height = 120;
            t.Columns = [
                { Text: Locale.Text("Name"), Width: 240, Editable: true },
                { Text: Locale.Text("Amount"), Width: 100, Alignment: "Right", Editable: true },
            ];
            t.Add([Locale.Text("Apples"), "12.00"]);
            t.Add([Locale.Text("Pears"),  "7.50"]);
            return t;
        }],

    ]],

    [Locale.Text("Layout"), [

        [Locale.Text("a panel"), "Panel", () => cells(3)],

        [Locale.Text("a frame"), "Frame", () => {
            const f = new Frame();
            f.Text = Locale.Text("A frame");
            const l = new Label();
            l.Text = Locale.Text("A panel with a title");
            l.Margin = 8;
            f.Add(l);
            return f;
        }],

        [Locale.Text("an expander"), "Expander", () => {
            const e = new Expander();
            e.Text = Locale.Text("Fold me");
            e.Expanded = true;
            const l = new Label();
            l.Text = Locale.Text("What is under the fold");
            l.Margin = 8;
            e.Add(l);
            return e;
        }],

        [Locale.Text("a grid"), "Grid", () => {
            const g = new Grid();
            g.Columns = 3;
            g.ColumnSpacing = 8;
            g.RowSpacing = 4;
            for (let i = 1; i <= 9; i++) {
                const l = new Label();
                l.Text = `${i}`;
                l.Alignment = "Center";
                l.Style = "frame";
                l.Width = 40;
                l.Height = 30;
                g.Add(l);
            }
            return g;
        }],

        [Locale.Text("a flow"), "Flow", () => {
            const f = new Flow();
            f.Width = 320;
            f.Height = 120;
            f.MinPerLine = 2;
            f.MaxPerLine = 4;
            f.RowSpacing = 6;
            f.ColumnSpacing = 6;
            for (let i = 1; i <= 8; i++) {
                const l = new Label();
                l.Text = `${i}`;
                l.Alignment = "Center";
                l.Style = "frame";
                l.Width = 40;
                l.Height = 30;
                f.Add(l);
            }
            return f;
        }],

        [Locale.Text("a scroller"), "Scroller", () => {
            const s = new Scroller();
            s.Arrangement = "Vertical";
            s.Width = 280;
            s.Height = 140;
            const lines = new Panel();
            lines.Arrangement = "Vertical";
            lines.HExpand = true;
            for (let i = 1; i <= 15; i++) {
                const l = new Label();
                l.Text = Locale.Text("line {0}", i);
                lines.Add(l);
            }
            s.Add(lines);
            return s;
        }],

        [Locale.Text("a split"), "Split", () => {
            const s = new Split();
            s.Width = 380;
            s.Height = 150;
            s.Position = 190;
            const a = new Panel();
            a.Arrangement = "Horizontal";
            const al = new Label();
            al.Text = Locale.Text("Start");
            al.Alignment = "Center";
            al.HAlign = "Fill";
            al.VAlign = "Center";
            al.HExpand = true;
            al.VExpand = true;
            a.Add(al);
            const b = new Panel();
            b.Arrangement = "Horizontal";
            const bl = new Label();
            bl.Text = Locale.Text("End");
            bl.Alignment = "Center";
            bl.HAlign = "Fill";
            bl.VAlign = "Center";
            bl.HExpand = true;
            bl.VExpand = true;
            b.Add(bl);
            s.Add(a);
            s.Add(b);
            return s;
        }],

        [Locale.Text("an overlay"), "Overlay", () => {
            const o = new Overlay();
            o.Width = 320;
            o.Height = 150;
            const base = new Panel();
            const chip = new Label();
            chip.Text = Locale.Text("a floating layer");
            chip.Style = "osd";
            chip.HAlign = "Center";
            chip.VAlign = "Center";
            o.Add(base);
            o.Add(chip);
            return o;
        }],

        [Locale.Text("a fixed ratio"), "AspectFrame", () => {
            const a = new AspectFrame();
            a.Ratio = "16:9";
            a.Width = 320;
            a.Height = 180;
            const p = new Panel();
            p.Arrangement = "Horizontal";
            p.Style = "frame";
            const l = new Label();
            l.Text = "16:9";
            l.Alignment = "Center";
            l.HAlign = "Fill";
            l.VAlign = "Center";
            l.HExpand = true;
            l.VExpand = true;
            p.Add(l);
            a.Add(p);
            return a;
        }],

        [Locale.Text("a notebook"), "Notebook", () => {
            const n = new Notebook();
            n.Width = 380;
            n.Height = 170;
            for (let i = 1; i <= 2; i++) {
                const tab = new Label();
                tab.Text = Locale.Text("Page {0}", i);
                n.Append(page(i), tab);
            }
            return n;
        }],

        [Locale.Text("a switcher"), "Switcher", () => {
            const s = new Switcher();
            s.Width = 380;
            s.Height = 170;
            for (let i = 1; i <= 3; i++)
                s.Append(page(i), Locale.Text("Page {0}", i));
            return s;
        }],

    ]],

    [Locale.Text("Media"), [

        [Locale.Text("an icon"), "Image", () => {
            const i = new Image();
            i.Icon = "face-smile-symbolic";
            return i;
        }],

        [Locale.Text("at 48 pixels"), "Image", () => {
            const i = new Image();
            i.Icon = "face-smile-symbolic";
            i.Size = 48;
            return i;
        }],

        [Locale.Text("a picture"), "Picture", () => {
            const p = new Picture();
            p.File = sampleFile();
            p.Width = 300;
            p.Height = 170;
            return p;
        }],

        [Locale.Text("covering its box"), "Picture", () => {
            const p = new Picture();
            p.File = sampleFile();
            p.Fit = "Cover";
            p.Width = 200;
            p.Height = 170;
            return p;
        }],

        [Locale.Text("a drawing"), "DrawingArea", () => {
            const a = new DrawingArea();
            a.Width = 320;
            a.Height = 170;
            a.On("Draw", (p, width, height) => {
                p.Color = "#1c71d8";
                p.Rectangle(12, 12, width - 24, height - 24);
                p.Fill();

                p.Color = "#f6f5f4";
                for (let i = 0; i < 5; i++) {
                    const tall = 20 + i * 16;
                    p.Rectangle(30 + i * 52, height - 24 - tall, 34, tall);
                    p.Fill();
                }
                p.Text(Locale.Text("a DrawingArea"), 30, 22);
            });
            return a;
        }],

        [Locale.Text("a video"), "Video", () => {
            const v = new Video();
            v.Width = 320;
            v.Height = 170;
            /* A player with nothing to play draws nothing, so the box it would
             * fill is said with the ink it has when a clip is on its way. */
            v.Background = "#000000";
            return v;
        }],

    ]],

    [Locale.Text("Miscellaneous"), [

        [Locale.Text("a separator"), "Separator", () => {
            const s = new Separator();
            s.Width = 240;
            s.Height = 2;
            return s;
        }],

        [Locale.Text("a vertical one"), "Separator", () => {
            const s = new Separator();
            s.Orientation = "Vertical";
            s.Width = 2;
            s.Height = 80;
            /* In a box the width is a minimum and `Auto` fills, so a line two
             * pixels wide has to say where it goes. */
            s.HAlign = "Center";
            return s;
        }],

    ]],

];

class FactoryForm extends Form {

    Form_Open() {
        const covered = {};

        for (const [name, samples] of TABS) {
            for (const [, type] of samples) covered[type] = true;
            this.Tabs.Append(this.buildPage(samples), name);
        }

        /*
         * The classes no sample named.  This is the fallback that makes the
         * table above safe to keep by hand: a control added to the runtime is
         * shown here -- as it comes out of `Widget.New`, with its own name for
         * a caption -- instead of being missing from the window.
         */
        const offered = Widget.Types()
            .filter((t) => !NOT_OFFERED.includes(t) && Widget.Available(t));
        const rest = offered.filter((t) => !covered[t]);

        if (rest.length) {
            const samples = rest.map((t) => [t, t, () => Widget.New(t)]);
            this.Tabs.Append(this.buildPage(samples), Locale.Text("Other"));
        }

        this.Tabs.Current = 0;
    }

    /* One tab: the samples wrapped into as many columns as the window fits.
     * A `Flow` scrolls itself, so a page longer than the window needs no
     * `Scroller` around it. */
    buildPage(samples) {
        const flow = new Flow();
        flow.RowSpacing = 18;
        flow.ColumnSpacing = 24;

        for (const [caption, , build] of samples) {
            let widget = null;
            let bad = null;
            try {
                widget = build();
            } catch (e) {
                bad = e;
            }
            flow.Add(this.block(caption, widget, bad));
        }
        return flow;
    }

    /* A sample on the page: what configuration it is, over the control.  A
     * sample that cannot be built says so instead of taking the window down --
     * `Form_Open` runs before there is a window to report into. */
    block(caption, widget, bad) {
        const box = new Panel();
        box.Arrangement = "Vertical";
        box.Spacing = 6;
        box.Margin = 6;

        const label = new Label();
        label.Style = "dim-label caption";
        label.Text = caption;
        box.Add(label);

        if (bad) {
            const err = new Label();
            err.Style = "error";
            err.Text = bad.message;
            box.Add(err);
        } else {
            box.Add(widget);
        }
        return box;
    }

}
