/*
 * The report designer: the bands of a `Report` as a page you can point at.
 *
 * A report is a component of `lib/report`, and its shape is `Sections` -- bands
 * with elements at points on a page. In code that is a literal; on the IDE's
 * canvas it used to be a grey stand-in, because the designer cannot run the
 * project's class. This dialog is the missing surface: it edits the same
 * `Sections` the library already draws, and the form writes it into the node
 * so the page that prints is the page that was drawn.
 *
 * **The data stays in code.** A report designer arranges a masthead, a column
 * and a total; it cannot know what `Data` is, so it draws every `Field` with a
 * sample value and leaves the rows to the application. That is the same split
 * `Report` already makes: `Sections` is the document, `Data` is the numbers.
 *
 * **The geometry is the report's**, in points, and `ReportDocument.PaintDesign`
 * is what draws it -- the same `drawElement` that prints, with a tint and a
 * rule per band that are the designer's. The canvas scales the whole design to
 * its room, so a tall band stack scrolls instead of being cut off.
 */
"use strict";

const ZOOM = 0.8;                 /* points to pixels in the sheet */
const ROW_H = 34;
const FIXED = ["ReportHeader", "PageHeader", "Detail", "ReportFooter", "PageFooter"];
const KINDS = ["Text", "Field", "Total", "Line", "Box", "Image"];
const OPS   = ["Sum", "Count", "Min", "Max", "Avg"];
const FORMATS = ["", "Number", "Money", "Date", "Percent"];
const ALIGNS  = ["Left", "Center", "Right"];

/* A copy of a plain spec that keeps the values JSON cannot: a `Bytes` image is
 * immutable and shared, and a `Decimal` is a value. Everything else is the
 * plain data a report's `Sections` is made of. */
function clone(v) {
    if (Array.isArray(v)) return v.map((one) => clone(one));
    if (v && typeof v === "object" &&
        !(v instanceof Bytes) && !(v instanceof Decimal)) {
        const out = {};
        for (const key of Dictionary.Keys(v)) out[key] = clone(v[key]);
        return out;
    }
    return v;
}

export class ReportForm extends Form {

    /*
     * ReportForm.edit(sections, options, onAccept)
     *
     * Works on a copy and hands the whole shape back on OK, so Cancel costs
     * nothing -- the same bargain every dialog here makes. `options` is
     * `{ Paper, Orientation, Margins, Project }`; `Project` is where a chosen
     * image is made relative to, and is only for the file chooser.
     */
    static edit(sections, options, onAccept) {
        const dlg = new ReportForm();
        const opts = options || {};

        dlg.sections    = clone(sections || {});
        dlg.paper       = opts.Paper || "A4";
        dlg.orientation = opts.Orientation || "Portrait";
        dlg.margin      = typeof opts.Margins === "number" ? opts.Margins
                        : (opts.Margins && typeof opts.Margins === "object")
                            ? (opts.Margins.Top ?? 40) : 40;
        dlg.project     = opts.Project || "";
        dlg.onAccept    = onAccept;
        dlg.bandName    = "";
        dlg.elIndex     = -1;
        dlg.rows        = {};
        dlg.filling     = false;
        dlg.updating    = false;
        dlg.Modal       = true;

        dlg.Show();
        return dlg;
    }

    /* --------------------------------------------------------------- the form */

    Form_Open() {
        this.filling = true;

        this.CmbPaper.Items = Dictionary.Keys(Printer.Papers);
        this.CmbPaper.Text  = this.paper;
        this.CmbOrientation.Items = ["Portrait", "Landscape"];
        this.CmbOrientation.Text  = this.orientation;
        this.SpnMargin.Value      = this.margin;

        this.CmbAddKind.Items = KINDS;
        this.CmbAddKind.Text  = "Text";

        this.filling = false;

        this.fillBands();
        this.fillProps();
        this.refreshSheet();
    }

    /* --------------------------------------------------------------- the model */

