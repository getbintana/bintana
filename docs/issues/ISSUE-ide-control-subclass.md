# ISSUE: a project's subclass of a control is a grey box in the designer

## What the application needed

A list with a behaviour of the application's own, placed on a form like any
other list. Concretely `export class MyList extends ListBox {}` -- or a
`ComboBox` that fills itself from a table, or a `TextBox` that validates a
code -- dropped on a form, its rows typed in `Items`, the row it opens on
chosen in `Index`, and the list drawn on the canvas with those rows, the way
a plain `ListBox` is.

## What I wrote instead

The `.form` by hand. The designer draws a node of type `MyList` as a grey box
with the name on it, and the property grid offers `Name`, `X`, `Y`, `Width`,
`Height` and `Visible` and nothing else: no `Items`, no `Index`, none of the
`ListBox`'s rows. The node is kept and written back as it came, so properties
typed into the file survive a save -- they just cannot be seen or edited.
The alternative is not subclassing: a plain `ListBox` on the form and the
behaviour moved into the form's code, once per form that uses it.

Reproduced with two files, `MyList.js`
(`export class MyList extends ListBox {}`) and a `.form` with a node
`{ "type": "MyList", "properties": { "Items": ["A","B","C"], "Index": 2 } }`.
Run, the list has its rows; in the designer, a grey box.

## The code I wish I could have written

```js
// MyList.js
export class MyList extends ListBox {
    Refill(rows) { this.Items = rows.map((r) => r.Name); }
}

// The designer draws `MyList` as the ListBox it extends -- rows, selection,
// scroll -- and the grid shows the ListBox's rows plus the accessors MyList
// declares, so `Items` and `Index` are edited where every other list's are.
```

## Why the existing words do not cover it

The designer runs in the IDE's own process and never has the project's
classes (`Designer.buildNode`, `ide/modules/Designer.js`): building a node of
a type it does not know throws, and the catch draws `standIn`. Only a class
that `extends Component` and has a `.form` of its own is a palette component
(`Classes`' scan, `ide/modules/Classes.js`), and even that one gets the rows
the designer owns plus the accessors read from its source
(`PropertyGrid.allKeys` → `componentProps`). A class that extends a runtime
control is neither: its base is named in its source and the runtime has that
class, but nothing reads the `extends` to draw the base or to offer its
properties.

## Prior art

Delphi and Lazarus install a component package into the IDE, so a
`TListBox` descendant is drawn by its own code. Visual Studio's WinForms
designer builds the project and instantiates the user's control. Qt Designer's
"promote to" places the base class and records the subclass's name -- the
cheap half, and the one that fits a designer that cannot run the project.

## How much it mattered

It works, but a part of it is noticeably worse: a project that subclasses a
control designs those controls blind, and the obvious way to reuse list or
combo behaviour -- subclass it -- costs the designer.
