# ISSUE: there is no property grid control

## What the application needed

An inspector panel in the application itself: a list of rows, one per
property of the selected object, each with the property's name beside a
field that edits it, and a drop-down where the property declares the values
it accepts. The concrete case was a configuration screen where an operator
edits a printer's settings — paper size, the tray, the copies — and the
fields have to be the right kind for what each setting is.

## What I wrote instead

The rows are built by hand, one per setting: a `Label` and a `TextBox` (or a
`ComboBox`, or a `CheckButton`) per property, in a `Grid`, with the value
read back and written out by the program. It costs a row per property and a
handler that knows how to save it, and every setting added to the class is a
row added to the form.

## The code I wish I could have written

```js
// a control that draws an object's properties and edits them:
{
  "type": "PropertyGrid",
  "name": "Props",
  "properties": { "Target": "this.printer" }
}
// with the names, the kinds and the accepted values asked of the runtime,
// the way the IDE asks them of `Widget.PropertyNames` and
// `Widget.PropertyOptions`
```

## Why the existing words do not cover it

The runtime has all the machinery and no control that draws it.
`Widget.PropertyNames` (`runtime/js/forms.js:409`),
`Widget.PropertyOptions` (`runtime/src/bta_widget.c:5233`),
`Widget.TextProperties` (`:5216`), `Widget.EventNames` (`:5169`) and
`Widget.Members(type)` (`:4962`) all answer about a class by name, with no
control built. What is missing is the control that puts those answers on
screen: the IDE has one — `ide/modules/PropertyGrid.js`, 1943 lines, with
`target` at `:452` and `allKeys()` at `:566-603` — but it is the IDE's own
module, and the IDE has no privileged API, so what it draws for itself an
application cannot draw for itself. There is no `PropertyGrid` class to put
on a form: the class table the runtime gathers at
`runtime/src/bta_widget.c:8483-8509` holds forty-six classes besides the
`Widget` root, and no such class is among them.

## Prior art

Lazarus `TPropertyGrid`, with its `TPropEditor` system. Delphi's
`TValueListEditor`. WinForms `PropertyGrid`. Qt `QTreeView` with a
`QStyledItemDelegate`. GTK4 has no property grid.

## How much it mattered

It works, but a part of it is noticeably worse: an application that shows an
object's properties draws the rows by hand.