    /* Every band in reading order: what the page shows, top to bottom. The page
     * footer is last because it is the sheet's, not the flow's. */
    bandNames() {
        const sec  = this.sections;
        const out  = [];
        const put  = (name) => { if (sec[name]) out.push(name); };

        put("ReportHeader");
        put("PageHeader");

        (sec.Groups || []).forEach((g, i) => {
            if (g.Header) out.push(`Groups[${i}].Header`);
        });

        put("Detail");

        for (let i = (sec.Groups || []).length - 1; i >= 0; i--)
            if (sec.Groups[i].Footer) out.push(`Groups[${i}].Footer`);

        put("ReportFooter");
        put("PageFooter");
        return out;
    }

    bandByName(name) {
        if (!name) return null;

        const m = /^Groups\[(\d+)\]\.(Header|Footer)$/.exec(name);
        if (m) {
            const g = (this.sections.Groups || [])[Number(m[1])];
            return g ? g[m[2]] || null : null;
        }
        return this.sections[name] || null;
    }

    groupAt(name) {
        const m = /^Groups\[(\d+)\]\.(Header|Footer)$/.exec(name || "");
        return m ? Number(m[1]) : -1;
    }

    bandPretty(name) {
        if (name === "ReportHeader") return "Report header";
        if (name === "PageHeader")   return "Page header";
        if (name === "Detail")       return "Detail";
        if (name === "ReportFooter") return "Report footer";
        if (name === "PageFooter")   return "Page footer";

        const m = /^Groups\[(\d+)\]\.(Header|Footer)$/.exec(name);
        if (m) return `Group ${Number(m[1]) + 1} ${m[2].toLowerCase()}`;
        return name;
    }

    missingFixed() {
        return FIXED.filter((name) => !this.sections[name]);
    }

    allBands(sec) {
        const out = [];
        for (const name of FIXED) if (sec[name]) out.push(sec[name]);
        for (const g of sec.Groups || []) {
            if (g.Header) out.push(g.Header);
            if (g.Footer) out.push(g.Footer);
        }
        return out;
    }

    /*
     * A document for the preview, with every Image that has no file yet given a
     * placeholder name: `checkSections` refuses a nameless image, and the
     * designer is exactly where a picture is still being chosen. `PaintDesign`
     * then draws a box for the missing file instead of throwing.
     */
    previewDocument() {
        const copy = clone(this.sections);

        for (const band of this.allBands(copy))
            for (const el of band.Elements || [])
                if (el.Kind === "Image" && !el.File && el.Bytes === undefined)
                    el.File = "missing-image";

        const doc = new ReportDocument();
        doc.Paper       = this.CmbPaper.Text || "A4";
        doc.Orientation = this.CmbOrientation.Text || "Portrait";
        doc.Margins     = this.SpnMargin.Value;
        doc.Sections    = copy;
        return doc;
    }

    /* ---------------------------------------------------------------- the page */

    refreshSheet() {
        let doc;
        try {
            doc = this.previewDocument();
        } catch (e) {
            this.LblBandHint.Text = e.message;
            this.layoutPoints = null;
            this.docForDraw   = null;
            this.Sheet.Redraw();
            return;
        }

        this.LblBandHint.Text = "Drag an element on the page. Drag a band's bottom edge to make it taller.";

        const points = doc.DesignLayout();
        this.layoutPoints = points;
        this.docForDraw   = doc;

        this.Sheet.Resize(Math.max(100, Math.round(points.Width * ZOOM)),
                          Math.max(100, Math.round(points.Height * ZOOM)));
        this.Sheet.Redraw();
    }

