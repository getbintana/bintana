/*
 * A desk clock: a round face on the desktop and nothing else -- no title bar,
 * no frame, no square of window around the circle.
 *
 * Three declarations in the `.form` make that window, and none of them is code:
 *
 *   - `Decorated: false` -- the desktop draws no title bar and no frame;
 *   - `Background: "rgba(0,0,0,0)"` -- the window paints nothing of its own, so
 *     on a compositing desktop what is not the face is the desktop;
 *   - `DragToMove: true` -- with no title bar there is nothing to grab, so a
 *     press dragged anywhere on the face moves the window. A press that does
 *     not move is still a click.
 *
 * What is left is the drawing, which is a `DrawingArea` and its `Draw`, and a
 * `Timer` that asks for it again once a second. The time is read *in* `Draw`
 * and not kept by the timer: a tick that arrives late only repaints late, and
 * the hands are never wrong -- the same separation `examples/stopwatch` is
 * about.
 *
 * Escape or `q` closes it, since there is no close button either.
 *
 * Run it with `./build/bintana examples/clock`.
 */
"use strict";

class ClockForm extends Form {

    Form_Open() {
        this.tick = Timer.Every(1000, () => this.Face.Redraw());
    }

    Form_Close() {
        this.tick.Enabled = false;
    }

    Form_KeyPress(key) {
        if (key === "Escape" || key === "q") {
            this.Close();
            return true;
        }
        return false;
    }

    Face_Draw(p, width, height) {
        const now = new Date();
        const h = now.getHours(), m = now.getMinutes(), s = now.getSeconds();

        const x = width / 2, y = height / 2;
        const r = Math.min(width, height) / 2 - 10;

        /* The face, and its rim. `Fill` and `Stroke` both use the path up, so
         * the circle is laid down once for each. */
        p.Color = "rgba(26,26,26,0.85)";
        p.Arc(x, y, r, 0, 360);
        p.Fill();
        p.Color = "rgba(255,255,255,0.9)";
        p.LineWidth = 4;
        p.Arc(x, y, r, 0, 360);
        p.Stroke();

        /* A hand at `degrees` clockwise from twelve, `length` of the radius. */
        const hand = (degrees, length, thickness, colour) => {
            const a = (degrees - 90) * Math.PI / 180;
            p.Color = colour;
            p.LineWidth = thickness;
            p.MoveTo(x, y);
            p.LineTo(x + r * length * Math.cos(a), y + r * length * Math.sin(a));
            p.Stroke();
        };

        p.LineCap = "Round";
        hand((h % 12 + m / 60) * 30, 0.5, 6, "white");
        hand((m + s / 60) * 6, 0.75, 4, "rgb(204,204,204)");
        p.LineCap = "Butt";
        hand(s * 6, 0.85, 2, "rgb(255,51,51)");

        p.Color = "white";
        p.Arc(x, y, 5, 0, 360);
        p.Fill();
    }
}
