/*
 * The project check as a child process.
 *
 * The pass is seconds on a large project -- 6 s from a shell, more inside the
 * IDE where completion has already read every source -- and it used to run on
 * the main thread. The window appeared, and then nothing answered for the
 * length of the pass: a project tree that could not be clicked, a file that
 * could not be opened. A `Task` is not the answer: its worker deliberately
 * runs `rad.js` and not `forms.js`, so it has no `Widget`, and `lib/check`
 * asks `Widget.Types`/`Member`/`EventNames` for every control. The runtime
 * already has the pass as a command, and the IDE already runs commands as
 * children (`Run`, `Git`, the project's tests).
 *
 * This is that command. It starts `bintana check --json <project>` after the
 * window is visible, parses the one-line JSON the tool prints, and reports the
 * findings under the `project` source when the `Done` line arrives. The UI
 * keeps painting and taking clicks while the child works.
 *
 * **A child reads the disk, and the person may type while it does.** The
 * print before and after the run is the same content fingerprint `Check.run`
 * uses; a project that moved while the child ran is a result that answers
 * about two versions, and it is dropped rather than shown.
 *
 * **The component map is the one thing the child cannot ask.** A form's
 * control can be a component of the project, whose events live in the IDE's
 * `Classes`; the child is a console project with no IDE. `Classes.componentEventsMap`
 * is written to a temporary file and passed as `--components`, so the child
 * checks the same member/event pairs the in-process pass did.
 */
"use strict";

export class CheckJob {

    /** @param {MainForm} ide */
    constructor(ide) {
        this.ide = ide;

        /* The child, the visibility wait, and what it is about. A generation
         * makes a late answer from a replaced job a no-op: `Stop` is a signal,
         * and its exit callback still arrives. */
        this.job        = null;
        this.timer      = null;
        this.project    = "";
        this.generation = 0;

        /* The component map on its way to the child, the findings read so far,
         * and the `Done` line. */
        this.tmp      = "";
        this.findings = [];
        this.doneLine = null;
        this.print    = "";
    }

    /* Leaving the project: no child, no pending look, no rows about it. */
    forget() {
        this.stop();
        this.ide.problems.clear("project");
    }

    /*
     * Start once the window is visible, and not before.
     *
     * `Timer.After(0)` -- or half a second -- ran before GTK had drawn the
     * first frame; the pass then held the loop and the window stayed on screen
     * with nothing in it. `Visible` is false inside `Form_Open` and true once
     * `Show` has presented the window; the extra 100 ms is the frame.
     */
    schedule() {
        this.stopTimer();

        const project = this.ide.project;
        const wait = () => {
            this.timer = null;
            if (this.ide.project !== project) return;

            if (this.ide.Visible === false) {
                this.timer = Timer.After(50, wait);
                return;
            }
            this.timer = Timer.After(100, () => {
                this.timer = null;
                if (this.ide.project === project) this.start();
            });
        };

        this.timer = Timer.After(50, wait);
    }

    /* Project -> Check: the one run a person asked for, so it starts now
     * rather than waiting for a frame. */
    start() {
        this.stop();

        const project = this.ide.project;
        if (!project) return;

        const generation = this.generation;
        this.print       = this.ide.check.scan().print;
        this.findings    = [];
        this.doneLine    = null;

        let components = "";
        try {
            const map = this.ide.classes.componentEventsMap();
            if (Dictionary.Keys(map).length) {
                components = File.Join(
                    Environment.TempDirectory,
                    `bta-check-${Environment.ProcessId}-${generation}.json`);
                File.SaveJson(components, map);
                this.tmp = components;
            }
        } catch (e) {
            /* The check still runs; a component's events are the one thing it
             * will not have an answer for, which is the shell's own refusal. */
            components = "";
            this.ide.log(Locale.Text(
                "Check: the component events were not passed: {0}\n", e.message));
        }

        const argv = [Application.Executable, "check", "--json"];
        if (components) argv.push("--components", components);
        argv.push(project);

        try {
            this.job = Exec(argv, { Stderr: "separate" },
                (line, from) => this.line(line, from, generation, project),
                (code)       => this.done(code, generation, project));
        } catch (e) {
            this.job = null;
            this.fail(Locale.Text(
                "The project check could not start: {0}", e.message));
        }
    }

    /* Stop the child and any pending look. The generation makes the exit
     * callback of a stopped job stale, so it cannot report into a project that
     * has moved on. */
    stop() {
        this.generation++;

        if (this.job) {
            this.job.Stop();
            this.job = null;
        }
        this.stopTimer();
        this.cleanup();
    }

    stopTimer() {
        if (this.timer) {
            this.timer.Stop();
            this.timer = null;
        }
    }

    cleanup() {
        if (this.tmp) {
            try { File.Delete(this.tmp); } catch (e) { /* already gone */ }
            this.tmp = "";
        }
    }

    /* One line of the child's `--json`: a finding, or the `Done` that says the
     * pass finished and how many of each it found. Anything else -- Mesa on
     * stderr, a line a future version added -- is not this class's. */
    line(line, from, generation, project) {
        if (generation !== this.generation || project !== this.ide.project)
            return;
        if (from && from !== "out")
            return;

        let said;
        try { said = JSON.parse(line); }
        catch (e) { return; }

        if (said.Event === "Finding") {
            const row = {
                kind: said.Kind,
                file: said.File,
                line: said.Line || 0,
                text: said.Text,
            };
            if (said.Fix) row.fix = said.Fix;
            this.findings.push(row);
        } else if (said.Event === "Done") {
            this.doneLine = said;
        }
    }

    /* The child is gone: report what it said, unless the project moved while
     * it was reading. `this.print` is the content the child started on; a scan
     * now is the same 20 ms the start paid and is what makes the answer safe
     * to show while somebody types. */
    done(code, generation, project) {
        if (generation !== this.generation || project !== this.ide.project)
            return;

        this.job = null;

        let now = "";
        try { now = this.ide.check.scan().print; }
        catch (e) { now = this.print; }

        if (!this.doneLine) {
            this.fail(Locale.Text(
                "The project check ended with {0} and said nothing", String(code)));
            this.cleanup();
            return;
        }

        if (now !== this.print) {
            this.ide.log(Locale.Text(
                "Check: the project changed while it ran; run it again.\n"));
            this.cleanup();
            return;
        }

        this.ide.check.remember(this.print, this.findings);
        this.ide.problems.report("project", this.findings);

        if (this.findings.length)
            this.ide.log(Locale.Text("Check: {0} findings\n",
                                     String(this.findings.length)));
        else
            this.ide.log(Locale.Text("Check: nothing wrong with the project\n"));

        this.cleanup();
    }

    fail(message) {
        this.ide.problems.report("project", [{
            kind: "Error", file: "project.json", line: 0, text: message,
        }]);
        this.ide.log(`${message}\n`);
        this.cleanup();
    }
}