    Sheet_Draw(p, width, height) {
        const doc = this.docForDraw;
        if (!doc) return;

        let layout;
        try {
            layout = doc.PaintDesign(p, width, height);
        } catch (e) {
            return;
        }

        this.drawn = layout;

        const band = layout.Bands.find((b) => b.Name === this.bandName);
        if (!band) return;

        p.Push();
        p.Color    = "rgba(53,132,228,0.9)";
        p.LineWidth = 1;
        p.Rectangle(band.X, band.Y, band.Width, band.Height);
        p.Stroke();

        const el = this.elIndex >= 0
            ? band.Elements.find((one) => one.Index === this.elIndex) : null;

        if (el) {
            p.Rectangle(el.X, el.Y, el.Width, el.Height);
            p.Stroke();
            p.Color = "rgba(53,132,228,1)";
            for (const [hx, hy] of [[el.X, el.Y], [el.X + el.Width, el.Y],
                                    [el.X, el.Y + el.Height],
                                    [el.X + el.Width, el.Y + el.Height]]) {
                p.Rectangle(hx - 3, hy - 3, 6, 6);
                p.Fill();
            }
        }
        p.Pop();

        /* The band's name, in the page's own left margin. */
        p.Font  = "Sans 7";
        p.Color = "rgba(0,0,0,0.55)";
        for (const b of layout.Bands)
            p.Text(this.bandPretty(b.Name), layout.X + 2, b.Y + 9);
    }

    /* The same scale `PaintDesign` uses, from the requested sheet size. */
    scaleOf(points) {
        return Math.max(0.01, Math.min(this.Sheet.Width / points.Width,
                                       this.Sheet.Height / points.Height));
    }

    originOf(points, scale) {
        return { x: (this.Sheet.Width  - points.Width  * scale) / 2,
                 y: (this.Sheet.Height - points.Height * scale) / 2 };
    }

    hit(x, y) {
        const points = this.layoutPoints;
        if (!points) return null;

        const scale = this.scaleOf(points);
        const at    = this.originOf(points, scale);

        for (let i = points.Bands.length - 1; i >= 0; i--) {
            const b = points.Bands[i];

            for (let j = b.Elements.length - 1; j >= 0; j--) {
                const e  = b.Elements[j];
                const ex = at.x + e.X * scale;
                const ey = at.y + e.Y * scale;
                const ew = e.Width  * scale;
                const eh = e.Height * scale;

                if (x >= ex && x <= ex + ew && y >= ey && y <= ey + eh)
                    return { band: b, element: e };
            }
        }

        for (let i = points.Bands.length - 1; i >= 0; i--) {
            const b  = points.Bands[i];
            const by = at.y + b.Y * scale;
            const bh = b.Height * scale;

            if (y >= by && y <= by + bh)
                return { band: b, element: null, edge: Math.abs(y - (by + bh)) <= 4 };
        }
        return null;
    }

    /* ------------------------------------------------------------- the gesture */

    Sheet_MouseDown(x, y, button) {
        if (button !== 1) return;
        this.drag = null;

        const hit = this.hit(x, y);
        if (!hit) {
            this.bandName = "";
            this.elIndex  = -1;
            this.fillBands();
            this.fillProps();
            this.Sheet.Redraw();
            return;
        }

        this.bandName = hit.band.Name;
        this.elIndex  = hit.element ? hit.element.Index : -1;
        this.fillBands();
        this.fillProps();
        this.Sheet.Redraw();

        const points = this.layoutPoints;
        const scale  = this.scaleOf(points);

        if (hit.element) {
            const el = hit.element.Element;
            this.drag = { kind: "element", el,
                          startX: x, startY: y,
                          ox: Number(el.X) || 0,
                          oy: Number(el.Y) || 0,
                          scale };
        } else if (hit.edge) {
            this.drag = { kind: "band", band: hit.band.Band,
                          startX: x, startY: y,
                          oh: hit.band.Height,
                          scale };
        }
    }

    Sheet_MouseMove(x, y) {
        const d = this.drag;
        if (!d) return;

        const dx = (x - d.startX) / d.scale;
        const dy = (y - d.startY) / d.scale;

        this.updating = true;
        if (d.kind === "element") {
            d.el.X = Math.max(0, Math.round(d.ox + dx));
            d.el.Y = Math.max(0, Math.round(d.oy + dy));
            if (this.rows.X) this.rows.X.Text = String(d.el.X);
            if (this.rows.Y) this.rows.Y.Text = String(d.el.Y);
        } else {
            d.band.Height = Math.max(1, Math.round(d.oh + dy));
            if (this.rows.Height) this.rows.Height.Text = String(d.band.Height);
        }
        this.updating = false;

        this.refreshSheet();
    }

    Sheet_MouseUp() {
        if (!this.drag) return;
        this.drag = null;
        this.fillProps();
        this.refreshSheet();
    }

