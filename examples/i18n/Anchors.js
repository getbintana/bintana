/*
 * What `Anchored` does when the *contents* grow instead of the window.
 *
 * An anchor answers one question -- the window got bigger, where does this
 * control go -- by keeping the gap the control was **drawn** with. Translation
 * asks it a question it was not written for: the window got bigger *because the
 * contents did*.
 *
 * `bta_fixed_measure` asks each child for its minimum and reports
 * `MAX(offset + minimum)`, so a control whose text grew makes the surface's
 * minimum grow with it -- which is right, and is why nothing here clips. What
 * that used to break was the origin: the surface latched whatever it was first
 * allocated, so on a pushed form the design size *became* the pushed size, every
 * anchor went inert, and the extra room sat dead against the far edge. A form
 * declares its size, and that declaration is the origin now.
 *
 * `BtnLong` is one of the ones that pushes: `Save` is four characters and its
 * translation is nineteen. It is also the interesting case, because it both grew
 * *and* is anchored `End` -- an anchor that moved it by the whole slack on top of
 * its own growth would put it past the edge it is anchored to. Its gap comes out
 * the same in both languages, which is what says it does not.
 *
 *   LC_ALL=C LANGUAGE=en ./build/bintana examples/i18n
 *   LANGUAGE=es          ./build/bintana examples/i18n
 */
"use strict";

/* The width the coordinates in Anchors.form were written against. */
const DESIGN_W = 460;

class Anchors extends Form {

    Form_Open() {
        /*
         * Waited for rather than timed. Nothing is allocated until the main loop
         * has run, and how many frames that takes is GTK's business -- a fixed
         * delay measured a window of zeroes the first time this ran in Spanish,
         * where the longer strings simply took one frame more.
         */
        this.whenLaidOut(() => this.measure(), 100);
    }

    whenLaidOut(then, tries) {
        if (this.Bounds().Width > 1 || tries <= 0) { then(); return; }
        Timer.After(20, () => this.whenLaidOut(then, tries - 1));
    }

    BtnMeasureA_Click() { this.measure(); }

    measure() {
        const surface = this.Bounds().Width;
        const out = [
            Locale.Current ? `catalogue: ${Locale.Current}` : "catalogue: none (msgids)",
            `surface ${surface} wide, .form drew ${DESIGN_W}` +
            (surface > DESIGN_W ? `  (+${surface - DESIGN_W}: a control's text pushed it)` : ""),
            "",
        ];

        /*
         * The gap to the right edge is what an End anchor promises to keep, so it
         * is the number that says whether the promise is about the design or
         * about whatever the first frame happened to be.
         *
         * Compared between languages and **not** against the declared width:
         * `Bounds()` is the box a control is *drawn* as, and a theme's margins
         * make a Button smaller than the room it was given. Against the `.form`
         * that difference is noise; between two runs of the same form it cancels,
         * so what is left is the effect being looked for.
         */
        /* Every control, not a chosen few: the first version of this listed five
         * by name and none of them had grown, because the one that pushed the
         * surface was the Measure button nobody thought to include. A report that
         * has to be right about which control matters is one that can be wrong. */
        for (const w of this.Controls) {
            if (w === this.Report) continue;

            const box = w.Bounds();
            const ask = w.SizeRequest()[0];
            const grew = ask > 0 && box.Width > ask;

            out.push(`${(w.Name || "?").padEnd(12)} ${w.HAlign.padEnd(7)} ` +
                     `x=${String(box.X).padStart(3)} w=${String(box.Width).padStart(3)}` +
                     `${grew ? `(>${ask})` : "     "}  ` +
                     `gap=${String(surface - (box.X + box.Width)).padStart(3)}`);
        }

        /* And what came of it, said as a number rather than as an impression. */
        if (surface > DESIGN_W) {
            out.push("",
                `A control's text pushed the surface ${surface - DESIGN_W}px past the ` +
                `${DESIGN_W} it was drawn at, and the anchors are still measured from ` +
                `${DESIGN_W}: every End keeps the gap it was drawn with (compare it ` +
                `against the run with no catalogue), Center moved half the slack, and ` +
                `Start stayed put -- so the far edge moved away from it, which is what ` +
                `Start means.`);
        } else {
            out.push("", "The surface is the size it was drawn at, so there is no " +
                         "slack and no anchor has anything to do.");
        }

        this.Report.Text = out.join("\n");
        print(`--- ${this.Text} ---\n${this.Report.Text}\n`);
    }
}
