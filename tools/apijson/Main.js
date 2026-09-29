/*
 * tools/apijson: writes `api.json`, the runtime's public surface as data.
 * The builder is `Catalog.js` -- the same one `tests/api.sh` checks the file
 * with, so there is one answer and not two.
 *
 *   tools/apijson.sh                 write api.json
 *   tools/apijson.sh --check         say whether it is what this would write
 *   tools/apijson.sh --commit <sha>  record that commit in the file
 *   tools/apijson.sh --out <path>    write somewhere other than the root
 */
function Main() {
    const args  = Application.Arguments;
    const check = args.includes("--check");
    let   commit = "";
    let   out    = "";
    let   root   = "";

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--check") continue;
        if (args[i] === "--commit") { commit = args[++i] || ""; continue; }
        if (args[i] === "--out")    { out    = args[++i] || ""; continue; }
        if (!root) root = args[i];
    }
    if (!root)
        root = File.Directory(File.Directory(Application.Directory));

    const path = out || File.Join(root, "api.json");

    if (check) {
        if (!File.Exists(path)) {
            print(`api: no manifest at ${path} -- run tools/apijson.sh`);
            Application.Quit(1);
            return;
        }
        let onDisk = null;
        try { onDisk = File.LoadJson(path); }
        catch (e) {
            print(`api.json: ${e.message}`);
            Application.Quit(1);
            return;
        }
        /* `Commit` is informational and the file's own is kept, so a checkout
         * that generated it at a tag still checks green. */
        const same = JSON.stringify(onDisk) ===
                     JSON.stringify(apiCatalog(root, onDisk.Commit || ""));
        if (!same) {
            print("api.json: not what the runtime says -- run tools/apijson.sh");
            Application.Quit(1);
            return;
        }
        print("api: api.json is what the runtime says");
        Application.Quit(0);
        return;
    }

    File.Save(path, apiJson(root, commit));
    print(`api.json: written to ${path}`);
    Application.Quit(0);
}
