# ISSUE: no align-centres, no centre-in-form, and the grid is invisible

## What the application needed

Centre a control on the form, and centre a group of controls on each other.
Two concrete gestures: select a button and press "Centre horizontally" and it
sits in the middle of the window; select five labels and press "Centre" and
they are one row with one middle. And a visible grid, so a control can be put
where the grid says it goes.

## What I wrote instead

The coordinates are typed. `ide/modules/Designer.js:1634-1683` (`align(how)`)
supports exactly `left`, `right`, `top`, `bottom`, `width` and `height`
(`:1656-1677`), and the matching commands in `ide/forms/MainForm.form` are
`ActAlignLeft`, `ActAlignRight`, `ActAlignTop`, `ActAlignBottom`,
`ActSameWidth`, `ActSameHeight`, `ActSpreadH` and `ActSpreadV` — there is no
centre variant of any of them, and nothing that centres a control in its form.
A centre is therefore a number in the property grid, worked out by hand.

The grid is worse than absent. `export const GRID = 4;`
(`ide/modules/Designer.js:38`) is used only for snapping (`snap()` at
`:142-144`; the call sites are `:1922-1923`, `:2139-2140`, `:2350`, `:2409`
and `:2521`), and no grid lines are drawn anywhere — `ide/modules/Chrome.js`
draws the selection outline, the handles, the insertion band, the rubber band
and the alignment guides (`:1-12`, `:364-393`), and no lattice. A control is
drawn where it will land and the lattice that put it there is invisible.

## The code I wish I could have written

```js
// The commands the designer would carry, in the IDE's own vocabulary:
//   { "name": "ActAlignCentreH", "text": "Centre horizontally" }
//   { "name": "ActAlignCentreV", "text": "Centre vertically" }
//   { "name": "ActCentreInForm",  "text": "Centre in form" }
//
//   ActAlignCentreH_Click() { this.designer.align("centreH"); }
//   ActCentreInForm_Click() { this.designer.centreIn(this.form); }
//   Chrome.gridLines(4)                 // the lattice the snapping uses
```

## Why the existing words do not cover it

`Designer.align(how)` (`ide/modules/Designer.js:1634-1683`) is a switch over
six cases and there is no seventh: `left`, `right`, `top`, `bottom`, `width`,
`height` (`:1656-1677`). The commands `ActAlignLeft`, `ActAlignRight`,
`ActAlignTop`, `ActAlignBottom`, `ActSameWidth`, `ActSameHeight`, `ActSpreadH`
and `ActSpreadV` in `ide/forms/MainForm.form` cover those six and the spread;
none of them centres, and none aligns to the form rather than to the
selection. `GRID` (`:38`) is a constant used by `snap()` and by nothing else.

## Prior art

Lazarus's align menu: centres, left, right, top, bottom, and centre in form
or parent. Delphi's alignment palette — align, centre, distribute — and its
"align to form". Visual Studio's alignment and "align to selection". Inkscape
and the other editors with a visible grid. GTK4 has no designer at all.

## How much it mattered

It works, but a part of it is noticeably worse: centring a control or a group
of controls is done by typing coordinates.
