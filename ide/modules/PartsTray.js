/*
 * The component tray: the non-visual parts a form owns, as buttons under the
 * canvas.
 *
 * A `Timer` has no rectangle, so it cannot be drawn on the surface and cannot
 * be selected there.  This is where it lives instead: one flat button per
 * part, named as the form reaches it, and a double click opens the handler the
 * way a double click on a control does.
 *
 * **The drop target is the tray, not the canvas.** The palette's button
 * carries the type in `DragData`; dropping it here creates the part.  Dropping
 * it on the canvas also creates it -- the gesture is creation and there is no
 * point to read -- but the tray is the place that says where a part landed.
 */
"use strict";

export class PartsTray {

    /** @param {Designer} designer */
    constructor(designer) {
        this.designer  = designer;
        this.signature = null;
        this.buttons   = {};

        this.panel = new Panel();
        this.panel.Name        = "PartsTray";
        this.panel.Arrangement = "Horizontal";
        this.panel.Spacing     = 4;
        this.panel.Margin      = 4;
        this.panel.Style       = "frame";
        this.panel.HExpand     = true;
        this.panel.VExpand     = false;
        this.panel.Visible     = false;

        this.label = new Label();
        this.label.Text    = Locale.Text("Components");
        this.label.Style   = "dim-label";
        this.label.VAlign  = "Center";
        this.label.Margin  = 4;

        this.flow = new Flow();
        this.flow.Spacing  = 4;
        this.flow.HExpand  = true;
        this.flow.VAlign   = "Center";
        this.flow.AcceptDrop = true;
        this.flow.On("Drop", (type) => {
            if (this.designer && this.designer.isPart(type))
                this.designer.addPart(type);
        });

        this.panel.Add(this.label);
        this.panel.Add(this.flow);
    }

    /*
     * What the tray shows, rebuilt only when a name or a type changed -- a
     * property edit leaves the buttons alone.  The panel is hidden for a form
     * with no parts, so the canvas keeps the room.
     */
    refresh() {
        const parts = this.designer ? this.designer.allParts() : [];
        const signature = parts.map((p) => `${p.Name}:${FormPart.TypeName(p)}`).join("|");

        this.panel.Visible = parts.length > 0;
        if (signature !== this.signature) {
            this.signature = signature;
            this.build(parts);
        }
        this.mark();
    }

    build(parts) {
        this.flow.Clear();
        this.buttons = {};

        for (const part of parts) {
            const type   = FormPart.TypeName(part);
            const button = new Button();
            button.Text      = part.Name;
            button.Icon      = paletteIcon(type);
            button.Style     = "flat";
            button.Tooltip   = `${part.Name} (${type})`;
            button.VAlign    = "Center";
            button.On("Click", () => this.designer.select(part));
            button.On("DblClick", () => {
                this.designer.select(part);
                this.designer.ide.openHandler(part.Name,
                                              this.designer.defaultEvent(part));
            });
            this.flow.Add(button);
            this.buttons[part.Name] = button;
        }
    }

    mark() {
        const selected = this.designer ? this.designer.selected : null;
        for (const name in this.buttons) {
            const on = selected && selected.Name === name;
            this.buttons[name].Background = on ? SELECT_COLOR : "";
            this.buttons[name].Foreground = on ? "#ffffff" : "";
        }
    }
}
