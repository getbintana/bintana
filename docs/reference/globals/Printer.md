# Printer

What this machine can print on, and the two ways a drawing gets there.

A printer is a thing outside the program — it has a name, a default and a dialog
— so the questions about it do not belong on a widget. `Save`, `ToPng` and
`SavePdf` are the drawing's own, because they write what it *is*; paper is
`Printer`'s.

```js
Printer.Names                                    // ["Ink-Tank-310", "Print to File"]
Printer.Default                                  // "Ink-Tank-310"

Printer.Send(this.Sheet, { Pages: 12 })          // the dialog, then a printer
Printer.ToFile(this.Sheet, path, { Pages: 12 })  // a PDF, and no dialog
```

## Every member

| | | |
|---|---|---|
| `Default` | the printer this machine would use | [what the machine has](#what-the-machine-has) |
| `Names` | the printers it can reach | [what the machine has](#what-the-machine-has) |
| `Send(area, [setup])` | the dialog, then paper | [sending](#sending) |
| `ToFile(area, path, [setup])` | a PDF, with no dialog | [to a file](#to-a-file) |

## What draws

`area` is a control that draws — a [`DrawingArea`](../widgets/DrawingArea.md),
or the `Canvas` of a [`Report`](../libraries/Report.md) or a
[`Markdown`](../libraries/Markdown.md). Its handler runs **once per sheet**
against the print context: the same cairo calls that paint the screen, so a page
that fits the paper in `SavePdf` fits it here.

**The sheet arrives as an argument.** A control whose form declares
`DrawPage(painter, page, width, height)` gets that; one that declares none gets
`Draw`, which is the right answer for a drawing that is one page.

```js
Sheet_DrawPage(p, page, w, h) {
    p.Text(40, 60, Locale.Text("Page {0} of {1}", page, this.total));
}
```

The frame is the **printable area in points**, 72 to the inch — A4 is 595×842
less the margins the printer keeps. It is the same unit `SavePdf` takes, which
is why a layout moves between the two without arithmetic.

Printing **from inside a `Draw`** is refused, and refused before the dialog
opens rather than a page after it: there is one painter per control, and a
handler that is drawing cannot ask for a second frame.

## The setup

Both verbs take the same object, and every key is optional.

| | |
|---|---|
| `Pages` | how many sheets the document is, 1 to 10000. Default `1` |
| `Paper` | `A4`, `Letter` or `A5` |
| `Orientation` | `Portrait` or `Landscape` |
| `From`, `To` | the range within the document. `From` defaults to 1 and **`To` to the last page** |
| `Copies` | how many. **`Send` only** — see below |

A key that is `null` was **not given**, exactly as one that is `undefined`. It
is worth saying because `To` is the one key with a default of its own, and it is
the one where two readings of the same key could disagree: `{ Pages: 5, To: null }`
printed page 1 and said nothing, for as long as the default was decided by a
second look that asked only about `undefined`.

## Sending

| | |
|---|---|
| `Send(area, [setup])` | the print dialog, then a printer. The setup is what the dialog **opens on**; the answer is `{ Copies, From, To }` — what was actually sent — or `null` when it was cancelled |

`Printer.Send(area, [setup])` opens the system's print dialog. The printer, the
paper, the copies and the range are the person's to answer there, and what the
setup carries is what the dialog **opens on**. GTK's own preview shows what is
about to come out.

It answers `{ Copies, From, To }` — **what was actually sent**, read back off the
dialog — and `null` when it was cancelled, which is not an error and needs no
`try`.

```js
BtnPrint_Click() {
    const sent = Printer.Send(this.Sheet, { Pages: this.total, Paper: "A4" });
    if (sent)
        Message.Info("{0} copies, pages {1} to {2}", sent.Copies, sent.From, sent.To);
}
```

## To a file

| | |
|---|---|
| `ToFile(area, path, [setup])` | the same sheets as one PDF, with **no dialog**; → how many pages it wrote. `Copies` is refused here, because a file has none |

`Printer.ToFile(area, path, [setup])` writes the same sheets as one PDF and
**opens no dialog**. It is "print to PDF", and it is the road a test can take —
a test cannot click a dialog. It answers **how many pages it wrote**.

**`Copies` is refused here**, and that refusal is the reason these are two verbs
rather than one with a destination. As one call it was accepted and ignored:
`{ Copies: 3 }` with a file answered *three copies sent* and wrote the same
file, byte for byte, as one copy. A file has no copies, so the question is not
asked. It is the same split [`Dialog`](Dialog.md)'s `OpenFile` and `SaveFile`
are — one verb with a flag that changes what the call *is* reads as one thing
and behaves as two.

With a range, the file holds exactly `From..To` and nothing else.

**`SavePdf` is the other road to a PDF**, and the difference is the unit: it
takes a width and a height in points, this takes a `Paper`. A document that
knows its paper wants this one; a drawing that knows its size wants that one.

## When a page throws

A handler that throws stops the run. The error is reported the way every
handler's is, the call throws so that the caller has something to fail with,
and on the file road **no file is left** — the same bargain `SavePdf` makes
about a document it did not finish.

A throw is answered before a cancellation is: a `DrawPage` that failed is the
program's fault and a cancelled dialog is the person's decision, and the fault
is the more specific answer.

## What the machine has

| | |
|---|---|
| `Names` | the printers this session can reach, as a list of strings. A machine with none answers `[]` |
| `Default` | the one it would use, or `""` when none is marked |

This is the question a palette has to be able to ask **before** it offers a
button, which is the argument [`Video`](../widgets/Video.md)'s `Available`
settled: a control offered on a machine that cannot run it is a person finding
out at the worst moment.

They are **not cached**. Measured on the machine this was written on: 33.6 ms
cold and 6.2 ms warm, because GTK caches its backend underneath — and unlike a
plugin registry, the printers a machine has do change while a program is
running.

**They are the Unix print backend's**, which is a GTK module of its own. A build
without it **refuses both with a sentence** rather than answering an empty list,
because an empty list cannot be told apart from a machine with no printer at
all. Printing itself is unaffected: the dialog is core GTK, and `Send` and
`ToFile` work the same everywhere.

## See also

[`DrawingArea`](../widgets/DrawingArea.md) · [`Report`](../libraries/Report.md) ·
[`Markdown`](../libraries/Markdown.md) · [`Dialog`](Dialog.md)
