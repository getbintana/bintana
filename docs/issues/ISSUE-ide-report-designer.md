# ISSUE: no report designer: a report is code, and on the canvas a stand-in

## What the application needed

A report designed on screen: bands laid out on a page, a heading, a column, a
total. The concrete gesture: open the report in the designer, drag the
"Invoice" heading to the middle of the page, and the page that prints is the
page that was drawn. And the band's own properties edited on a grid rather
than typed as a number.

## What I wrote instead

The report is written in code. `lib/report/Report.js` declares `Sections`
(`:1201-1202`), `Data` (`:1194-1195`) and `Paper`, `Orientation` and
`Margins` (`:1152-1165`), and `lib/report/Report.form` is eight lines — a
single `DrawingArea` named `Canvas` — so there is nothing on screen to design.
On the IDE's canvas it is a stand-in: `ide/modules/Designer.js:741-856`
(`standIn()`) draws it, and `:811-836` replaces the drawing with an icon and
the type name when the drawing shows nothing; the comment at `:759` says of
`Chart` and `Report`: *"a `DrawingArea` and a thousand lines — draws the empty
box it really is"*. What is left of configuring it is the property grid as raw
text: `ide/modules/Designer.js:286-289` (`componentProps()`) →
`ide/modules/Classes.js:171-178` (`accessorsIn()`, getter and setter pairs
read out of the source) → `ide/modules/PropertyGrid.js:1447`, which renders
the value with `editor.Text = this.show(value)`, and `show()` is `String(value)`
(`PropertyGrid.js:1653-1655`). A `Sections` object is a JSON blob typed into a
text box.

## The code I wish I could have written

```js
// The shape of a report that could be designed: the bands are a document the
// designer draws, the data is still bound in code.
//
//   class Invoice extends Report {
//       static Bands = [ { Kind: "Heading", Text: "Invoice", At: { X: 40, Y: 60 } },
//                        { Kind: "Field", Name: "total", At: { X: 400, Y: 700 } } ];
//       get Data() { return this.orders; }
//   }
```

## Why the existing words do not cover it

The runtime's `Report` is complete as a document — `Sections`, `Data`, `Paper`,
`Orientation`, `Margins` — but every one of those is a value assigned in code,
and the property grid shows it as `String(value)`.
`Classes.accessorsIn()` (`ide/modules/Classes.js:171-178`) finds a component's
properties by reading getter and setter pairs out of the source, so a property
the designer cannot see is a property it cannot edit; and
`Designer.standIn()` (`ide/modules/Designer.js:741-856`) draws an icon and the
type name for a component whose drawing shows nothing, which is what a report
always is on the canvas. There is no report-specific code in `ide/` at all.

## Prior art

Lazarus LazReport, with its designer. Delphi FastReport and QuickReport, both
with designers. Gambas `gb_report`, a designer. .NET's `RDLC` and Crystal
Reports. GTK4 has no report framework at all — this is where a project writes
its own, as `lib/report` does.

## How much it mattered

It works, but a part of it is noticeably worse: every report in every
application is written as code, and the only picture of it is the one it
paints.
