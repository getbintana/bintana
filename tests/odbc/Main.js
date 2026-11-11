/*
 * Database.Odbc through real drivers -- docs/plans/odbc-plan.md.
 *
 *   tests/odbc.sh          writes its own odbcinst.ini and odbc.ini, points
 *                          ODBCSYSINI and ODBCINI at them, and runs this
 *
 * The script hands over, in the environment:
 *
 *   BINTANA_ODBC_DIR       a scratch directory, the databases' home
 *   BINTANA_ODBC_SQLITE    the name of the sqliteodbc driver in its ini
 *   BINTANA_ODBC_DSN       a DSN over sqliteodbc, defined in its odbc.ini
 *   BINTANA_ODBC_PG        a PostgreSQL connection string with no
 *                          credentials, when a server is up, and
 *   BINTANA_ODBC_PG_PASSWORD  its password (with a `;` and a `}` in it)
 *
 * A console project: what is under test is the driver manager, and no GTK
 * call is on its road. The driver's messages are the driver's and come
 * translated, so every check on a failure reads `Code`, never the text.
 */

let checks = 0;
let fails  = 0;

function ok(name, note) {
    checks++;
    print("  ok    " + name + (note ? " -- " + note : ""));
}
function fail(name, why) {
    checks++;
    fails++;
    print("  FAIL  " + name + " -- " + why);
}
function check(name, cond, why) {
    if (cond) ok(name);
    else      fail(name, why || "false");
}
function refused(name, fn, type) {
    try {
        fn();
        fail(name, "no refusal");
    } catch (e) {
        if (type && !(e instanceof type))
            fail(name, `${e.constructor.name}, not ${type.name}: ${e.message}`);
        else
            ok(name, e.message.slice(0, 72));
    }
}
/* The error a failing call throws, or null. */
function caught(fn) {
    try { fn(); } catch (e) { return e; }
    return null;
}

let pending = 0;
function finish() {
    if (pending > 0) return;
    print(`${checks - fails} passed, ${fails} failed`);
    Application.Quit(fails ? 1 : 0);
}

