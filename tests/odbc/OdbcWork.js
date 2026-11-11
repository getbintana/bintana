/* A worker that opens its own connection: `Database.Odbc` is registered in
 * bta_task.c as well, and a connection belongs to the thread that opened it. */
class OdbcWork extends Task {
    Run(msg) {
        const db = Database.Odbc(msg.cs);
        const dbms = db.Dbms;
        db.Close();
        return dbms;
    }
}
