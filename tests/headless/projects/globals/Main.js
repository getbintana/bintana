"use strict";

/*
 * The globals a console program is written with, asked the same way under
 * `bintana` and `bintana-gui`; `tests/headless.sh` diffs the two outputs.
 * Nothing here quits by hand: the run ends when the server, the request and
 * the task have nothing left to answer, which is the core's loop being
 * asked whether anything is still owed.
 */
const dir = File.Join(Environment.TempDirectory,
                      `bta-globals-${Random.Uuid()}`);

function language() {
    print(`types: ${[Http, Database, Task, Zip, Gzip, Random, Cipher, Socket,
                     Keyring, Lock, Cancellable, Profile, Message, Desktop]
                    .map((g) => typeof g).join(" ")}`);
    print(`hatches: Object.keys ${typeof Object.keys}, eval ${typeof eval}`);
    const logged = [];
    Logger.Handler = (level, text) => { logged.push(`${level}:${text}`); return true; };
    Logger.Debug("below the floor");
    Logger.Info("at the floor");
    Logger.Handler = null;
    print(`Logger: ${Logger.Level} ${Logger.Target} [${logged.join(" ")}]`);
    try {
        setTimeout(() => 0, 1);
    } catch (e) {
        print(`setTimeout: ${e.message}`);
    }
    try {
        File.Load(File.Join(dir, "missing"));
    } catch (e) {
        print(`File.Load: ${e.message.replace(dir, "<dir>")}`);
    }
}

function data() {
    print(`Random.Bytes: ${Random.Bytes(16).Length}`);

    const text = "a line that repeats. ".repeat(50);
    const packed = Gzip.Compress(new Bytes(text));
    print(`Gzip: ${packed.Length < text.length}, ${Gzip.Decompress(packed).ToText() === text}`);

    Directory.Make(dir);
    const path = File.Join(dir, "two.zip");
    Zip.Create(path).Add("a.txt", "first").Add("b.txt", "second").Finish();
    const zip = Zip.Open(path);
    print(`Zip: ${zip.Read("b.txt").ToText()}`);
    zip.Close();

    const db = Database.Sqlite(":memory:");
    db.Execute("create table t (n integer)");
    db.Execute("insert into t values (41)");
    print(`Sqlite: ${db.Query("select n + 1 as m from t")[0].m}`);
    db.Close();

    let held = false;
    Lock.Hold("globals", () => { held = true; });
    print(`Lock: ${held}`);
    Message.Info("a message from {0}", "main");
}

function later() {
    const srv = Http.Server({ Host: "local", Port: 0 });
    srv.Request = (req) => req.Answer(200, `got ${req.Method}`);
    srv.Start();
    Http.Get(`${srv.Url}ping`, { Timeout: 5000 }, (r) => {
        print(`Http: ${r.Status} ${r.Body.ToText()}`);
        srv.Stop();
        /* After the answer, so the two lines come in one order: the task's
         * thread would otherwise race the request. */
        const t = new Square();
        t.Done  = (v) => print(`Task: ${v.square} [${v.args}]`);
        t.Error = (err) => print(`Task failed: ${err}`);
        t.Start(12);
    });
}

function Main() {
    try {
        language();
        data();
        later();
    } finally {
        Timer.After(0, () => Directory.DeleteTree(dir));
    }
}
