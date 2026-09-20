# ISSUE: a control built from code has no `On(event, fn)`

## What the application needed

To build controls at runtime -- a palette of buttons, one row per column of a
board, a grid of icons -- and give each one a handler. The count is not known
until the data is read, so there is no `.form` and no `Name` a designer chose.

## What I wrote instead

Handlers assigned onto the form by their conventional name, and deleted the same
way:

```js
this.ide[`Pal_${type}_Click`] = () => this.pick(type);
/* ...and, when the palette is rebuilt... */
delete this.ide[`Pal_${was}_Click`];
```

`PropertyGrid.js:707-710` (four `delete`s in a row), `MenuBar.js:309-318` and
`:326-329`, `Palette.js:415`, `IconForm.js:71-89`.

## The code I wish I could have written

```js
const b = new Button();
b.On("Click", () => this.pick(type));
panel.Add(b);
```

## Why the existing words do not cover it

Events dispatch by name: `bta_emit(w, "Click", …)` looks up `<w->name>_Click` on
`w->form`. That is exactly right for a `.form`, where the designer named the
control and the handler sits in the class -- and it means a control the designer
never saw has to be given a name for the sole purpose of building a property
name out of it, on an object that is not the control.

Two things follow that are worse than the verbosity. The name is a **global** on
the form, so building the same palette twice leaks the old handlers unless
something deletes them, which is what those four `delete`s are. And a handler
that closes over a loop variable has to encode that variable into the name,
which is how `Pal_${type}_Click` happens.

**The sharp edge is the component.** A `Component` added from code keeps *itself*
as its event target rather than being rebound to its host the way the `.form`
loader rebinds it -- documented in `AGENTS.md`, and a real fork in the road: a
reusable component is the one thing most likely to be added from code, and it is
the one case where the naming convention does not even reach.

## Prior art

GTK's own `g_signal_connect` is the shape, and it is what the runtime already
does underneath. .NET `button.Click += handler`. Delphi `Button.OnClick :=`. Qt's
`connect`. Every toolkit that has a designer also has the runtime form, because
a list of unknown length is not a thing a designer can draw.

## How much it mattered

Four sites in the IDE and one design dead end. The dead end is the part worth
weighing: a `Component` added from code is the natural way to build a list of
cards or rows, and today the answer is to give up the component and assemble
panels by hand. An `Add` that rebinds a component to its host would close that
half, and `On(event, fn)` the other.
