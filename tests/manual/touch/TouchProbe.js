/*
 * What a touch screen reaches a window as, measured before any gesture is
 * designed: every pointer event the blue area hears, with the milliseconds
 * since the last one, on screen and in `probe.log` under the configuration
 * directory (which is what to copy out of a virtual machine).
 *
 * Run it on the machine whose touch is in question:
 *
 *     bintana.exe tests\manual\touch          (Windows)
 *     ./build/bintana tests/manual/touch      (Linux)
 *
 * and touch the blue area with the screen -- or, in a virtual machine with no
 * touch screen, with `inject.ps1`, which makes Windows believe there is one.
 *
 * **What to read in the log.**
 *
 *   - A finger that arrives as `MouseDown button=1` / `MouseMove` / `MouseUp`
 *     reached GTK as an emulated pointer: GTK delivered the first finger and
 *     none of the others, so a second finger is *not here*. That is the answer
 *     for a backend that has no touch of its own.
 *   - Two fingers and `MouseDown` twice, or moves that jump between two places,
 *     mean the backend does deliver each contact; what is missing is the
 *     gesture on top of it.
 *   - A two-finger scroll on a touchpad arrives as `MouseWheel`. A pinch on one
 *     arrives as nothing yet, and that is the gap `Transform` would fill.
 *   - A long press that opens nothing and logs only the press and the release
 *     is the context menu's gap: there is no secondary button on a screen.
 *
 * It asks nothing of the runtime that is not already there, and it raises no
 * event of its own: a probe that changed what it measures would measure itself.
 */
"use strict";

class TouchProbe extends Form {

    last  = 0;
    start = Date.now();
    path  = "";

    Form_Open() {
        Directory.Make(Application.ConfigDirectory);
        this.path = File.Join(Application.ConfigDirectory, "probe.log");
        File.Save(this.path, "");

        this.LblInfo.Text = `${Application.Name} on ${Environment.OS} ${Environment.OSVersion}, ` +
                            `scale ${Screen.Scale}, ${Screen.Width}x${Screen.Height}. ` +
                            `Log: ${this.path}`;
        this.say("start", `os=${Environment.OS} scale=${Screen.Scale} monitors=${Screen.Monitors().length}`);
    }

    say(what, detail) {
        /* Not `Form_MouseMove`: a handler that writes into a control the pointer
         * is over is a handler that makes more events to log. */
        const now  = Date.now() - this.start;
        const line = `${String(now).padStart(7)} +${String(now - this.last).padStart(5)}  ${what.padEnd(13)} ${detail}\n`;
        this.last = now;
        this.Log.Append(line);
        this.Log.ScrollY = this.Log.ScrollMaxY;
        try { File.Append(this.path, line); } catch (e) { /* the screen still has it */ }
    }

    /* The same six events from three places, because *where* an event arrives
     * is the answer to half the questions: the blue area, the form under it,
     * and the log editor (whose own gestures may claim a press and keep it from
     * ever reaching a handler). `where` says which one heard it. */
    heard(where, what, x, y, extra) {
        this.say(`${where} ${what}`, `x=${Math.round(x)} y=${Math.round(y)}${extra ? " " + extra : ""}`);
    }

    Area_MouseDown(x, y, button)  { this.heard("area", "down", x, y, `button=${button}`); }
    Area_MouseUp(x, y, button)    { this.heard("area", "up", x, y, `button=${button}`); }
    Area_MouseMove(x, y)          { this.heard("area", "move", x, y); }
    Area_DblClick(x, y, button)   { this.heard("area", "dbl", x, y, `button=${button}`); }
    Area_MouseWheel(dx, dy)       { this.say("area wheel", `dx=${dx} dy=${dy}`); }

    Form_MouseDown(x, y, button)  { this.heard("form", "down", x, y, `button=${button}`); }
    Form_MouseUp(x, y, button)    { this.heard("form", "up", x, y, `button=${button}`); }
    Form_MouseWheel(dx, dy)       { this.say("form wheel", `dx=${dx} dy=${dy}`); }

    Log_MouseDown(x, y, button)   { this.heard("log", "down", x, y, `button=${button}`); }
    Log_MouseUp(x, y, button)     { this.heard("log", "up", x, y, `button=${button}`); }
    Log_MouseWheel(dx, dy)        { this.say("log wheel", `dx=${dx} dy=${dy}`); }
}
