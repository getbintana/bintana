/*
 * How fast the interpreter is, measured the way Gambas measures itself.
 *
 *   tests/bench.sh                    every program, best of three
 *   tests/bench.sh nbody primes       those two
 *   tests/bench.sh --runs 5           best of five
 *
 * **Each run is a process of its own**, as in Gambas's `benchmark.gbs`: one
 * program's garbage, heap shape and caches cannot reach the next, and the
 * child is this same project started with `--child <name>`, so the binary
 * measured is whichever one runs this -- `BINTANA=<other build>` compares two.
 * The child times the program alone, not the start-up, and says what it
 * answered; a run whose answer is wrong is a failure, never a time.
 *
 * **The best of N and not the mean**: everything else on the machine only
 * ever adds to a run, so the fastest one is the closest to the interpreter's
 * own cost. The spread is printed beside it so a noisy machine shows itself.
 *
 * Not part of `tests/run.sh`: a timing is not an assertion, and the suite's
 * green has to mean the same thing on a loaded runner as on an idle desk.
 */

function child(name) {
    const p = PROGRAMS[name];
    const t = Date.now();
    const answer = p.run();
    print(`${Date.now() - t} ${answer}`);
    Application.Quit(0);
}

function pad(text, width) {
    text = String(text);
    return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function Main() {
    const args = Application.Arguments;
    if (args[0] === "--child") return child(args[1]);

    let runs = 3;
    const names = [];
    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--runs") runs = Math.max(1, Number(args[++i]) || 1);
        else if (args[i] in PROGRAMS) names.push(args[i]);
        else {
            print(`bench: no program '${args[i]}' -- there are ${Dictionary.Keys(PROGRAMS).join(", ")}`);
            Application.Quit(2);
            return;
        }
    }
    if (!names.length) names.push(...Dictionary.Keys(PROGRAMS));

    print(`bench: ${Application.Executable}, best of ${runs}`);
    let failed = 0, total = 0;

    for (const name of names) {
        const times = [];
        let wrong = null;

        for (let r = 0; r < runs && !wrong; r++) {
            const res = Exec.Wait([Application.Executable, Application.Directory,
                                   "--child", name]);
            const line = res.Output.trim().split("\n").pop();
            const space = line.indexOf(" ");
            const ms = Number(line.slice(0, space));
            const answer = line.slice(space + 1);

            if (res.ExitCode !== 0 || space < 0 || !(ms >= 0))
                wrong = `exited ${res.ExitCode}: ${res.Output.trim().slice(-200)}`;
            else if (answer !== String(PROGRAMS[name].answer))
                wrong = `answered ${answer}, expected ${PROGRAMS[name].answer}`;
            else
                times.push(ms);
        }

        if (wrong) {
            failed++;
            print(`  ${name.padEnd(12)} FAIL  ${wrong}`);
            continue;
        }
        const best = Math.min(...times), worst = Math.max(...times);
        total += best;
        print(`  ${name.padEnd(12)}${pad(best, 7)} ms` +
              (runs > 1 ? `   (+${worst - best})` : ""));
    }

    print(failed ? `bench: ${failed} wrong` : `bench: ${total} ms in all`);
    Application.Quit(failed ? 1 : 0);
}
