/*
 * The widget tree lives in Form1.form; this file is only behaviour.
 * A method named <Control>_<Event> is wired up automatically -- no
 * addEventListener, no imports, exactly like Gambas.
 *
 * The form is drawn in coordinates and still survives being resized: the
 * text box is HAlign "Fill" so it grows with the window, and the list is
 * "Fill" on both axes so it takes whatever room is left. The label, the
 * button and the check box say nothing, which is HAlign/VAlign "Start" --
 * they keep their distance to the top left corner and stay where they were
 * put. Nothing here has to know: the layout is entirely in the .form.
 *
 * The plate at the bottom is a **component** -- `About`, this project's own,
 * two files beside these ones. In the .form it is a node like any other
 * (`{ "type": "About" }`) and here it is a control like any other: it publishes
 * `Caption` and this form sets it. `VAlign "End"` is the fourth anchor at work,
 * so it keeps its distance to the bottom edge while the list above it takes the
 * room.
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
         * `Locale.Text` and not a template literal, and the difference is the
         * whole of translation: a template arrives already filled in, so the
         * msgid would be "Hello Ana!" and no catalogue could ever match it.
         * `{0}` is positional so a translator can move it.
         *
         * The captions of this form need none of this -- they are declared in
         * Form1.form and the loader looks them up on the way in, which is where
         * text belongs in a RAD project. This is the exception: a string built at
         * the moment it is shown.
         */
        this.ListBox1.Add(Locale.Text("Hello {0}!", name));
        this.TextBox1.Text = "";
        this.TextBox1.SetFocus();
    }

    TextBox1_Activate() {
        this.Button1_Click();
    }

    ListBox1_Select() {
        this.Caption = Locale.Text("Hello Bintana -- {0}", this.ListBox1.Text);
    }

    Form_Close() {
        print(`Greetings sent: ${this.ListBox1.Count}`);
    }


    CheckBox1_Click() {
        
    }

    CheckBox1_KeyPress() {
        
    }
}
