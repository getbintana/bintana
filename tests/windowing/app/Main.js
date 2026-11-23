"use strict";
/*
 * What a window does on a desktop with a window manager: the half tests/widgets
 * cannot see, since it runs on a bare Xvfb where no window is ever activated.
 * tests/windowing.sh gives this one xfwm4, and xdotool to type with.
 *
 * **A popover that does not hide itself must not outlive its window's turn.**
 * On X11 a popover is an override-redirect surface of its own, above every
 * window the window manager stacks, so a completion list stayed over whatever
 * application the person had moved to. What is counted is the X windows of
 * this application that are viewable: the forms, plus one per popover up.
 */

let passed = 0;
const failures = [];
function check(name, cond, detail) {
    if (cond) passed++;
    else failures.push(detail !== undefined ? name + ": " + detail : name);
}
function eq(name, got, want) {
    check(name, got === want, "expected " + JSON.stringify(want) + ", got " + JSON.stringify(got));
}

/* The application's viewable X windows. */
function viewable() {
    const ids = Exec.Wait(["xdotool", "search", "--onlyvisible", "--classname", "."]).Output
        .split("\n").filter((l) => l.trim());
    let n = 0;
    for (const id of ids) {
        const cls = Exec.Wait(["xprop", "-id", id.trim(), "WM_CLASS"]).Output;
        if (cls.includes(Application.Id)) n++;
    }
    return n;
}

class Main extends Form {

    Ed_Complete(word) { return ["alpha", "alphabet", "alpine", "alps"]; }

    Form_Open() {
        this.closedTold = 0;
        this.it = this.steps();
        Timer.After(800, () => this.next());
    }

    next() {
        let r;
        try { r = this.it.next(); }
        catch (e) { failures.push("uncaught: " + e.message + "\n" + (e.stack || "")); return this.finish(); }
        if (r.done) return this.finish();
        Timer.After(r.value || 50, () => this.next());
    }

    finish() {
        for (const f of failures) print("  FAIL  " + f);
        print("windowing: " + passed + " passed, " + failures.length + " failed");
        Application.Quit(failures.length ? 1 : 0);
    }

    /* Waits for the count of popovers (viewable windows beyond the forms shown). */
    *until(forms, popovers) {
        for (let i = 0; i < 60 && viewable() - forms !== popovers; i++) yield 100;
    }

    *type(text) {
        let done = false;
        Exec(["xdotool", "type", "--delay", "120", text], {}, () => {}, () => { done = true; });
        for (let i = 0; i < 100 && !done; i++) yield 50;
        yield 600;
    }

    *switchAway(forms, popoversAfter) {
        const b = new Form();
        b.Text = "windowing: B";
        b.Resize(200, 100);
        b.Show();
        yield* this.until(forms + 1, popoversAfter);
        return b;
    }

    *steps() {
        yield* this.until(1, 0);
        eq("the window alone", viewable(), 1);

        /* The program's own popover, asked to stay, and the editor's completion. */
        const lbl = new Label();
        lbl.Text = "stays";
        Popover.Show(lbl, this.Anchor, { Autohide: false, Closed: () => { this.closedTold++; } });
        yield* this.until(1, 1);
        eq("a popover that stays is up", viewable() - 1, 1);

        this.Ed.Text = "alpha alphabet alpine\n";
        this.Ed.SetFocus();
        this.Ed.Select(2, 1, 0);
        yield* this.type("alp");
        yield* this.until(1, 2);
        eq("and the editor's completion", viewable() - 1, 2);

        /* Another window takes the user's attention. */
        let b = yield* this.switchAway(1, 0);
        eq("both go with the window's turn", viewable() - 2, 0);
        eq("the program's is still open to the program", Popover.IsOpen(lbl), true);
        eq("and was not told it closed", this.closedTold, 0);

        b.Close();
        yield* this.until(1, 1);
        eq("the program's comes back with the window", viewable() - 1, 1);
        eq("a completion does not: the next key offers it", Popover.IsOpen(lbl), true);

        /* Closed while parked is closed, and said. */
        b = yield* this.switchAway(1, 0);
        Popover.Close(lbl);
        yield 300;
        eq("closing a parked one tells the program", this.closedTold, 1);
        eq("which is closed", Popover.IsOpen(lbl), false);
        b.Close();
        yield* this.until(1, 0);
        eq("and it does not come back", viewable() - 1, 0);

        /* A TextBox's completion list. */
        this.Txt.Completion = ["alpha", "alphabet", "alpine"];
        this.Txt.SetFocus();
        yield* this.type("al");
        yield* this.until(1, 1);
        eq("a field's completion list is up", viewable() - 1, 1);
        b = yield* this.switchAway(1, 0);
        eq("and goes with the window's turn", viewable() - 2, 0);
        b.Close();
        yield* this.until(1, 0);
    }
}
