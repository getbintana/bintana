# Component

A form that is not a window, used inside another form as if it were a control.

A row of a list, a plate with an icon and a caption, a chart, a report, a
document viewer: anything that is *several controls and some behaviour* and is
wanted more than once. It has everything a [`Container`](Container.md) has and
**nothing of its own**; what it adds is what its own class declares.

## Every member

None of its own. A component is a class of yours:

```js
class Contact extends Component {
    get Person()  { return this.LblPerson.Text; }
    set Person(v) { this.LblPerson.Text = String(v); }
}
```

and what it publishes is **ordinary accessors**, which is all it takes for a
property to be settable from a `.form`, offered by the designer's grid and
written back by the serialiser. No declaration, no registration.

## What a class may declare about itself

| | |
|---|---|
| `static Events` | the events it raises, so `EventNames()` answers with them and the designer writes the right handler |
| `static Options` | the exact strings a property of its accepts, which is what `PropertyOptions` answers |
| `static TextProperties` | which of its properties hold **prose**, so the catalogue collects them |

```js
class Stepper extends Component {
    static Events         = ["Change"];
    static Options        = { Step: ["1", "5", "10"] };
    static TextProperties = ["Caption"];
}
```

`Emit(event, …args)` — [`Widget`](Widget.md#commands-menus-and-keys)'s — is how
it announces one: the host form receives it by the component's `Name`, exactly as
a button's `Click` arrives.

## Its own form

A component has a `.form` of its own, named after the class, and it is built when
the component is created. **Its layout is entirely declarative** in the good case
— a component whose class adds, moves or sizes controls is a function that
happens to build widgets rather than a control somebody can place.

A property the code fills in at run time should carry a **design value**, so the
designer draws something legible instead of an empty strip: see
[`SetDesign`](Widget.md#what-it-answers-about-itself) and
[formats.md](../../formats.md).

## In the designer

The designer has the runtime's widgets and none of the project's, so what it
places is a **stand-in** drawn from the component's own `.form`, carrying the
node it was given. It can be named, moved, resized and written back exactly as it
came, and its own properties are editable — read out of the component's source by
the same rule the serialiser uses.

A list can say what it holds while it is being designed
([`item`](../../formats.md#item-what-a-list-holds-while-it-is-being-designed)),
and what it names is a **component**: the designer then draws the same class the
program builds, so the drawing and the running list cannot drift.

## What goes wrong

- **A property is not offered by the grid.** It is not an accessor with both a
  getter and a setter.
- **The event arrives nowhere.** `static Events` does not name it, or the host's
  method is not `<Name>_<Event>`.
- **A caption of the component was not translated.** `static TextProperties`.
- **The designer draws a tinted rectangle.** It cannot **run** the class, so a
  component whose form is empty or whose drawing is all code — a `Chart` is one
  `DrawingArea` — has nothing legible to show.
- **A property named `Name` shadowed the widget's.** Every widget has one; call
  it something else, as `Contact` calls its `Person`.

## See also

[`Form`](Form.md) · [`Container`](Container.md) ·
[forms.md](../../llm/forms.md#components--a-form-that-is-not-a-window) ·
[`examples/contacts`](../../../examples/contacts) ·
[`examples/hello`](../../../examples/hello)
