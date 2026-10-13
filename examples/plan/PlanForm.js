/*
 * A task sheet edited where it is read: every cell of a task is a field of its
 * own kind, declared once in the `.form` as the column's `Editor`.
 *
 *   Task       "Text"
 *   Duration   a "Number" from 0 to 365, kept as "5d" -- `CellEdit` answers
 *              the spelling it wants kept
 *   Start      a "Date": typed, or picked from the calendar beside it
 *   Done       a "Check" whose cell holds "Yes" or "No"
 *   Calendar   a "Combo" whose items are the plan's, handed over by
 *              `CellEditor` as each edit begins -- the column declares none
 *   Notes      "Custom": the cell opens nothing of its own, and `CellEditor`
 *              opens a dialog and writes the answer with `SetCell`
 *
 * **A phase is a row whose values are its tasks'**: its duration is their sum,
 * its start the earliest, and it is done when they all are. So on a phase's row
 * those cells are shut with `SetEditable` -- drawn dim, opening nothing --
 * while the same columns are fields on every task. Its name is still its own.
 *
 * Saving writes `plan.json` in `Application.ConfigDirectory`, and the plan is
 * read back from there on the next start. `EndEdit()` first, so a field still
 * open when Save is clicked is in what is written.
 */
"use strict";

const COL = { Name: 0, Days: 1, Start: 2, Done: 3, Calendar: 4, Notes: 5 };

/* The cells a phase's row takes from its tasks. */
const DERIVED = [COL.Days, COL.Start, COL.Done, COL.Calendar, COL.Notes];

const SAMPLE = {
    Calendars: ["Standard", "Night shift", "24 hours"],
    Phases: [
        { Name: "Design", Tasks: [
            { Name: "Requirements", Days: 3, Start: "2026-11-02", Done: true,  Calendar: "Standard", Notes: "" },
            { Name: "Mock-ups",     Days: 5, Start: "2026-11-05", Done: false, Calendar: "Standard", Notes: "Two rounds" },
        ] },
        { Name: "Build", Tasks: [
            { Name: "Database",     Days: 4, Start: "2026-11-12", Done: false, Calendar: "Standard",    Notes: "" },
            { Name: "Screens",      Days: 8, Start: "2026-11-16", Done: false, Calendar: "Night shift", Notes: "" },
            { Name: "Data import",  Days: 2, Start: "2026-11-26", Done: false, Calendar: "24 hours",    Notes: "Needs the old system's export" },
        ] },
    ],
};

class PlanForm extends Form {
    plan  = null;
    nodes = {};        /* key -> { phase } or { phase, task } */
    next  = 1;

    Form_Open() {
        this.plan = this.read();
        this.fill();
    }

    /* ------------------------------------------------------------ the rows */

    read() {
        const path = this.path();
        if (File.Exists(path)) {
            try { return File.LoadJson(path); }
            catch (e) { this.say(`${path} could not be read, so the sample is shown`); }
        }
        return JSON.parse(JSON.stringify(SAMPLE));
    }

    path() {
        return File.Join(Application.ConfigDirectory, "plan.json");
    }

    fill() {
        this.Sheet.Clear();
        this.nodes = {};
        for (const phase of this.plan.Phases) {
            const key = this.key();

            this.nodes[key] = { phase };
            this.Sheet.Add([phase.Name, "", "", "", "", ""], { Key: key });
            for (const column of DERIVED)
                this.Sheet.SetEditable(key, column, false);
            for (const task of phase.Tasks)
                this.addTask(key, task);
            this.total(key);
        }
    }

    key() {
        return `n${this.next++}`;
    }

    addTask(parent, task) {
        const key = this.key();

        this.nodes[key] = { phase: this.nodes[parent].phase, task, parent };
        this.Sheet.Add([task.Name, `${task.Days}d`, task.Start,
                        task.Done ? "Yes" : "No", task.Calendar, task.Notes],
                       { Key: key, Parent: parent });
        return key;
    }

    /* A phase's row says what its tasks add up to. */
    total(key) {
        const tasks = this.nodes[key].phase.Tasks;
        const days  = tasks.reduce((sum, t) => sum + t.Days, 0);
        const start = tasks.map(t => t.Start).filter(s => s).sort()[0] || "";
        const done  = tasks.length > 0 && tasks.every(t => t.Done);

        this.Sheet.SetCell(key, COL.Days, `${days}d`);
        this.Sheet.SetCell(key, COL.Start, start);
        this.Sheet.SetCell(key, COL.Done, done ? "Yes" : "No");
    }

