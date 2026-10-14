# Zip: a reader of our own, and what real documents said

**Designed in [`docs/plans/crypto-compress-plan.md`](../plans/crypto-compress-plan.md);
this is stage 2, the reader.** The writer (stage 3) waits for a caller that has to *make*
a `.xlsx` or an `.odt` -- `examples/clients` exporting to Excel is the candidate, and it
is the half `soffice` can check automatically. What bit, in the order it was found:
- **A third of the entries in real documents have a data descriptor.** Measured over 49
  real documents (859 entries): 271 carry flag `0x08`, meaning the local header in
  front of the data holds no size at all, and LibreOffice writes one on **every** entry.
  So sizes and CRC come from the central directory at the end of the file and the local
  header is read only to find where the data begins -- which is also why a plain "read
  the headers in order" reader, the obvious one, would have failed a third of the files
  it was tried on. The same measurement bounded the scope: every entry stored or deflated,
  none encrypted, none zip64, none with a name that leaves its folder. Everything else is a
  refusal that names the feature.
- **`soffice --headless` is an oracle, and the plan had said it could only be done by
  hand.** 0.56 s a conversion, `.csv` to `.xlsx` and back with accents and commas intact.
  It needs a `HOME` of its own (`Environment: { HOME }` on the `Exec`) so it does not write
  a profile into the developer's. The reader test uses it for a real producer's file; the
  writer, when it exists, can be checked by converting what it wrote.
- **The hostile archives are built in JavaScript, and the point is what they are built
  from.** A gzip member is a 10-byte header (GLib's, with no name field), a raw deflate
  stream and an 8-byte trailer that begins with the CRC-32 -- so `Gzip.Compress` hands the
  builder both, and no zip code of ours checks zip code of ours. `unzip -t` accepts the
  builder's output, which is asserted so that a refusal is known to be the defect.
- **With the name check taken out the hostile entries were written outside the
  destination.** That is the mutation that proves the test, and the reason the hostile
  archives name paths inside `SCRATCH`: `../evil.txt` landed beside the folder and an
  absolute name landed where it said. A test of a path-traversal check whose bad entry
  points at somewhere real is a test that does the damage when it goes red.
- **A zip is read from a copy, up to 32 MiB.** Mapping a file another program may truncate
  is a `SIGBUS` that ends the process, which no `try` catches; a bigger archive is mapped
  and the risk is stated in the verb's comment and the page. Nothing here calls back, so a
  worker has `Zip`, and `testTask` opens and reads an archive in one.
- **Excel's serial 1 to 60 are a day out in `examples/sheets`, on purpose.** The format
  counts a 29 February 1900 that never existed, and an epoch of 30 December 1899 gets every
  serial from 61 on right and everything before it wrong by one. The reader says so in a
  comment and the test asserts 61, not 59.

**The writer (stage 3) is `lib/xlsx/Xlsx.js`** -- it was `examples/clients/Excel.js` until the
application needed it and it became a library -- and `examples/clients` is its caller: it is a
workbook's parts, an *Export* button writes what the list shows, and the suite holds the result to
three programs that did not write it. What bit:
- **`GZlibCompressor` answers *Need more input* as an error, exactly as the decompressor does.**
  Called with nothing left and not at the end it returns `G_IO_ERROR_PARTIAL_INPUT`, which is a request
  for the next block; `AddFile`'s first loop took it for a failure and **every file past 64 KB failed
  with "could not be compressed"**, while `Add` (which hands the whole input over with `AT_END`) was fine
  -- the two paths shared a converter and not a loop, so only the streamed one hit it.
- **65,534 entries and not 65,535.** `0xFFFF` in the end record is the zip64 sentinel, so an archive
  of exactly that many already needs the zip64 record -- and the reader refuses it for that reason.
  The test writes 65,534 and reads them back; the entry after is refused.
- **`g_utf8_validate` stops at a NUL and calls the name invalid**, so the NUL has to be asked for first or
  a hostile name is refused with the wrong sentence.
- **`soffice`'s CSV filter writes a number as the number it is**, not as the cell shows it: `1234.50`
  with the style `0.00` exports as `1234.5`. The money *format* is only visible in the HTML export
  (`sdnum="1033;0;0.00"`, `>1234.50<`). It also needs `LC_ALL=C` -- on a Spanish desktop the booleans come
  out `VERDADERO` and the decimals with commas -- and a `HOME` of its own, or it writes a profile into the
  developer's. `-1` as the last token of the filter exports every sheet, one file each.
- **A date written as text passes every reader that shows values**, and that was found by putting the
  defect back: `ExampleExcel` stayed green with `2024-03-01` written as an inline string, because a CSV, the
  sheet reader and the eye all show the same ten characters. What tells them apart is the cell -- a number,
  with a date style -- so the test reads `xl/worksheets/sheet1.xml` and asserts the serials, worked out from the
  calendar in the test and not by the writer (45352, 36525, 36585, 46297, 45657).
- **A test that runs an example which keeps a database runs it in the developer's configuration**
  unless told otherwise. `examples/clients` writes `~/.config/bintana/Clients/clients.db`, so
  `ExampleClientsExport` gives the child `HOME` and `XDG_CONFIG_HOME` of its own, and then reads *that* database
  to check the workbook against -- a source `Xlsx` had no hand in. The example takes a path as its argument
  to export and quit, and hides its window before it is shown (`Form_Open` runs before `Show()` returns), so a
  suite run takes no focus. Rows are compared by name and not by position: the list is ordered with
  `Locale.Compare`, which is the desktop's order and not CI's.
- **Excel holds a number as a double**, so a `Decimal` past fifteen significant digits does not survive the trip;
  the alternative, writing it as text, is a column nobody can sum. It is Excel's limit and `Xlsx` says so.

Three defects were put back in the writer and each went red (names unchecked, a streamed entry not flagged as
having a descriptor, `Abort` leaving its temporary). `Xlsx.js` was first written as strings, with an escaper of its
own; it builds every part with `Xml` now (see *Xml and Record* below for what that found), and the defects put back
in it were money without its style and a date as text -- the last one only went red once the XML assertions were
added -- and leaving out its `clean()`, which now fails loudly instead of writing a corrupt workbook.

`examples/sheets` is the caller: an `.xlsx` read in a `Task` (`SheetReader`, which carries
its own helpers because a worker loads only the file of its task class) and shown in a
`TableView` in its on-demand mode, so a hundred thousand rows are arrays of strings and a
screenful of widgets. Its reader is tested (`ExampleSheets`); the window was checked by a
screenshot on an `Xvfb`.
