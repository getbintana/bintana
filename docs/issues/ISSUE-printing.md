# ISSUE: no printer

## What the application needed

Sending a report or an invoice **to paper** — with a choice of printer, paper
size and number of copies, and a preview of what is about to come out. The
concrete case was an invoice application whose user had to be able to print the
quote they had just drawn, from the window they had drawn it in.

A file is not the same thing. `DrawingArea.SavePdf` and `Report.SavePdf` write
the document, and that covers sending it to somebody; it does not cover the user
who has a printer on the desk and expects *Print* to reach it.

## What I wrote instead

Nothing in-process. The nearest is writing a PDF and handing it to the desktop
with `File.Open(path)`, which launches whatever opens PDFs. That offers no
printer selection, no page range, no copies, no margins and no preview; it puts
another application in front of the user in the middle of a task; and it cannot
print a view of the *form* — only what the program had already drawn into a
file of its own.

## The code I wish I could have written

```js
Print(this.Summary)          // a widget, laid out on a page
```

and the dialog that answers printer, copies and range before anything is drawn:

```js
Dialog.Print({ Pages: this.Report.PageCount }, (answer) => {
    if (!answer) return;                       // cancelled
    /* answer.From, answer.To, answer.Copies … and a Painter per page */
});
```

The report's own need would then be one line — `this.Report.Print()` — over the
same pages `SavePdf` already writes.

## Why the existing words do not cover it

`File.Open` hands a file off to another program: it is not printing, and gives
the application no control over anything the user chose. `SavePdf` writes a
document but has no idea a printer exists, no dialog, and no page range —
`pages` is how many to draw, not which ones to send. Nothing in the runtime
wraps a print operation, a printer, or a preview of a page as it will be
printed, and no control can be laid out onto a page: `SavePdf` prints what a
`Draw` handler paints, so a form with real widgets on it has no path to paper at
all.

## Prior art

VB6's `Printer` object. .NET `PrintDocument` with `PrintPreviewDialog`. Gambas
`Printer`. Delphi `Printer`. GTK4 has `GtkPrintOperation`, which is the dialog,
the page setup and the run over a cairo context in one object — and the cairo
context it hands over is the one a `Painter` already wraps.

## How much it mattered

The application cannot be written. "Print this invoice" is a button every
business application has, and here it has no path except write-a-file-and-open
it, which is a different product with somebody else's window in front of it.
