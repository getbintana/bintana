# ISSUE: no way to read a PDF

## What the application needed

An invoice screen: the customer picks the PDF a supplier sent and the
application shows what is in it — the number, the date, the lines — beside the
fields the user has to type. The concrete case was a document folder where every
file is a contract and the form reads the total and the due date out of it.

## What I wrote instead

Nothing — this part is not implemented. The runtime writes PDFs well:
`Printer.ToFile(area, path, [setup])` writes one from a `Draw`
(runtime/src/bta_printer.c:709), and `DrawingArea.SavePdf` (bta_paint.c:2676)
and `Drawing.SavePdf` (:2929) write one from a callback with no display at all.
Reading one back is a different thing, and there is no word for it: the only
PDF in runtime/src is the writing side and the points arithmetic (:2515).

## The code I wish I could have written

```js
// a PDF read as a document, the way `Drawing` is a document with no display:
const pdf = Pdf.Open(path)
pdf.Pages                           // how many
pdf.Text(1)                         // the text of page 1
pdf.Blocks(1)                       // what is on the page, and where
```

## Why the existing words do not cover it

`File.Load` reads bytes and `File.LoadJson` reads JSON; a PDF is neither.
`Xml` parses XML, and `libxml2` is linked optionally (CMakeLists.txt:89), but a
PDF is not XML. `Probe.Image` answers the size of a picture, not the text of a
document, and `Painter` draws: nothing in the runtime takes a PDF apart.

## Prior art

Poppler's `libpoppler-glib`, with `poppler_document_new_from_file`. PDF.js and
PDFKit, in JavaScript. Qt `QPdfDocument`. .NET has no built-in PDF reader —
iText and PdfSharp are what an application adds. Delphi's `TPDF` components.

## How much it mattered

The application cannot be written: reading an invoice is not a nicety, and a
PDF the supplier sends cannot be made into a form the user types into.
