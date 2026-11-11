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

    statements(sqlite, dir);
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

    postgresStatements(cs, pw);
}

/* The run of one block, as a check: an exception is a failure with its
 * message, and the block's own checks are counted inside it. */
function block(name, fn) {
    const e = caught(fn);
    if (e)
        fail(name, `${e.message} Code=${e.Code}`);
}

/* Bytes as hex, for a message. */
function hex(b) {
    return b && b.ToHex ? b.ToHex() : String(b);
}

/*
 * Stage 1 through sqliteodbc: statements, parameters and every type the
 * driver describes. What is sqlite's and not ODBC's (no exact decimal, one
 * statement per call) is left to the PostgreSQL half.
 */
function statements(sqlite, dir) {
    refused("StatementTimeout 0", () => Database.Odbc("DSN=x", { StatementTimeout: 0 }), RangeError);

    const db = Database.Odbc(`Driver=${sqlite};Database=${File.Join(dir, "s.db")}`,
                             { StatementTimeout: 5000 });
    refused("Query with no statement", () => db.Query(), TypeError);
    refused("Execute with a number", () => db.Execute(5), TypeError);

    block("sqlite statements", () => {
        db.Execute("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, n INTEGER, " +
                   "r REAL, ok BOOLEAN, d DATE, ts TIMESTAMP, b BLOB)");
        const blob = new Bytes([0, 255, 1, 0]);
        let done = db.Execute("INSERT INTO t (id, name, n, r, ok, d, ts, b) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                              [1, "Año ñandú € 𝄞", 1099511627776, 1.5, true, "2026-11-11",
                               "2026-11-11 10:20:30", blob]);
        check("Execute answers Changes", done.Changes === 1, JSON.stringify(done));
        db.Execute("INSERT INTO t (id, name) VALUES (?, ?)", [2, null]);

        const rows = db.Query("SELECT * FROM t ORDER BY id");
        check("Query answers the rows", rows.length === 2, rows.length);
        const r = rows[0];
        check("text with ñ, € and a 4-byte character round-trips", r.name === "Año ñandú € 𝄞", r.name);
        check("a whole number past 2^31 is itself", r.n === 1099511627776, r.n);
        check("a REAL is a number", r.r === 1.5, r.r);
        check("a BOOLEAN is a boolean", r.ok === true, r.ok);
        check("a DATE is YYYY-MM-DD", r.d === "2026-11-11", r.d);
        check("a TIMESTAMP is YYYY-MM-DDTHH:MM:SS", r.ts === "2026-11-11T10:20:30", r.ts);
        check("a BLOB is Bytes, NULs and all", r.b instanceof Bytes && r.b.Equals(blob), hex(r.b));
        check("NULL is null", rows[1].name === null && rows[1].n === null, JSON.stringify(rows[1]));

        /* Past the 8 KiB a read takes at a time: the parts are joined, and a
         * multi-byte character cut between two parts is whole again. */
        const long = "ñ".repeat(9000) + "end";
        const big = Bytes.FromHex("00ff".repeat(10000));
        db.Execute("INSERT INTO t (id, name, b) VALUES (?, ?, ?)", [3, long, big]);
        const back = db.Query("SELECT name, b FROM t WHERE id = ?", [3])[0];
        check("text longer than one read comes back whole", back.name === long,
              `${back.name.length} characters`);
        check("bytes longer than one read come back whole", back.b.Equals(big),
              `${back.b.Length} bytes`);

        done = db.Execute("UPDATE t SET name = ? WHERE id = ?", ["x", 99]);
        check("an UPDATE that matched nothing is Changes 0, not an error", done.Changes === 0,
              JSON.stringify(done));
        check("a statement with no rows answers []",
              db.Query("DELETE FROM t WHERE id = 99").length === 0);

        refused("too few parameters", () => db.Query("SELECT * FROM t WHERE id = ? AND n = ?", [1]),
                RangeError);
        const before = db.Query("SELECT count(*) AS c FROM t")[0].c;
        refused("an object is not a parameter",
                () => db.Execute("INSERT INTO t (id, name) VALUES (?, ?)", [4, { a: 1 }]), TypeError);
        refused("parameters that are not a list", () => db.Query("SELECT ?", "a"), TypeError);
        check("...and a refused parameter ran nothing",
              db.Query("SELECT count(*) AS c FROM t")[0].c === before);

        const bad = caught(() => db.Query("SELECT nope FROM t"));
        check("an error from the driver carries a Code", bad !== null && typeof bad.Code === "string"
              && bad.Code.length === 5, bad && bad.Code);

        db.Script("CREATE TABLE u (a INTEGER)");
        check("Script runs a statement", db.Query("SELECT count(*) AS c FROM u")[0].c === 0);
    });

    block("sqlite Each", () => eachChecks(db, "sqlite"));
    block("sqlite Transaction", () => transactionChecks(db, "sqlite"));
    block("Close inside a Transaction", () => {
        const path2 = File.Join(dir, "close.db");
        const d2 = Database.Odbc(`Driver=${sqlite};Database=${path2}`);
        d2.Execute("CREATE TABLE z (a INTEGER)");
        refused("Close inside its own Transaction says there was nothing to commit",
                () => d2.Transaction(() => { d2.Execute("INSERT INTO z (a) VALUES (1)"); d2.Close(); }),
                TypeError);
        check("...and the connection is closed", !d2.Open);
        /* sqliteodbc refuses to disconnect inside a transaction and keeps the
         * connection -- and its write lock. A write from a new connection,
         * with a short busy timeout, is what tells a rollback from a leak. */
        const d3 = Database.Odbc(`Driver=${sqlite};Database=${path2};Timeout=300`);
        const locked = caught(() => d3.Execute("INSERT INTO z (a) VALUES (2)"));
        check("...rolled back and let go: another connection can write", locked === null,
              locked && locked.message);
        check("...and the insert inside it is gone",
              d3.Query("SELECT count(*) AS c FROM z")[0].c === 1);
        d3.Close();
    });

    db.Close();
    refused("Query after Close", () => db.Query("SELECT 1"), TypeError);
}

