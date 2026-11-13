"use strict";

/*
 * No `sources`: the whole tree is walked, and `helper/` has its own
 * project.btp, so its `Main.js` is a project of its own and not loaded here.
 * When it was, its `Main` replaced this one and the run printed nothing.
 */
function Main() {
    print(`elevated is a boolean: ${typeof Privilege.Elevated === "boolean"}`);
    print(`can elevate is a boolean: ${typeof Privilege.CanElevate === "boolean"}`);
    for (const helper of ["../outside", "undeclared"]) {
        try {
            Privilege.Run(helper, []);
            print(`${helper}: ran`);
        } catch (e) {
            print(`${helper}: refused`);
        }
    }
}
