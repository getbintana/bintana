/*
 * The widget tree lives in Form1.form; this file is only behaviour.
 * A method named <Control>_<Event> is wired up automatically -- no
 * addEventListener, no imports, exactly like Gambas.
 *
 * The form is drawn in coordinates and still survives being resized: the
 * text box is HAlign "Fill" so it grows with the window, while the label,
 * the button and the check box say nothing (HAlign/VAlign "Start") and keep
 * their distance to the top left corner. Nothing here has to know: the
 * layout is entirely in the .form.
 *
 * The plate at the bottom is a **component** -- `About`, this project's own,
 * two files beside these ones. In the .form it is a node like any other
 * (`{ "type": "About" }`) and here it is a control like any other: it publishes
 * `Caption` and this form sets it. `VAlign "End"` keeps its distance to the
 * bottom edge.
 */
class Form1 extends Form {

    Form_Open() {
        /*
         * What the component shows, out of the two places that answer for it --
         * and they are two different questions. `Application.Name` and
         * `Application.Version` are *this project's*, read out of project.json
         * by the runtime, so neither is written down a second time here where it
         * would go stale. (`BTA_VERSION` is the runtime's own, which is what an
         * About box gets wrong until it knows the difference.)
         */
        this.About1.Caption = `${Application.Name} ${Application.Version}`;

        this.TextBox1.SetFocus();
    }

    Button1_Click() {
        let name = this.TextBox1.Text.trim();
        if (!name) {
            Message.Warning("Type a name first.");
            return;
        }
        if (this.CheckBox1.Active) name = name.toUpperCase();

        /*
         * `Message.Info` owns its text position: the literal goes through the
         * catalogue with `{0}` holes, so there is no `Locale.Text` around it --
         * and never a template literal in it, which would arrive already filled
         * in and no catalogue could ever match it. `{0}` is positional so a
         * translator can move it.
         */
        Message.Info("Hello {0}!", name);
        this.TextBox1.Text = "";
        this.TextBox1.SetFocus();
    }

    TextBox1_Activate() {
        this.Button1_Click();
    }
}