    Sheet_MouseCancel() { this.drag = null; }

    /* -------------------------------------------------------------- the panels */

    fillBands() {
        const names = this.bandNames();

        this.filling = true;
        this.BandList.Items = names.map((name) => this.bandPretty(name));

        if (!this.bandName && names.length) this.bandName = names[0];
        const at = names.indexOf(this.bandName);
        if (at >= 0) this.BandList.Index = at;

        this.CmbBandAdd.Items = this.missingFixed();
        this.CmbBandAdd.Text  = this.CmbBandAdd.Items[0] || "";
        this.filling = false;
    }

    BandList_Select() {
        if (this.filling) return;

        const names = this.bandNames();
        this.bandName = names[this.BandList.Index] || "";
        this.elIndex  = -1;
        this.fillProps();
        this.Sheet.Redraw();
    }

    fillProps() {
        this.Props.Clear();
        this.rows = {};

        const band = this.bandByName(this.bandName);
        const el   = band && this.elIndex >= 0
            ? (band.Elements || [])[this.elIndex] : null;

        this.target       = el || band || null;
        this.targetIsBand = !el && !!band;
        this.LblProps.Text = el ? `${el.Kind} element`
                           : band ? this.bandPretty(this.bandName)
                                  : "Properties";

        if (el) {
            this.elementRows(el);
        } else if (band) {
            this.bandRows(band);
        }

        this.Props.Resize(280, Math.max(40, this.Props.Children.length * (ROW_H + 4)));
    }

    bandRows(band) {
        const at = this.groupAt(this.bandName);
        if (at >= 0)
            this.addRow("On", "Group by", "text",
                        ((this.sections.Groups || [])[at] || {}).On || "");

        this.addRow("Height", "Height", "text",
                    band.Height === "Auto" ? "Auto" : String(band.Height || 0));
        this.addRow("Padding", "Padding", "text", String(band.Padding || 0));
    }

    elementRows(el) {
        this.addRow("Kind", "Kind", "combo", el.Kind, KINDS);

        if (el.Kind === "Text") {
            this.addRow("Text", "Text", "text", el.Text || "");
        } else if (el.Kind === "Field" || el.Kind === "Total") {
            this.addRow("Field", "Field", "text", el.Field || "");
            if (el.Kind === "Total")
                this.addRow("Op", "Op", "combo", el.Op || "Sum", OPS);
            this.addRow("Format", "Format", "combo", el.Format || "", FORMATS);
        }

        if (el.Kind === "Line") {
            this.addRow("X1", "X1", "text", String(el.X1 || 0));
            this.addRow("Y1", "Y1", "text", String(el.Y1 || 0));
            this.addRow("X2", "X2", "text", String(el.X2 || 0));
            this.addRow("Y2", "Y2", "text", String(el.Y2 || 0));
            this.addRow("Thickness", "Thickness", "text", String(el.Thickness || 1));
        } else {
            this.addRow("X", "X", "text", String(el.X || 0));
            this.addRow("Y", "Y", "text", String(el.Y || 0));
            this.addRow("Width", "Width", "text",
                        el.Width === "Band" ? "Band" : String(el.Width || 0));
            this.addRow("Height", "Height", "text",
                        el.Height === "Band" ? "Band" : String(el.Height || 0));
        }

        if (el.Kind === "Image") {
            this.addRow("File", "File", "file", el.File || "");
        }

        if (el.Kind === "Box")
            this.addRow("Fill", "Fill", "check", !!el.Fill);

        if (el.Kind === "Text" || el.Kind === "Field" || el.Kind === "Total") {
            this.addRow("Align", "Align", "combo", el.Align || "Left", ALIGNS);
            this.addRow("Wrap", "Wrap", "check", !!el.Wrap);
        }

        if (el.Kind !== "Line" && el.Kind !== "Box" && el.Kind !== "Image") {
            this.addRow("Font", "Font", "font", typeof el.Font === "string" ? el.Font : "");
            this.addRow("Color", "Color", "color", typeof el.Color === "string" ? el.Color : "");
        } else if (el.Kind === "Line" || el.Kind === "Box") {
            this.addRow("Color", "Color", "color", typeof el.Color === "string" ? el.Color : "");
        }

        this.addRow("When", "When", "text", this.whenText(el.When));
    }