/*
 * Stage 1 through psqlODBC: what sqlite cannot show -- an exact NUMERIC,
 * real SQLSTATEs, a batch, RETURNING, a timestamp with a fraction.
 */
function postgresStatements(cs, pw) {
    const db = Database.Odbc(cs, { User: "postgres", Password: pw });
    block("postgres statements", () => {
        db.Script("DROP TABLE IF EXISTS t; " +
                  "CREATE TABLE t (id INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, " +
                  "name TEXT, price NUMERIC(12,2), ok BOOLEAN, d DATE, tm TIME, " +
                  "ts TIMESTAMP, b BYTEA, big BIGINT)");
        ok("Script runs a batch");

        const blob = new Bytes([0, 255, 0]);
        const ins = db.Query("INSERT INTO t (name, price, ok, d, tm, ts, b, big) " +
                             "VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
                             ["Año ñandú € 𝄞", new Decimal("12.30", 2), true, "2026-11-11",
                              "10:20:30", "2026-11-11 10:20:30.25", blob, 1099511627776]);
        check("INSERT … RETURNING through Query answers the key",
              ins.length === 1 && ins[0].id === 1, JSON.stringify(ins));

        const r = db.Query("SELECT * FROM t WHERE id = ?", [1])[0];
        check("text round-trips", r.name === "Año ñandú € 𝄞", r.name);
        check("NUMERIC is the server's text, exactly", r.price === "12.30", r.price);
        check("boolean is psqlODBC's \"1\" unless BoolsAsChar=0", r.ok === "1", JSON.stringify(r.ok));
        check("DATE", r.d === "2026-11-11", r.d);
        check("TIME", r.tm === "10:20:30", r.tm);
        check("a TIMESTAMP keeps its fraction", r.ts === "2026-11-11T10:20:30.25", r.ts);
        check("BYTEA is Bytes with its NULs", r.b instanceof Bytes && r.b.Equals(blob), hex(r.b));
        check("BIGINT", r.big === 1099511627776, r.big);

        const exact = db.Query("SELECT CAST(? AS NUMERIC(12,2)) + 0.01 AS n",
                               [new Decimal("99999999.99", 2)])[0].n;
        check("a Decimal parameter never passes through a double", exact === "100000000.00", exact);
        const half = db.Query("SELECT CAST(? AS NUMERIC(6,2)) AS n, CAST(? AS FLOAT8) AS f", [1.5, 2.25])[0];
        check("a number parameter is written with a point, whatever the desktop's locale",
              half.n === "1.50" && half.f === 2.25, JSON.stringify(half));

        check("an UPDATE that matched nothing is Changes 0",
              db.Execute("UPDATE t SET name = 'x' WHERE id = 99").Changes === 0);
        check("an UPDATE answers how many",
              db.Execute("UPDATE t SET name = name WHERE id = ?", [1]).Changes === 1);

        const missing = caught(() => db.Query("SELECT nope FROM t"));
        check("a missing column is 42703", missing && missing.Code === "42703", missing && missing.Code);
        const zero = caught(() => db.Query("SELECT 1 / 0"));
        check("a division by zero is 22012", zero && zero.Code === "22012", zero && zero.Code);

        const batch = caught(() => db.Script("INSERT INTO t (name) VALUES ('a'); " +
                                             "INSERT INTO nope VALUES (1); " +
                                             "INSERT INTO t (name) VALUES ('b')"));
        check("a batch with a failing statement throws", batch !== null);
        check("...and psqlODBC undid the statements before it",
              db.Query("SELECT count(*) AS c FROM t")[0].c === 1);
    });
    block("postgres Each", () => eachChecks(db, "postgres"));
    block("postgres Transaction", () => transactionChecks(db, "postgres"));
    block("postgres statement-level rollback", () => {
        db.Execute("DELETE FROM w");
        db.Transaction(() => {
            db.Execute("INSERT INTO w (a) VALUES (1)");
            caught(() => db.Query("SELECT nope FROM w"));
            db.Execute("INSERT INTO w (a) VALUES (2)");
        });
        check("psqlODBC: an error caught inside a transaction undoes only its statement",
              db.Query("SELECT count(*) AS c FROM w")[0].c === 2);
    });
    db.Close();

    block("BoolsAsChar=0", () => {
        const b = Database.Odbc(cs + ";BoolsAsChar=0", { User: "postgres", Password: pw });
        const v = b.Query("SELECT true AS yes, false AS no, NULL::boolean AS none")[0];
        check("with BoolsAsChar=0 a boolean is a boolean",
              v.yes === true && v.no === false && v.none === null, JSON.stringify(v));
        b.Close();
    });

    block("StatementTimeout", () => {
        const s = Database.Odbc(cs, { User: "postgres", Password: pw, StatementTimeout: 1000 });
        const started = Date.now();
        const e = caught(() => s.Query("SELECT pg_sleep(5)"));
        const took = Date.now() - started;
        check("StatementTimeout stops a long statement", e !== null && took < 4000,
              `${took} ms, ${e ? e.Code + " " + e.message : "no error"}`);
        s.Close();
    });
}

