/*
 * Who this is, and what it is running on.
 *
 * A dialog like `AskForm` and `ConfirmForm`: a Bintana form, not a runtime
 * primitive.  GTK ships `GtkAboutDialog` and the IDE cannot have it -- the rule
 * of the project is that the IDE uses the same API as any application, and what
 * an about box is made of (an icon, three labels and a button) is already there.
 *
 * What it says that a window title cannot: the **version**, which is the one
 * thing a bug report needs and which used to be printed to the console on
 * startup, where it was gone the moment a project was opened; and the **binary**
 * the IDE is running on, which is not obvious on a machine with more than one
 * build of it (`BINTANA=/other/bintana ./tests/run.sh` is a habit here, and `bintana ide` is
 * whatever the PATH found).
 *
 * The prose lives in the `.form` and only the two answers are filled in here --
 * a label whose text is a constant has no business being assigned from code,
 * because the catalogue reads the file and not this one.
 */
"use strict";

class AboutForm extends Form {

    /* AboutForm.show() -- there is nothing to ask and nothing to answer, so it
     * takes no callback.  It hands the dialog back for the same reason
     * `MenuForm.edit` does: so whoever opened it can reach it while it is open,
     * which is what lets a test drive it. */
    static show() {
        const dlg = new AboutForm();

        /*
         * Two versions, and until now this line showed the wrong one: the IDE is
         * a Bintana project like any other, so what belongs where a program says
         * its version is the *project's* -- `Application.Version`, out of
         * `ide/project.json` -- and the runtime it happens to be running on is
         * the other half. It used to print `BTA_VERSION` in both roles, which is
         * only ever right while the two numbers move together.
         *
         * A project that declares no version says nothing about one rather than
         * showing an empty gap, which is the state every project written before
         * the field existed is in.
         */
        dlg.LblVersion.Text = Application.Version
            ? Locale.Text("Version {0}, on Bintana {1}",
                          Application.Version, BTA_VERSION)
            : Locale.Text("On Bintana {0}", BTA_VERSION);

        /* Ellipsized, so a long path cannot push the dialog wider than it was
         * drawn -- and the tooltip is the whole of it, for the case where it
         * does not fit. */
        dlg.LblRuntime.Text    = Application.Executable;
        dlg.LblRuntime.Tooltip = Application.Executable;

        dlg.Modal = true;

        dlg.Show();
        dlg.BtnClose.SetFocus();
        return dlg;
    }

    dismiss() { this.Close(); }

    BtnClose_Click() { this.dismiss(); }

}