    whenText(w) {
        if (w === undefined || w === null) return "";
        if (typeof w === "string") return w;
        if (typeof w === "boolean") return String(w);
        return JSON.stringify(w);
    }

    /* One property row: a caption and an editor. The editor is kept in `rows`
     * so a drag can move a number without rebuilding the panel under the
     * pointer. */
    addRow(key, label, kind, value, options) {
        const line = new Panel();
        line.Name        = `Row${key}`;
        line.Arrangement = "Horizontal";
        line.Spacing     = 4;
        line.Height      = ROW_H;
        line.Width       = 280;

        const cap = new Label();
        cap.Text   = label;
        cap.Width  = 82;
        cap.VAlign = "Center";
        line.Add(cap);

        let editor;
        if (kind === "combo") {
            editor = new ComboBox();
            editor.Items = options || [];
            editor.Text  = String(value ?? "");
            editor.Width = 180;
            editor.On("Select", () => this.setValue(key, editor.Text));
        } else if (kind === "check") {
            editor = new CheckButton();
            editor.Text   = "";
            editor.Active = !!value;
            editor.Width  = 180;
            editor.On("Click", () => this.setValue(key, editor.Active));
        } else if (kind === "color") {
            editor = new ColorButton();
            editor.Value = typeof value === "string" ? value : "";
            editor.Width = 180;
            editor.On("Change", () => this.setValue(key, editor.Value));
        } else if (kind === "font") {
            editor = new FontButton();
            editor.Value = typeof value === "string" ? value : "";
            editor.Width = 180;
            editor.On("Change", () => this.setValue(key, editor.Value));
        } else if (kind === "file") {
            const box = new Panel();
            box.Arrangement = "Horizontal";
            box.Spacing     = 4;
            box.Width       = 180;
            box.Height      = ROW_H;

            const field = new TextBox();
            field.Text  = String(value ?? "");
            field.Width = 140;
            field.Height = ROW_H;
            field.On("Change", () => this.setValue(key, field.Text));

            const browse = new Button();
            browse.Text   = "...";
            browse.Width  = 36;
            browse.Height = ROW_H;
            browse.On("Click", () => this.browseImage());

            box.Add(field);
            box.Add(browse);
            editor = field;
            line.Add(box);
            this.rows[key] = field;
            this.Props.Add(line);
            return;
        } else {
            editor = new TextBox();
            editor.Text   = String(value ?? "");
            editor.Width  = 180;
            editor.Height = ROW_H;
            editor.On("Change", () => this.setValue(key, editor.Text));
        }

        line.Add(editor);
        this.Props.Add(line);
        this.rows[key] = editor;
    }

    browseImage() {
        Dialog.OpenFile(Locale.Text("Choose an image"),
            { Filters: [[Locale.Text("Images"), "*.png *.jpg *.jpeg *.webp *.svg *.bmp *.tif *.tiff"]] },
            (path) => {
                if (!this.target) return;
                this.target.File = this.project && File.Within(path, this.project)
                    ? File.Relative(path, this.project) : path;
                delete this.target.Bytes;
                if (this.rows.File) this.rows.File.Text = this.target.File;
                this.refreshSheet();
            });
    }