function Main() {
    const dir    = Environment.Get("BINTANA_ODBC_DIR");
    const sqlite = Environment.Get("BINTANA_ODBC_SQLITE");
    const dsn    = Environment.Get("BINTANA_ODBC_DSN");

    check("Database.Odbc is a function", typeof Database.Odbc === "function");

    /* A build without a driver manager: the name, and the package. */
    const none = caught(() => Database.Odbc("DSN=x"));
    if (none && none.message.includes("built without ODBC")) {
        print("ODBC=absent");
        ok("a build without ODBC says which package", none.message.slice(0, 72));
        finish();
        return;
    }
    print("ODBC=present");

    refused("no argument", () => Database.Odbc(), TypeError);
    refused("a number is not a connection string", () => Database.Odbc(5), TypeError);
    refused("a blank string", () => Database.Odbc("   "), TypeError);
    refused("a NUL inside the string", () => Database.Odbc("DSN=a\0b"), TypeError);
    refused("an option that is not one", () => Database.Odbc("DSN=x", { Pasword: "a" }), TypeError);
    refused("options that are not an object", () => Database.Odbc("DSN=x", 3), TypeError);
    refused("User both in the options and the string",
            () => Database.Odbc("DSN=x; uid = a", { User: "b" }), TypeError);
    refused("Password both in the options and the string",
            () => Database.Odbc("DSN=x;Password=a", { Password: "b" }), TypeError);
    refused("a User that is not a string", () => Database.Odbc("DSN=x", { User: 1 }), TypeError);
    for (const t of [0, -1, NaN, Infinity, "soon"])
        refused(`Timeout ${String(t)}`, () => Database.Odbc("DSN=x", { Timeout: t }));

    /* The driver manager's own refusal, with its SQLSTATE: the same on the
     * three platforms. */
    const e = caught(() => Database.Odbc("DSN=bintana-test-no-such-dsn"));
    check("a DSN that is not there throws", e !== null);
    if (e) {
        check("...with the SQLSTATE IM002", e.Code === "IM002", e.Code);
        check("...a Native number", typeof e.Native === "number", typeof e.Native);
        check("...Details, an array", Array.isArray(e.Details), typeof e.Details);
        check("...and says what it was doing",
              e.message.startsWith("Database.Odbc: cannot connect: "), e.message);
    }

    if (!sqlite) {
        fail("sqliteodbc", "the script found no driver -- run tests/odbc.sh");
        finish();
        return;
    }

    /* The text layer: a path with an ñ and a euro goes through the
     * connection string, and the file the driver makes has that name. */
    const path = File.Join(dir, "año €.db");
    const db = Database.Odbc(`Driver=${sqlite};Database=${path}`);
    check("connects through sqliteodbc", db.Open);
    check("Dbms names the engine", db.Dbms === "SQLite", db.Dbms);
    check("DbmsVersion is the engine's", db.DbmsVersion.length > 0 && "0123456789".includes(db.DbmsVersion.charAt(0)), db.DbmsVersion);
    check("Driver is the driver's file", db.Driver.includes("sqlite3odbc"), db.Driver);
    check("an OdbcConnection is a Connection", db instanceof Connection);
    check("the path's ñ and € reach the driver intact", File.Exists(path),
          Directory.Files(dir, "*.db").join(", "));
    db.Close();
    check("Close closes", !db.Open);
    db.Close();
    ok("Close twice is not an error");
    check("Dbms still answers after Close", db.Dbms === "SQLite", db.Dbms);

    /* `PWD=` inside braces is a value, not a key: the refusal above must not
     * fire on it. sqliteodbc ignores a key it does not know. */
    const braced = caught(() => Database.Odbc(
        `Driver=${sqlite};Database=${File.Join(dir, "b.db")};Note={x;PWD=y}`,
        { Password: "z" }).Close());
    check("a PWD inside braces is not a second Password", braced === null,
          braced && braced.message);

    /* A DSN from the script's own odbc.ini, credentials that need braces, and
     * a timeout under a second -- each a road through the string builder. */
    const viaDsn = caught(() => {
        const d = Database.Odbc(`DSN=${dsn}`,
                                { User: " a}b;c ", Password: "p;w}", Timeout: 500 });
        check("a DSN connects, with credentials that need braces", d.Open);
        d.Close();
    });
    check("...and nothing threw", viaDsn === null, viaDsn && viaDsn.message);

    /* A connection never closed is the finaliser's: it must not crash the
     * runtime's teardown. */
    Database.Odbc(`Driver=${sqlite};Database=${File.Join(dir, "c.db")}`);
    ok("a connection left open is left to the finaliser");

    postgres();

    /* And in a worker, which has its own registration. */
    pending++;
    const t = new OdbcWork();
    t.Done  = (v) => { pending--; check("a Task opens its own connection", v === "SQLite", v); finish(); };
    t.Error = (err) => { pending--; fail("a Task opens its own connection", String(err)); finish(); };
    t.Start({ cs: `Driver=${sqlite};Database=${File.Join(dir, "task.db")}` });
}

function postgres() {
    const cs = Environment.Get("BINTANA_ODBC_PG");
    const pw = Environment.Get("BINTANA_ODBC_PG_PASSWORD");
    if (!cs) {
        print("  skip  PostgreSQL -- tests/odbc.sh found no server");
        return;
    }
    const wrong = caught(() => Database.Odbc(cs, { User: "postgres", Password: "wrong" }));
    check("a wrong password is refused", wrong !== null);
    if (wrong)
        check("...with 08001", wrong.Code === "08001", wrong.Code);

    const pg = caught(() => {
        const db = Database.Odbc(cs, { User: "postgres", Password: pw, Timeout: 10000 });
        check("a password with ; and } connects", db.Open);
        check("Dbms is PostgreSQL", db.Dbms === "PostgreSQL", db.Dbms);
        check("Driver is psqlODBC's", db.Driver.toLowerCase().includes("psqlodbc"), db.Driver);
        db.Close();
    });
    check("...and nothing threw", pg === null, pg && pg.message);

    const port = caught(() => Database.Odbc(cs.split(";").map((p) => p.startsWith("Port=") ? "Port=1" : p).join(";"),
                                            { User: "postgres", Password: pw, Timeout: 3000 }));
    check("a closed port is refused", port !== null && port.Code === "08001",
          port ? port.Code : "it connected");
}
