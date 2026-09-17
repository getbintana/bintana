# Your first Bintana app

Five minutes, in the IDE, no code written by hand except one method.
What you build is a window with a field, a button, and a greeting —
the same shape as [`examples/hello`](../examples/hello), minus its extras.

## 1. New project

`Ctrl+Shift+N`, name it, pick a folder. The IDE creates the shape every
project has:

```
myapp/
  project.json      what to run: `startup` names the class to open
  forms/Form1.form  the window: a widget tree, in JSON
  forms/Form1.js    its behaviour: one class
```

`Form1` is already open in the designer: an empty window.

## 2. Draw the window

From the palette, drop a `Label`, a `TextBox` and a `Button` onto the form.
In the property grid:

- `Label1.Text = "Your name:"`
- `Button1.Text = "Greet"`

Positions and sizes belong in the `.form` — that is what the designer writes.
Nothing in the `.js` will name a coordinate.

## 3. Answer the button

Double click `Button1`. The IDE opens `Form1.js` with the handler it will
call, named after what raises it:

```js
Button1_Click() {
    let name = this.TextBox1.Text.trim();
    if (!name) {
        Message.Warning("Type a name first.");
        return;
    }
    Message.Info("Hello {0}!", name);
}
```

The name *is* the wiring: `Button1_Click`, `TextBox1_Change`, `Form_Open`.
Nothing is registered, there is no `addEventListener`.

`Message.Info` owns its text position, so the literal with `{0}` holes is
what the translator sees — and never a template literal in it, which would
arrive already filled in and no catalogue could match. `Message` shows and
returns: it does not block, and there is no answer. A question that needs
one is a form of your own.

## 4. Run it

Run. Type a name, press the button — or Enter, once you wire
`TextBox1_Activate` to call the same method. Try it empty to meet the
`Warning`.

## 5. Where everything lives

- **Layout** in `Form1.form` (what the designer drew).
- **Behaviour** in `Form1.js` (what you wrote).
- **Text a person reads** in the `.form` needs nothing; text built at
  runtime goes through `Message`'s `{0}` holes or `Locale.Text`.

## 6. Put it in your menu

*Project → Install as user application…* writes one `.desktop` file under
`~/.local/share/applications` pointing at this runtime and this project, with
the name and the icon you choose. The app appears in the desktop's menu for
this user — no root, no package — and the same dialog removes it. See
[installing it in the menu](ide.md#installing-it-in-the-menu).

## Next

- [`examples/hello`](../examples/hello): this same app with a check box
  (reading `Active`), an `About` component of its own, and `po/es.po` —
  run it with `LANGUAGE=es` to see the greeting translated.
- [`reference/`](reference/README.md): one page per control and per global,
  for the person at the IDE — press F1 over anything. This is where you go
  when you know *which* control and want *every member explained*.
- [`llm/`](llm/README.md): the same surface said briefly, for a model — or
  for writing every file by hand. Not this road.
