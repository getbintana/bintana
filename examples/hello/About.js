/*
 * A component: a form that is not a window.
 *
 * It is two files like any form -- `About.form` for what it is made of and this
 * one for what it does -- and the difference is that nothing opens it. It is
 * *placed*, on a form, from the designer's palette, and from then on it is a
 * control like any other: `Form1.form` carries it as `{ "type": "About" }` and
 * the runtime builds it where the node says.
 *
 * Three things it shows, and they are the whole of what a component is:
 *
 * **What it publishes is an ordinary accessor.** `Caption` is a property
 * because it is *there*: the `.form` of whoever places it can set it, the
 * designer's grid offers it, and the serialiser writes it back. A class written
 * in JavaScript has nothing else to declare -- which is also why `static
 * Events`, `static Options` and `static TextProperties` exist for the three
 * things an accessor cannot say by existing.
 *
 * **Its layout is entirely declarative.** There is no code here that adds,
 * moves or sizes anything: the icon and the label are in `About.form`, drawn in
 * the designer. That is what makes a component reusable rather than a function
 * that happens to build widgets.
 *
 * **And what the code fills in has a design value.** `LblCaption` declares no
 * `Text` -- it gets one from `Form_Open` in the form that placed it -- so in the
 * designer it would be an empty strip nobody can lay out against. Its `design`
 * block says `"hello 1.0"`, which the designer draws and the application never
 * sees: `AddNode(node, true)` is the only code that applies one, and the loader
 * the runtime uses has no idea the key exists.
 */
class About extends Component {

    /*
     * The line beside the icon. Not `Text`, which the loader treats as prose and
     * looks up in the catalogue on the way in: this one is a program's name and
     * a number, and translating "hello 1.0" is not a thing anybody wants.
     */
    get Caption()  { return this.LblCaption.Text; }
    set Caption(v) { this.LblCaption.Text = String(v); }
}
