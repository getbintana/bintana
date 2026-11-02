/*
 * Who this program is, and which version -- the Help menu's last item.
 *
 * **The IDE's about box, moved out of the IDE, and the copies were the ticket
 * again.** `ide/forms/AboutForm.js` was a Bintana form from the start,
 * because GTK ships `GtkAboutDialog` and the rule of the project is that the IDE
 * has no API an application lacks; and the two applications beside it --
 * `bintana-project` and `bintana-box` -- said who they were with a
 * `Message.Info` of one line each. Three programs wanting the same icon, three
 * labels and a button is what a `lib/` library is for. The IDE shows this one now,
 * with `Executable` -- the one line it wants that a program usually does not.
 *
 * **`AboutBox` and not `About`, and that is not taste.** A library's class
 * and a project's share one scope, and a second `class About` is a
 * `SyntaxError: redeclaration` before anything runs -- and `dialog` is in every
 * new project's `uses`, while `About` is exactly what a project calls its own
 * (`examples/hello` has one, a component).
 *
 * ## The shape
 *
 *     AboutBox.Show({ Summary, Copyright, Website, Icon, Name, Version, Title })
 *
 * **No callback, because there is nothing to answer**: it is the one dialog in
 * this library that is not a question, and the only argument is the options.
 * It hands the window back, like `Confirm.Ask`, so a caller can keep a handle.
 *
 * **What the project already says is not asked again.** The name is
 * `Application.Name` and the version `Application.Version`, both out of
 * `project.json`, and the icon is the one named like `Application.Id` when the
 * project ships it in `icons/` -- which is where a desktop entry looks for it
 * too. What `project.json` cannot say -- a sentence of what it is, the
 * copyright, a home page -- is the caller's prose, and every one of them is
 * hidden until it is given, so no About box shows an empty line to explain.
 *
 * **Two versions, and the line says both.** `Application.Version` is the
 * program's and `BTA_VERSION` the runtime it happens to run on, and a bug
 * report needs the pair; the IDE's About showed `BTA_VERSION` in both roles
 * for a while, which is only right while the two numbers move together.
 */
"use strict";

class AboutBox extends Form {

    /*
     * The one label this class owns. The rest is the caller's prose, and a
     * literal at the call site is where the extractor finds it -- see
     * `docs/llm/dialog.md` for the half of the catalogue a library cannot reach.
     */
    static TextProperties = ["BtnClose"];

    /*
     * `options`, every one of them optional:
     *   Summary    a sentence or two of what the program is.
     *   Copyright  the line under it, and the licence with it.
     *   Website    an address; shown as a link that opens it.
     *   Icon       an icon name. `Application.Id` when the project ships one
     *              by that name, and no picture at all otherwise -- a broken
     *              image is worse than none.
     *   Name       the big line. `Application.Name`.
     *   Version    the line under the name, replacing the one this class
     *              writes: `Version 1.2, on Bintana 0.3` (or `On Bintana 0.3`
     *              when the project declares no version). A caller that wants
     *              it translated passes its own, for the reason above.
     *   Title      the window's title. `About <Name>`.
     *   Executable true: a line with the path of the `bintana` binary running
     *              the program, ellipsized, the whole of it in its tooltip --
     *              which build answered, on a machine with more than one.
     */
    /**
     * builds the about box, shows it modal, and answers the shown window.
     * The name, version and icon come out of `project.json` unless given; the
     * summary, copyright and website are shown only when given, and the path
     * of the runtime binary only when `Executable` is true. There is no
     * callback: nothing is asked
     */
    static Show(options) {
        const opts = options || {};
        const dlg = new AboutBox();
        const name = opts.Name || Application.Name;

        dlg.Text = opts.Title || Locale.Text("About {0}", name);
        dlg.LblName.Text = name;
        dlg.LblVersion.Text = opts.Version
            || (Application.Version
                ? Locale.Text("Version {0}, on Bintana {1}",
                              Application.Version, BTA_VERSION)
                : Locale.Text("On Bintana {0}", BTA_VERSION));

        /* `HasIcon` is whether the icon *draws*, not whether a theme claims it,
         * which is the question a picture in the middle of a dialog asks. */
        const icon = opts.Icon
            || (Application.Id && Application.HasIcon(Application.Id)
                ? Application.Id : "");
        if (icon) {
            dlg.ImgIcon.Icon = icon;
            dlg.ImgIcon.Visible = true;
        }

        if (opts.Summary) {
            dlg.LblSummary.Text = opts.Summary;
            dlg.LblSummary.Visible = true;
        }
        if (opts.Website) {
            dlg.LnkWebsite.Uri = opts.Website;
            dlg.LnkWebsite.Text = opts.Website;
            dlg.LnkWebsite.Visible = true;
        }
        if (opts.Copyright) {
            dlg.LblCopyright.Text = opts.Copyright;
            dlg.LblCopyright.Visible = true;
        }
        /* Ellipsized in the `.form`, so a long path cannot push the dialog
         * wider than it was drawn; the tooltip is the whole of it. */
        if (opts.Executable) {
            dlg.LblExecutable.Text    = Application.Executable;
            dlg.LblExecutable.Tooltip = Application.Executable;
            dlg.LblExecutable.Visible = true;
        }

        dlg.Modal = true;
        dlg.Show();
        /* After `Show`, for the reason `Confirm` gives: before the window is on
         * screen there is no root to hand the focus to. */
        dlg.BtnClose.SetFocus();
        return dlg;
    }

    /* Escape arrives here too: `BtnClose` is `Cancel` in the `.form`. */
    BtnClose_Click() { this.Close(); }

}
