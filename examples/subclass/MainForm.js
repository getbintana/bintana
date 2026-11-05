/*
 * The form that uses the subclass.
 *
 * Run it with `--selftest` and it checks that the runtime built a real
 * `NameList` and that its method refilled the list, then quits.  Open the
 * project in the IDE and `MainForm.form` is drawn as a `ListBox`, because the
 * designer read the `extends` instead of running `NameList.js`.
 */
"use strict";

class MainForm extends Form {

    Form_Open() {
        if (!Application.Arguments.includes("--selftest")) return;

        this.Names.Refill(["Dani", "Eva"]);

        const ok = this.Names instanceof NameList &&
                   this.Names.Count === 2 &&
                   this.Names.Index === 0 &&
                   this.Names.Text === "Dani";

        print(ok ? "subclass: ok" : "subclass: failed");
        Application.Quit(ok ? 0 : 1);
    }

    BtnRefill_Click() {
        this.Names.Refill(["Dani", "Eva", "Fer"]);
        this.LblStatus.Text = `${this.Names.Count} names`;
    }
}