    setValue(key, raw) {
        if (this.updating || !this.target) return;

        const band = this.targetIsBand;
        const obj  = this.target;

        if (band) {
            if (key === "On") {
                const at = this.groupAt(this.bandName);
                const group = (this.sections.Groups || [])[at];
                if (group) group.On = String(raw);
            } else if (key === "Height") {
                const text = String(raw).trim().toLowerCase();
                obj.Height = text === "auto" ? "Auto" : (Number(raw) || 0);
            } else if (key === "Padding") {
                obj.Padding = Number(raw) || 0;
            }
        } else if (key === "Kind") {
            if (obj.Kind !== raw) {
                obj.Kind = raw;
                this.refreshSheet();
                /* The row that raised this is about to be deleted, so the panel
                 * is rebuilt after the signal returns. */
                Timer.After(0, () => {
                    if (this.Visible && this.target === obj) this.fillProps();
                });
                return;
            }
        } else if (key === "Text") {
            obj.Text = String(raw);
        } else if (key === "Field") {
            obj.Field = String(raw);
        } else if (key === "Op") {
            obj.Op = String(raw);
        } else if (key === "Format") {
            if (String(raw) === "") delete obj.Format; else obj.Format = String(raw);
        } else if (key === "Align") {
            obj.Align = String(raw);
        } else if (key === "Wrap" || key === "Fill") {
            obj[key] = !!raw;
        } else if (key === "Font") {
            if (String(raw) === "") delete obj.Font; else obj.Font = String(raw);
        } else if (key === "Color") {
            if (String(raw) === "") delete obj.Color; else obj.Color = String(raw);
        } else if (key === "File") {
            obj.File = String(raw);
            if (obj.File) delete obj.Bytes;
        } else if (key === "When") {
            const text = String(raw).trim();
            if (text === "") delete obj.When;
            else if (text === "true")  obj.When = true;
            else if (text === "false") obj.When = false;
            else if (text.startsWith("{")) {
                try { obj.When = JSON.parse(text); } catch (e) { /* the preview says */ }
            } else obj.When = text;
        } else if (key === "X1" || key === "Y1" || key === "X2" || key === "Y2" ||
                   key === "Thickness") {
            obj[key] = Number(raw) || 0;
        } else if (key === "Width" || key === "Height") {
            obj[key] = String(raw).trim().toLowerCase() === "band"
                ? "Band" : (Number(raw) || 0);
        } else if (key === "X" || key === "Y") {
            obj[key] = Math.max(0, Number(raw) || 0);
        }

        this.refreshSheet();
    }

    /* ---------------------------------------------------------------- commands */

    BtnBandAdd_Click() {
        const name = this.CmbBandAdd.Text;
        if (!name) return;

        this.sections[name] = { Height: name === "Detail" ? 40 : 30, Elements: [] };
        this.bandName = name;
        this.elIndex  = -1;
        this.fillBands();
        this.fillProps();
        this.refreshSheet();
    }

    BtnBandDel_Click() {
        const name = this.bandName;
        if (!name) return;

        if (this.groupAt(name) >= 0) {
            this.removeGroup(this.groupAt(name));
            return;
        }

        ConfirmForm.ask(Locale.Text("Remove band"),
                        Locale.Text("Remove the {0} band and everything in it?", this.bandPretty(name)),
                        Locale.Text("Remove"), () => {
                            delete this.sections[name];
                            this.bandName = "";
                            this.elIndex  = -1;
                            this.fillBands();
                            this.fillProps();
                            this.refreshSheet();
                        });
    }

    BtnGroupAdd_Click() {
        const on = this.TxtGroup.Text.trim();
        if (!on) {
            this.LblBandHint.Text = "Group by needs a field name.";
            return;
        }

        const groups = this.sections.Groups || (this.sections.Groups = []);
        groups.push({
            On: on,
            Header: { Height: 24, Elements: [
                { Kind: "Text", Text: on, X: 0, Y: 4, Font: "Sans Bold 10" }
            ] },
            Footer: { Height: 24, Elements: [] },
        });

        this.bandName = `Groups[${groups.length - 1}].Header`;
        this.elIndex  = -1;
        this.fillBands();
        this.fillProps();
        this.refreshSheet();
    }

    BtnGroupDel_Click() {
        const at = this.groupAt(this.bandName);
        if (at < 0) {
            this.LblBandHint.Text = "Select a group band first.";
            return;
        }
        this.removeGroup(at);
    }

    removeGroup(at) {
        const groups = this.sections.Groups || [];
        if (at < 0 || at >= groups.length) return;

        ConfirmForm.ask(Locale.Text("Remove group"),
                        Locale.Text("Remove group {0} and its header and footer?", at + 1),
                        Locale.Text("Remove"), () => {
                            groups.splice(at, 1);
                            if (!groups.length) delete this.sections.Groups;
                            this.bandName = "";
                            this.elIndex  = -1;
                            this.fillBands();
                            this.fillProps();
                            this.refreshSheet();
                        });
    }

