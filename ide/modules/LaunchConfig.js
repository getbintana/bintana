/*
 * How a project is run, as a shape rather than as a bag of keys.
 *
 * `Run` was `Exec([Application.Executable, ide.project], { Directory })` and
 * nothing else: no arguments, no environment, no choice of where to start. A
 * project that needs `--data ~/facturas` to run at all could not be run from
 * this IDE, and the only way to say *run this one strictly* was a tick that
 * applied to every project at once.
 *
 * A launch configuration is that, named, and written down in `project.json`
 * beside the rest of what a project is.
 *
 * **Copied at creation, not inherited at read**, which is the decision this
 * shape exists to carry out. `Settings` holds a *suggestion* -- which switches a
 * new configuration should start with -- and `Ide.Launch.make` copies it in,
 * which is the only place it is read at all. From then on the value is the
 * configuration's own, and changing the suggestion changes nothing that already
 * exists.
 *
 * That is `git init`'s pattern and not `git config`'s, and both are worth having
 * in mind because git has both: `init.defaultBranch` seeds a new repository and
 * never renames anybody's branch, while `--global`/`--local` resolve every time
 * they are read. `/etc/skel` is the same bargain for a new Unix account.
 *
 * What it buys is the property that matters for a file the whole team reads:
 * **what will run is written here, whole.** Nothing depends on the machine of
 * whoever opens it. And it is what lets every field below be an ordinary one --
 * a cascade would need each of them to be able to say *nothing*, and
 * `Field.Bool` is `{ def: false }`: a record always says something.
 */
"use strict";

Namespace("Ide");

/* `NAME=value`, which is how a shell, a `.env` file, systemd's `Environment=`
 * and `docker --env` all spell it. The name is an identifier because that is
 * what an environment variable may be. */
const ENV_LINE = new Regex("^[A-Za-z_][A-Za-z0-9_]*=");

Ide.LaunchConfig = class LaunchConfig extends Record {
    static Naming = "lower";

    static Fields = {
        /* What the menu shows. Required, because choosing between configurations
         * is the whole point and an unnamed one cannot be chosen. */
        Name: Field.Text({ required: true, max: 60 }),

        /*
         * Handed to the project as `Application.Arguments`, after the project
         * directory. One entry per argument and not one string to split: a path
         * with a space in it is ordinary, and splitting would be this IDE
         * inventing a quoting rule the runtime does not have.
         */
        Arguments: Field.List(Field.Text()),

        /*
         * Where the child starts. Empty means the project's own directory, which
         * is what Run always did and what most projects want -- so the ordinary
         * configuration leaves this alone.
         */
        Directory: Field.Text({ max: 240 }),

        /*
         * Names to add or change, `NAME=value` a line. `Exec` takes a change and
         * not a replacement, so what is not named here is inherited from the
         * IDE's own environment -- which is the only sane default: a child that
         * lost `HOME` and `DISPLAY` would not start.
         *
         * Removing a variable is not expressible. `Exec` can (a `null` value),
         * and no shape for it reads well in a list of strings; the case has not
         * come up and inventing a spelling for it before it does is how a format
         * grows a corner nobody uses.
         */
        Environment: Field.List(Field.Text()),

        /*
         * The two switches. Copied from the suggestion in `Settings` when the
         * configuration is made, and the configuration's own afterwards.
         *
         * `Strict` is `bintana --strict`: a control refuses a property its class
         * does not have. `StopOnThrow` is the debugger's, and it had nowhere to
         * live before this -- it was a live command with no memory, so it came
         * up off in every session however often you turned it on.
         */
        Strict:      Field.Bool(),
        StopOnThrow: Field.Bool(),
    };

    /*
     * The rule no field can state, because a `Field.List(Field.Text())` can only
     * speak about each string and not about what the string means.
     */
    Validate() {
        const out = super.Validate();

        for (const line of this.Environment) {
            if (!ENV_LINE.IsMatch(line))
                out.push(`environment: "${line}" is not NAME=value`);
        }
        return out;
    }

    /* What `Exec` takes, which is an object and not a list. Later wins, the way
     * a shell's own `A=1 A=2` does. */
    get Variables() {
        const out = {};

        for (const line of this.Environment) {
            const at = line.indexOf("=");
            if (at > 0) out[line.slice(0, at)] = line.slice(at + 1);
        }
        return out;
    }
};