/* Each, on either driver: one row at a time, `false` stops, a throw is the
 * caller's, `Close` inside is refused. */
function eachChecks(db, who) {
    db.Script("DROP TABLE IF EXISTS w");
    db.Script("CREATE TABLE w (a INTEGER)");
    db.Transaction(() => {
        for (let i = 0; i < 2000; i++)
            db.Execute("INSERT INTO w (a) VALUES (?)", [i]);
    });

    let sum = 0, order = true, last = -1;
    const n = db.Each("SELECT a FROM w ORDER BY a", (row) => {
        sum += row.a;
        if (row.a !== last + 1) order = false;
        last = row.a;
    });
    check(`${who}: Each hands over every row`, n === 2000 && sum === 1999 * 2000 / 2, `${n} rows, sum ${sum}`);
    check(`${who}: ...in order`, order);

    const some = db.Each("SELECT a FROM w WHERE a < ? ORDER BY a", [10], (row) => row.a < 4);
    check(`${who}: false stops, and the count is what was handed over`, some === 5, some);
    check(`${who}: no rows is 0`, db.Each("SELECT a FROM w WHERE a < 0", () => {}) === 0);

    const thrown = caught(() => db.Each("SELECT a FROM w", () => { throw new Error("from fn"); }));
    check(`${who}: a throw in fn is the caller's`, thrown && thrown.message === "from fn",
          thrown && thrown.message);
    refused(`${who}: Close inside Each`, () => db.Each("SELECT a FROM w", () => { db.Close(); }), TypeError);
    check(`${who}: ...and the connection is still open`, db.Open);
    check(`${who}: the connection works after all of that`,
          db.Query("SELECT count(*) AS c FROM w")[0].c === 2000);
    refused(`${who}: Each without fn`, () => db.Each("SELECT 1"), TypeError);
}

/* Transaction, on either driver: commit, rollback with the error kept, the
 * value of fn, nesting through savepoints. */
function transactionChecks(db, who) {
    db.Execute("DELETE FROM w");
    const count = () => db.Query("SELECT count(*) AS c FROM w")[0].c;

    const v = db.Transaction(() => { db.Execute("INSERT INTO w (a) VALUES (1)"); return 42; });
    check(`${who}: Transaction answers what fn returns`, v === 42, v);
    check(`${who}: ...and committed`, count() === 1);

    const e = caught(() => db.Transaction(() => {
        db.Execute("INSERT INTO w (a) VALUES (2)");
        throw new Error("undo it");
    }));
    check(`${who}: a throw is rethrown as it was`, e && e.message === "undo it", e && e.message);
    check(`${who}: ...and rolled back`, count() === 1, count());

    db.Transaction(() => {
        db.Execute("INSERT INTO w (a) VALUES (3)");
        caught(() => db.Transaction(() => {
            db.Execute("INSERT INTO w (a) VALUES (4)");
            throw new Error("inner");
        }));
        db.Transaction(() => db.Execute("INSERT INTO w (a) VALUES (5)"));
    });
    const kept = db.Query("SELECT a FROM w ORDER BY a").map((r) => r.a).join(",");
    check(`${who}: a nested throw undoes only the inner unit`, kept === "1,3,5", kept);

    check(`${who}: autocommit is back after a Transaction`,
          db.Execute("INSERT INTO w (a) VALUES (6)").Changes === 1 && count() === 4);
    refused(`${who}: Transaction without a function`, () => db.Transaction(1), TypeError);
}