    /* ----------------------------------------------------------- the edits */

    /*
     * Asked as an edit begins. The calendars are the plan's, so the column
     * declares no items and each edit is handed the list; and a note is
     * written in a dialog, since a line in a cell is too small for one.
     */
    Sheet_CellEditor(key, column) {
        const node = this.nodes[key];

        if (column === COL.Calendar)
            return { Items: this.plan.Calendars };

        if (column === COL.Notes) {
            AskText.Prompt(`Notes for "${node.task.Name}":`, (text) => {
                node.task.Notes = text;
                this.Sheet.SetCell(key, COL.Notes, text);
                this.say(`Notes of "${node.task.Name}" changed`);
            }, { Title: "Notes", Initial: node.task.Notes });
        }
    }

    /*
     * Asked when an edit ends with a different text. `false` puts the cell
     * back; a string is what the cell keeps instead of what was typed.
     */
    Sheet_CellEdit(key, column, text) {
        const node = this.nodes[key];

        if (!node.task) {                                   /* a phase: its name */
            if (!text.trim())
                return this.refuse("A phase needs a name");
            node.phase.Name = text.trim();
            return node.phase.Name;
        }

        const task = node.task;

        switch (column) {
        case COL.Name:
            if (!text.trim())
                return this.refuse("A task needs a name");
            task.Name = text.trim();
            this.say(`Renamed to "${task.Name}"`);
            return task.Name;

        case COL.Days:
            task.Days = Number(text);
            this.total(node.parent);
            this.say(`"${task.Name}" takes ${task.Days} days`);
            return `${task.Days}d`;

        case COL.Start:
            /* A day picked in the calendar arrives as YYYY-MM-DD; a typed
             * one is whatever was typed, so it is checked here. */
            if (text && !this.isDate(text))
                return this.refuse(`"${text}" is not a date: write it as 2026-11-30`);
            task.Start = text;
            this.total(node.parent);
            this.say(`"${task.Name}" starts on ${text || "no date"}`);
            return text;

        case COL.Done:
            task.Done = text === "Yes";
            this.total(node.parent);
            this.say(`"${task.Name}" is ${task.Done ? "done" : "not done"}`);
            return text;

        case COL.Calendar:
            task.Calendar = text;
            this.say(`"${task.Name}" follows the ${text} calendar`);
            return text;
        }
    }

    isDate(text) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
        if (!m)
            return false;
        const month = Number(m[2]), day = Number(m[3]);
        return month >= 1 && month <= 12 && day >= 1 && day <= 31;
    }

    refuse(why) {
        this.say(why);
        return false;
    }

    say(text) {
        this.Status.Text = text;
    }

    /* --------------------------------------------------------- the buttons */

    /* A task goes under the selected phase, or the selected task's, and its
     * name is opened for typing at once: `EditCell` is the click, from code. */
    BtnAdd_Click() {
        const at = this.nodes[this.Sheet.Key];

        if (!at)
            return this.say("Select a phase or a task first");

        const parent = at.task ? at.parent : this.Sheet.Key;
        const task   = { Name: "New task", Days: 1, Start: "", Done: false,
                         Calendar: this.plan.Calendars[0], Notes: "" };

        this.nodes[parent].phase.Tasks.push(task);
        const key = this.addTask(parent, task);
        this.total(parent);
        this.Sheet.Key = key;

        /* The row is drawn on GTK's next frame, and a cell that is not on
         * screen has no editor to open: ask until it is. */
        let tries = 20;
        const open = () => {
            if (!this.Sheet.EditCell(key, COL.Name) && --tries > 0)
                Timer.After(20, open);
        };
        open();
    }

    BtnRemove_Click() {
        const key  = this.Sheet.Key;
        const node = this.nodes[key];

        if (!node || !node.task)
            return this.say("Select a task to remove");

        const tasks = node.phase.Tasks;
        tasks.splice(tasks.indexOf(node.task), 1);
        delete this.nodes[key];
        this.Sheet.RemoveNode(key);
        this.total(node.parent);
        this.say(`"${node.task.Name}" removed`);
    }

    BtnSave_Click() {
        this.Sheet.EndEdit();                     /* a field still open counts */
        File.SaveJson(this.path(), this.plan);
        this.say(`Saved in ${this.path()}`);
    }
}