    BtnAdd_Click() {
        const band = this.bandByName(this.bandName) || this.sections.Detail;
        if (!band) {
            this.LblBandHint.Text = "Add a Detail band first.";
            return;
        }

        const kind = this.CmbAddKind.Text;
        if (kind === "Image") {
            Dialog.OpenFile(Locale.Text("Choose an image"),
                { Filters: [[Locale.Text("Images"), "*.png *.jpg *.jpeg *.webp *.svg *.bmp *.tif *.tiff"]] },
                (path) => {
                    const file = this.project && File.Within(path, this.project)
                        ? File.Relative(path, this.project) : path;
                    this.addElement(band, kind, file);
                });
            return;
        }

        this.addElement(band, kind, "");
    }

    addElement(band, kind, file) {
        let bottom = 0;
        for (const el of band.Elements || []) {
            const y = el.Kind === "Line"
                ? Math.max(Number(el.Y1) || 0, Number(el.Y2) || 0)
                : Number(el.Y) || 0;
            const h = el.Kind === "Line" ? 0 : Number(el.Height) || 20;
            bottom = Math.max(bottom, y + h + 4);
        }

        let el;
        if (kind === "Text") {
            el = { Kind: "Text", Text: "Text", X: 0, Y: bottom, Width: 120 };
        } else if (kind === "Field") {
            el = { Kind: "Field", Field: "Field", X: 0, Y: bottom, Width: 120 };
        } else if (kind === "Total") {
            el = { Kind: "Total", Field: "Field", Op: "Sum", Format: "Number",
                   X: 0, Y: bottom, Width: 120 };
        } else if (kind === "Line") {
            el = { Kind: "Line", X1: 0, Y1: bottom, X2: 200, Y2: bottom };
        } else if (kind === "Box") {
            el = { Kind: "Box", X: 0, Y: bottom, Width: 200, Height: 24 };
        } else if (kind === "Image") {
            el = { Kind: "Image", File: file || "", X: 0, Y: bottom, Width: 100 };
        } else {
            return;
        }

        band.Elements = band.Elements || [];
        band.Elements.push(el);
        this.elIndex = band.Elements.length - 1;
        this.fillBands();
        this.fillProps();
        this.refreshSheet();
    }

    BtnDelete_Click() {
        const band = this.bandByName(this.bandName);
        if (!band || this.elIndex < 0) return;

        (band.Elements || []).splice(this.elIndex, 1);
        this.elIndex = -1;
        this.fillProps();
        this.refreshSheet();
    }

    CmbPaper_Select()       { this.refreshSheet(); }
    CmbOrientation_Select() { this.refreshSheet(); }
    SpnMargin_Change()      { this.refreshSheet(); }

    /* ------------------------------------------------------------------ accept */

    BtnOk_Click() {
        /* A `Bytes` image is runtime data: JSON would write it as base64 and
         * the loader would hand `Painter.Image` a string, which is a path. A
         * form can carry a file name; it cannot carry the picture itself. */
        for (const band of this.allBands(this.sections))
            for (const el of band.Elements || [])
                if (el.Kind === "Image" && el.Bytes !== undefined) {
                    Message.Error("A report Image held as Bytes cannot be saved in a form. Choose a File for it instead.");
                    return;
                }

        let doc;
        try {
            doc = new ReportDocument();
            doc.Paper       = this.CmbPaper.Text;
            doc.Orientation = this.CmbOrientation.Text;
            doc.Margins     = this.SpnMargin.Value;
            doc.Sections    = this.sections;
        } catch (e) {
            Message.Error("The report is not valid: {0}", e.message);
            return;
        }

        const answer = {
            Sections:    this.sections,
            Paper:       doc.Paper,
            Orientation: doc.Orientation,
            Margins:     doc.Margins,
        };
        const cb = this.onAccept;

        this.Close();
        if (cb) cb(answer);
    }

    BtnCancel_Click() { this.Close(); }
}
