# Data: Record, Xml, Sqlite, Csv

The traps and decisions of this area, each with what it cost and the rule it left. [`AGENTS.md`](../../AGENTS.md) states the rules that apply to every change; this file is the evidence behind them and the detail that only matters here.

## Record

- **`static get Fields()` on a `Record` declared nothing, in silence.** A
  getter's descriptor has no `value`, so `#fieldsOf`'s merge loop ran over
  `undefined` and the class came out with no fields at all -- no accessors, no
  checks, an empty `Serialize`, and nothing said so. It matters because a getter
  is the *tempting* way to write a shape that contains itself: it defers the
  class body's own name until it is bound. It is refused out loud now, and the
  way to write recursion is the thunk -- `Children: Field.List(() => Node)`,
  since inside a class body `Field.List(Node)` is a `ReferenceError`.
- **A nested record's `def` is constructed inside `freshDefault`, which is why
  the declaration check had to stop asking for it twice.** `#fieldsOf` validated
  a field's starting value in a `try` and then built the error message with a
  second `freshDefault(field)` call -- fine while a default was a copy of a
  scalar, and a throw *inside the catch* once a record field builds its seed
  there. The wrapping was carried away and the raw message came out with no
  class and no field in it: `Street: expected text, got number` for a
  `Field.Record(Address, { def: { Street: 5 } })` declared three classes away.
  Compute it once, name it, and let the catch report what it has.
- **A record field starts at `null`, and the two alternatives are both worse in
  ways that are not obvious.** An empty *instance* cannot be the default: the
  constructor and the declaration check would both build one, so a shape that
  contains itself never finishes -- and `sameValue` falls to identity on records,
  so an untouched child would be written to the file on every save. A *lazy*
  getter that builds on first read looks like it solves both (the serialiser
  reads `#d` directly, so it never fires), and it fails on the question that
  matters: `if (item.Submenu)` becomes always true, so nothing can ask whether a
  node has children -- which is *the* question in a menu and in a `.form`. And
  reading would mutate the record, in a class whose whole promise is that the
  setter is the only way in.
- **`Serialize` used to hand a list of decimals out as decimal objects.** It
  copied a list with `slice()`, so only lists of plain values survived the trip;
  a `Field.List(Field.Decimal())` serialised to `[{}, {}]` through
  `JSON.stringify`. It goes element by element now, through the same conversion a
  single value gets. Nothing in the tree had such a field, which is why nothing
  had failed.
- **`Load` *loads* a child and does not assign it, and the difference is the
  whole point of `Load`.** Assigning goes through the child's setters and stops
  at its first bad member, so one bad price would cost the rest of that line --
  in a method that exists so one bad key does not cost the other twenty. The
  same rule one level down: `Field.Record` and a list of them are loaded
  leniently, and a child keeps its own complaint. `Problems` reaches it through a
  private static, because `#p` is class-scoped -- which is also the reason this
  mapping can never live in `lib/`: nothing outside `Record` can see it.
- **`Problems` is the report of one `Load`, and `Validate()` is the state. It
  used to be `Problems` = both, and that was a bug rather than noise.** The
  duplication was the visible symptom -- `Plain.Load({ Name: "" })` answered
  `["Name is required -- left at \"\"", "Name is required"]`, one problem in two
  sentences, multiplied by nesting into two hundred for a hundred bad rows. The
  actual defect is that **nothing clears the file's half**: not assigning to the
  field, not saving, not saving successfully. Measured -- load a client whose
  file has no name, type the name into the form, and `Validate()` is empty while
  `Problems` still says `Name is required`. A Save button wired to `Problems`
  therefore **refuses to save a record the user has already fixed**, and marks a
  field that has a name in it.
  So they are separate now, and the two halves are genuinely different
  questions: the file's half is the only thing that knows a value was *thrown
  away* (a `-500` refused by `min: 0` leaves a valid `0.00`, so `Validate()` says
  nothing and the next save writes over what the file had). A caller that wants
  both says `rec.Problems.concat(rec.Validate())` -- which is what the two places
  reporting on *opening a file* do, and what `Manifest.report()` in the IDE has
  to do, since `ProjectFile.Validate()` is where "declare a startup or a main"
  lives and no single field is wrong when neither is there.
- **A static field that names a class is a load-order dependency, and it does not
  look like one.** `sources` in `project.json` was documented as mattering "only
  when one class extends another of the same project", and that was one case of
  two: `Lines: Field.List(Line)` in a `Record` runs while `Quote` is being
  declared, so a `Quote.js` listed before `Line`'s file fails with
  `ReferenceError: Line is not defined` — traceback on the declaration, nothing
  anywhere near `sources`. Measured both ways: wrong order throws, and
  `Field.List(() => Line)` in the same wrong order works, because a thunk is not
  looked at until the first value goes through the field. So the thunk is not
  only for a shape that contains itself; it is the escape from file order too.
  `examples/quote` keeps the order instead (`Quote.js` before `QuoteForm.js`,
  `Line` before `Quote` inside it), on the grounds that a dependency written down
  beats one deferred.
- **Copying a record field by field is a claim that goes stale, and it goes stale
  silently.** `Manifest.apply` named three of `ProjectFile`'s fields one per line
  while `ProjectForm`'s header promised that adding a field to the record was all
  it took -- so `Version` was declared, shown by the dialog, refused by the record
  when too long, and then dropped on the way to the file. Every assertion about
  the other three stayed green. A record discovers its own properties
  (`PropertyNames()`) exactly as a widget does; loop, and name only the deliberate
  exception.
- **A `Field.Decimal` rounds to its places, and `Load` was the one coercion
  that did not say so.** `new Decimal(v, places)` rounds the *value*, not its
  display (`new Decimal("19.999", 2) - 20` is `0.00`), so a file saying 19.999
  loaded as 20.00 and the next save wrote it -- while a `2.5` in a `Field.Int`
  beside it was reported. `fieldValue` takes a `notes` list that only `Load`
  passes (an assignment means the rounding: the program chose the field), and
  the value is **kept rounded** rather than reset to the default, since 20.00
  is a thousandth away and `0.00` is not. Trailing zeros (`"19.90"`, `"20"`)
  change nothing and say nothing. `LoadXml` and a `Table`'s rows go through
  `Load`, so they report it too.
- **The order of the two parsers is the whole of a number setter, and getting it
  backwards is silent.** `DecimalBox.Value` takes machine text (`"1234.567"`,
  what a `.form` and `Decimal.toJSON()` carry) and an es_AR desktop's spelling
  (`"1.234,56"`) -- and the locale parser **first** read Argentina's grouping
  separator as a decimal point, so `"1234.567"` became `1234567`: a value off by
  a thousand, from a file the serialiser had written correctly. Machine text
  first, locale second, and only text that is not machine-readable falls
  through.

## Numbers, JSON and bytes

- **`g_ascii_dtostr` is not the shortest text of a double; it is `%.17g`.**
  `dec_from` said it was, in a comment, and read every plain number through
  it -- so `0.2` reached `Decimal` as `0.20000000000000001` and
  `new Decimal("0.1") + 0.2` was refused for *more than 9 decimal places*,
  naming seventeen digits nobody had written, while the documentation promised
  that a decimal mixes with ordinary numbers. The shortest form is the first of
  `%.1g` … `%.17g` that reads back as the same double; a double that is already
  inexact (`0.1 + 0.2` as numbers) still has seventeen digits and is refused
  **as a number**, saying to build the decimal from text. **And no exponent**:
  `%g` writes one when the precision is shorter than the whole part -- `%.1g`
  of 10 is `1e+01`, which reads back as 10 and is not a decimal's text, and
  `lib/report`'s suite went red on it -- and for anything under 1e-4, so a
  small number gets a second try as `%.Nf` up to nine places.
- **`g_base64_decode` ignores what it does not understand.** Hand it `"hello"`
  and it answers three bytes rather than an error, so a value that was meant to
  be text becomes a silent handful of nonsense -- and `Field.Bytes` reads base64
  out of *files*, which is exactly where that lands. The alphabet, the padding
  and the length are all decidable before decoding, so `Bytes.FromBase64` decides
  them. The general shape: a GLib parser that "is lenient" is one whose input has
  to be checked here.
- **`sqlite3_column_blob` before `sqlite3_column_bytes`, always.** That is
  sqlite's own documented ordering: asking for the length first can answer for a
  *converted* value rather than the stored one. The same trap exists for
  `_column_text`.
- **`$$` writes one dollar, so `"$$"` as a replacement string is a no-op.**
  `$` patterns are special in the *replacement* too (`$$` for one, `$&` for the
  match), so escaping `$` for NSIS with `.replace(/\$/g, "$$")` changed nothing
  -- every `$` in the prose reached the script, where it opens a variable that
  is not there. Four in the source for two in the answer (`"$$$$"`), and the
  same family as the comma above: a formatting call whose output is shaped by
  something other than its input. The template-literal spellings next to it had
  the same shape twice -- `` `$\"` `` is `$"` and `` `$\t` `` a real tab, where
  NSIS wants `$\"` and `$\t` -- and all three were caught by a test reading the
  escaped prose back rather than by reading the code.

## Csv: rows of text, in rad.js

`Csv.Parse/Load/Format/Save` live in `runtime/js/rad.js`, beside
`File.LoadJson`, because a CSV reader is a loop over a string and a worker
runs that file too. Its test is `testCsv` in `tests/widgets/WidgetsForm.js`,
and **a `test*` method there runs only when its name is in the list near the
top of that file** (`"Dictionary", "Csv", "Regex", …`): a test added without
it passes by never running, which is what the first version of this one did --
the suite's count did not move, and that was the only sign.

Two decisions a caller relies on:
- **Every value is text.** A parser that guessed numbers would turn the code
  `00123` into `123` for every caller; the application decides (Zabbix
  Reports' `FileConnector` infers a column's kind from all of its values).
- **The separator is detected** from the first record, outside quotes, among
  `,` `;` tab `|`. A spreadsheet in a decimal-comma locale writes `;`, and
  assuming `,` reads one column per line with no error.

## Xml and Record

**XML is a document and JSON is a value**, and everything else follows from it:
`Xml` is a DOM over libxml2 (optional at build time, `Xml.Available`), and a
record maps onto an element by **declaring** `static Xml` -- the same split
`Table` makes for a row. `ToXml` is `Serialize`, `LoadXml` is `Load`, and
`SaveXml` is neither: it writes into the element it was handed and touches only
what the shape models, which is what an interchange round trip needs. Unknown
elements and attributes are reported in `Problems` and never silently written
back -- an unknown node re-emitted at the end of an `xsd:sequence` is a wrong
answer that looks right, so the lossless road is `SaveXml` and not a raw-node
bag. Six things are worth knowing before touching either half:
- **A `key` is identity and is written whatever it holds, so an XML key at its
  default still matches.** `#xmlKeyText` used to answer `null` for a key equal
  to the field's default -- `Table`'s *an int key of 0 is a row never saved*,
  borrowed into a medium with no INSERT -- and the summary task of every MSPDI
  file (`<UID>0</UID>`) was replaced by a fresh element, taking its unmodelled
  children (`CreateDate`, `ActualStart`) and the `UID` element itself with it.
  Matching compares key text always and both verbs write a scalar `key` even at
  its default -- `#xmlKeyed`, asked by `#xmlWrite` and `#xmlSave`, because two
  answers to *is this a key* is the asymmetry that is found later as a bug --
  while every *other* field back at its start still has its element removed.
  Nothing failed because no test had a key at a default -- `XmlRecord`'s were 1,
  2 and 3 -- and the regression now puts `UID 0` beside a `Milestone: false` and
  asserts `ToXml()` writes it too, so the non-key half of the rule is held.
  `Table` keeps its rule: the two media do not share it.
- **A node from another tree is copied in, and `Add` answers the copy.** So
  `el.Add(Xml.Element("X")).Text = "…"` is right, and writing to the element you
  built is writing to a node that is not in the tree -- `Record`'s
  `#xmlInsert` did exactly that, and the round trip showed empty elements. The
  same rule is why `Record.#xmlSaveList` writes a new item *after* it is placed.
- **A removed node is orphaned and not freed**, because a `Children` array
  somebody is holding has to keep answering; the tree's refcount frees it when
  the last wrapper goes. That is why `Remove()` makes the wrapper throw instead
  of reading freed memory, and why a node wrapper is a reference to a tree and
  not to a document.
  **And wrappers are not unique, so the orphan list is kept by the node.** Two
  `Find`s of one element are two wrappers, and `Remove()` silences only its
  own: the second one's `Remove()` put the node on the list twice, and a child
  kept across a `Text` assignment could be `Add`ed back while still on it --
  both a **double free at teardown**, with every assertion green, because the
  free happens when the tree dies and not when the mistake is made. Measured:
  the regression in `testXmlFiles` reported `attempting double-free` under
  `build-asan/` before the fix and is clean after it. `xml_orphan` and
  `xml_adopt` are the only two doors now -- on the list at most once, and only
  while parentless -- and a same-tree move of a detached tree's root (which can
  only land under one of its own orphans) clears `tree->root` as `Remove()`
  does. **A new verb that detaches or re-parents a node goes through those
  two**, and `tests/asan.sh` is the only thing that will say it did not.
- **A list with no `in` lives in the record's own element, so "append" is the
  wrong default for a new item.** `#xmlPlace` used to `Add` an item past the
  last one there, which put it after every later field and every unmodelled
  element -- `<Line/><Total/><Line/>`, which an `xsd:sequence` refuses. The
  MSPDI tests could not see it because every list there is `in: "Tasks"`. It
  goes after the last item of its name now, and with none there, where
  `#xmlSlot` (the same answer `#xmlInsert` gives a scalar) puts it.
- **`#xmlSlot` places a new element by the declared order, so a shape that
  models only part of an `xsd:sequence` has to declare the whole of it.** The
  order was the modelled fields' declaration order and an unmodelled sibling
  did not count: a `<PredecessorLink>` added to a task Project 2010+ wrote --
  one carrying `IsPublished` and `CommitmentType`, neither modelled -- was
  appended after them. An input that validated came back an output that did
  not, nothing else said so, and only `Xml.Schema` could see it
  (`ISSUE-xml-sequence-order`, answered as `static Xml.Order`). The option is
  the type's element names in schema order, the unmodelled ones included as
  the anchors, and **it has to name every element the shape writes** -- one
  left out is refused on the first write, naming it, because a field the
  sequence does not place would otherwise be placed by accident.
  `tests/widgets`' `XmlOrder` holds the same document with the declaration and
  without it against a real `xsd:sequence` (eight assertions, red with the
  option taken out), and the shape with no option behaves exactly as it did.
- **`xmlNewNs` answers NULL for a prefix the element already declares, and says
  nothing.** `SetNamespace` returned `JS_EXCEPTION` with no exception set --
  twice on one `Xml.Element` (no document, so the search was skipped), or a new
  URI on a parsed root with a default `xmlns`. It reads the element's own
  `nsDef` first now: the same URI is reused, another is refused naming the one
  there.
- **`xmlHasNsProp` answers a DTD's default too, and what it hands back then is
  not an attribute.** It looks the name up with `xmlCheckDTD` on, and for an
  attribute the element does not carry but the DTD declares a default for, it
  returns the DTD's `xmlAttribute` *declaration* cast to `xmlAttrPtr`.
  `xmlRemoveProp` then walks that thing's "parent" -- the `xmlDtd` -- as if it
  were an element: `RemoveAttrNS` on `<!ATTLIST r xml:lang CDATA "en">` was a
  segfault (exit 139), and not under the sanitizer build, whose layout
  differed. The type is checked (`XML_ATTRIBUTE_NODE`) before removing; a
  default is not on the element to take out. `RemoveAttr` never had it because
  `xmlUnsetProp` does not consult the DTD. Any new call that answers an
  `xmlAttrPtr` from a lookup wants the same check. And `SetAttrNS` returned an
  empty `JS_EXCEPTION` when libxml2 answered NULL; it throws a sentence now.
- **`Xml` wrote documents it could not read, and only a program that *wrote* XML with it
  found out.** Everything before was reading -- MSPDI, feeds -- and `SaveXml` writes values that
  came out of a file, which were valid XML to begin with. `Xlsx` writes values that came out
  of a database, and building it with `Xml` instead of strings showed three things in one sitting:
  a `U+0001` assigned to `Text` or an attribute was written as the raw byte and **`Xml.Parse`
  refused the output** (*PCDATA invalid Char value 1*); half a surrogate pair -- which a JavaScript
  string may hold, and a `slice` through an emoji makes -- was written as bytes that are not
  UTF-8; and **a NUL cut the text short in silence** (`"a\u0000b"` written as `a`). libxml2 writes
  what it is given; checking is the binding's job. `xml_text_problem` is XML 1.0's `Char` and every
  door text enters by asks it (`Text`, `SetAttr`, `SetAttrNS`, and a namespace URI), refusing with
  the character and its position. **A NUL has to be looked for before decoding**: GLib's
  `g_utf8_get_char_validated` answers it as invalid, which named it "half a surrogate pair".
  A refusal and not a drop, because which characters may be lost is the program's call -- `Xlsx`
  drops them from a cell, deliberately, in its own `clean()`.
- **`SetAttrNS` always searched in scope; what was missing was declaring a prefix.** OOXML writes
  `xmlns:r` on a workbook and `r:id` on each sheet, and the only spelling was moving an element into
  the namespace and back, which left a declaration on every sheet. `DeclareNamespace(uri, prefix)`
  is `xmlNewNs` without `xmlSetNs`. A prefix is required -- a default namespace declared on an element
  applies to the element itself, so that is a contradiction -- and a prefix bound to another URI here
  or above is refused, because shadowing it would move whatever already used it.
- **A child added under a default namespace had none in the tree and the parent's in the text.**
  libxml2 writes a bare `<row>`, which every reader puts in the default namespace; the tree answered
  `""`. `xml_take_default_ns` runs on whatever `Add`/`Insert` placed, down its subtree. The case given
  up is a child meant to have no namespace under a default one, which would need `xmlns=""`; nothing in
  this tree writes one, and `rad.js` reads `Namespace` only off a document's root, which is why the
  change was low risk -- `XmlRecord` and `XmlFiles` stayed green without a line changed.
- **`SetNamespace` skipped the search for a declaration in reach when there was no document**, which
  is every tree built from `Xml.Element`, so a child given its parent's namespace got a second
  `xmlns="..."` written on it. `xml_ns_in_scope` walks the parents by hand and needs no document.
  The three were each put back and went red (`XmlWrite`): the text check, the adoption, the old search.
- **A surplus argument is the binding's to refuse, and two verbs were the hole
  in that.** `Remove` declares none and `Add` one, so `parent.Remove(child)` --
  the call a DOM reads as *take this child out* -- took the **parent** out: on
  a document's root the body was gone, `Root` was `null` and the next
  `File.SaveXml` wrote a two-line file where the plan was. `Add(name, text)`
  wrote an empty element and dropped the value. Five members beside them
  refused already (`Element`, `Insert`, `SetAttrNS`, `Text`), which is what
  made these read as a rule that was left out rather than a style. libxml2's
  `xmlUnlinkNode` has no argument to get wrong and every DOM raises
  (`removeChild` throws `NotFoundError`), so what a surplus means is the
  binding's call -- both throw now, naming the call that was meant
  (`child.Remove()`, `parent.Add(Xml.Element("Name")).Text = text`), and
  `XmlFiles` holds the refusal with the document still intact.
- **`Children` and `Text` cannot answer "is this element empty", and the pair
  is wrong on a document with a comment.** `<r><!--c--></r>` reads as no
  children and no text, so a leaf-by-leaf walk reported it with the value `""`
  -- and `Record`'s mapper, deciding an emptied list takes its wrapper out,
  deleted the comment. `IsEmpty` is `node->children == NULL`: every kind of
  child counts, attributes do not, so `<r a="1"/>` is empty and `<r>  </r>` is
  not (measured -- `XML_PARSE_NOBLANKS` keeps a whitespace-only text node when
  it is the root's only child). `Comments` is the text of the direct comment
  children, which is the content `Text` cannot carry and what lets a diff
  report a change to one. `XmlFiles` asserts the pair, including that a
  comment survives the writer and is still readable after a parse.
- **Indentation was measured and kept.** The canonical shape is 59 % more bytes than a flat one, and
  5.5 % once deflated into a zip -- not worth an option.
- **`Field.DateTime` exists because XML's `dateTime` is a date and a time**
  together, which `Date` and `Time` cannot say between them; and the namespace
  on `static Xml` is a **list** because MSPDI's own XSD and its own files
  disagree about the URI (the schema says `/2007`, Project writes without it),
  measured. The first is written, all are accepted on read.
- **The object `LoadXml` builds is keyed by the file's spelling, not by the
  property name** -- `Load` looks a field up by `as`/`Naming`, exactly as it
  does for a JSON file. MSPDI spells every property the same as its element and
  hid this; the first format that says `Naming = "lower"` (`examples/feeds`,
  where RSS hands over `<pubDate>`) found **every field silently at its
  default**. A shape with a naming rule or an `as` needs a test that reads one.
- **`SaveXml` on a list was its square, and the fix has four parts that are
  easy to mistake for one.** Measured before: an 8000-task MSPDI plan was a
  **151 s** save against a 3 s read (`ISSUE-xml-list-cost`); after, **0.37 s**,
  and linear -- 16000 in 0.74 s. The parts, because each was arrived at by
  getting it wrong first:
  - **Matching a list by key was a `Find` per existing element, per item** --
    `Find` builds a wrapper and walks the holder's children every call. The key
    text of every existing element is read **once** into a `Map` of queues; the
    unkeyed road keeps a cursor instead of `used.indexOf(false)`. Both were
    quadratic in the same loop.
  - **`#xmlPlace` read `holder.Children` per item**, a fresh array of wrappers
    each time. It reads once now, and an item already in place is a comparison.
    **The comparison cannot be between wrappers**: `FindAll` and `Children`
    hand out *different objects wrapping the same node*, so `nodes[i] ===
    wanted[i]` is false for every item already in position -- the first version
    of this fix compared them, paid a move per item and the square came back.
    What is the same across the two walks is the **order**, so `#xmlSaveList`
    renumbers the survivors and passes `from[i]` (an index, `-1` for a new
    item), and `#xmlPlace` compares positions. The round trip returns before it
    even reads the children.
  - **A no-op `Text` write is not free: it grows the tree's orphan list.**
    `Text =` unlinks the old children into `tree->orphans` so a wrapper keeps
    answering, and `xml_orphan` walks that list -- so a save of an *unchanged*
    document made the next save slower without bound. Measured: four identical
    saves of an 8000-task plan took **458, 1388, 2347 and 3807 ms**. `#xmlSave`
    skips a scalar whose element already holds that text (a child with element
    children is still written, because its text is a reading of them), and an
    attribute already equal is not set. This is also why the orphan list is
    worth watching: a program that keeps assigning new text to one element
    leaks a text node per assignment until the document dies.
  - **`#atDefault` compared a list through `JSON.stringify`**, which serialises
    every item -- a full `Serialize` of an 8000-task shape on every save, to
    answer a question `length` answers. An empty `def` is `length === 0` now;
    a non-empty one is still compared by value. `#xmlOrder` is cached per class
    for the same reason: it depends on the declaration and was rebuilt per
    record.
  `tests/widgets`' `XmlRecord` holds a 2000-task save under a seconds-wide
  bound (the old code took 6.5 s there) and asserts an unchanged document comes
  out as it was.
- **XSD validation is `Xml.Schema(text|doc|element)` once and
  `schema.Validate(doc)` as often as a file arrives**, and five things were
  measured or chosen before it could be (libxml2 2.12.10, the 240 KB MSPDI
  schema):
  - **The compile is the object and the check is the verb**, because the
    compile is 70-90 ms and validating is ~2.9 us a task -- 3 ms for a
    thousand, 23 ms for eight thousand. A one-shot `Validate(doc, path)` would
    re-pay the compile on every autosave.
  - **Nothing is written into the document.** libxml2's validator adds a
    schema's default and fixed attributes to the instance when asked with
    `XML_SCHEMA_VAL_VC_I_CREATE` -- measured: two attributes appear in the tree
    -- and this never sets it, because `SaveXml`'s promise is that it touches
    only what the shape models, and a default injected at the check would be
    written to the file at the next save. `testXmlSchema` asserts the default
    stays out.
  - **Includes and imports are refused before the compiler sees them.**
    `xmlSchemaNewDocParserCtxt` resolves `xs:include`/`xs:redefine`/an
    `xs:import` with a `schemaLocation` through the process's external entity
    loader -- measured trying `http://example.invalid/o.xsd` -- and a *failed
    remote* import is only a warning: it compiles anyway and validates against
    something incomplete, in silence. MSPDI is one file with no includes, which
    is the shape this asks for; the walk refuses the document that would fetch
    one, naming it.
  - **An element is only validatable in a document.** `xmlSchemaValidateDoc`
    takes the document; `xmlSchemaValidateOneElement` answers `-1` with *no
    instance to validate* for a detached node (`Xml.Element`, a `Copy()`), so
    the verb refuses one with a sentence and a document or one of its elements
    are the roads. `Validate` also takes a document, in which case the root is
    what is checked.
  - **A schema error is a line and no column.** libxml2 reports the element
    (`e->line`) and `int2` is `0` for every schema error measured, unlike
    `Xml.Parse`, so `Validate` answers `{ Message, Line, Column }` with
    `Column` always `0` -- uniform with `Application.CheckSource`, and honest
    about what the engine gives.
  - **The namespace mismatch is the caller's remap, measured both ways.**
    Project writes `http://schemas.microsoft.com/project` and the official XSD
    declares `/2007`, so validating a real file as-is fails at the root (*No
    matching global declaration*). Rewriting the two URIs in the XSD text
    (`File.Load(path).split(old).join(new)`) before `Xml.Schema` makes the
    unmodified file validate -- 9 of the 10 fixtures in `bintana-project`'s
    corpus, which is the same answer the external `xmllint` + sed harness gets.
    An option was not invented for it: the remap is the caller's two lines.

`examples/feeds` is the first real caller: two shapes (RSS 2.0 and Atom 1.0)
over one list, and the four format facts worth knowing -- RSS dates are RFC 822
and stay `Field.Text`, Atom's are ISO and keep their zone, an element's own
text cannot be modelled beside its attributes (`<guid isPermaLink>`), and
`<link>` versus `<atom:link>` is one local name from here.

## Database.Sqlite and Table

- **SQL identifiers are case-insensitive, and that makes a `Naming` rule that is
  nearly right the worst kind of bug.** A record whose column comes out `Code`
  against a table column `code` *writes perfectly* -- sqlite accepts `"Code"` as
  naming the same column -- and *reads empty*: `Record.Load` matches a file's
  keys exactly, so `code` is a key the shape does not describe, goes into the
  unknown-keys bag, is faithfully kept and handed back on the next save. The
  record comes out at every default with the real values hidden inside it,
  nothing throws, and the first thing anybody notices is a form full of blanks.
  Found within minutes of writing the first `Table`, in a test class that had no
  `Naming` line. `Table.#fit` compares the shape against `Columns()` on the first
  statement and refuses; it catches a missing column and an absent table on the
  way.
- **`#fit` runs before the structural check, so the order of the two matters.**
  A shape with a `Field.List` pointed at its master's table reported *"wants a
  column 'lines'"* -- true, and a red herring: the real answer is that a detail
  is a table of its own and is not built. Shape-only facts are checked first, and
  the shape-versus-table comparison second.
- **`Table` lives in `rad.js` and cannot move.** Not only for
  `docs/extending.md`'s *"prefer JS"* rule: a record's values are in a private
  bag scoped to `Record`, so nothing outside that file can read them. The same
  argument rules out a `lib/data` library, and it is why `#o` (change tracking,
  for a partial UPDATE) will have to be written there too.
- **A row is a file, and it is not a coincidence.** `Load` reads an object keyed
  by whatever `Naming` spells and `Serialize` writes one with decimals as text,
  so `Table` converts nothing. `Naming = "snake"` had no user for as long as it
  existed and needed no change to become the SQL spelling; `Field.Bool` already
  took sqlite's `0`/`1` and `Field.Date` already held `YYYY-MM-DD`. Do not add a
  conversion layer -- if a value needs one, the field kind is what is wrong.
- **The doctrine, and it is the maintainer's: a `Table` uses sqlite's standard types and
  invents no format of its own. What sqlite cannot do is sqlite's limitation and
  is said as one; the program filters and orders; and the extension exists,
  opt-in, always warning that it makes the file incompatible.** This was arrived
  at after two wrong turns, and writing down what they were is cheaper than
  taking them again:
    1. **TEXT with a `COLLATE DECIMAL` in the schema.** Correct for us, and
       measured from another client against a file this runtime had written:
       `ORDER BY`, `MIN`, `MAX`, a comparison and `CREATE INDEX` on that column
       all fail with `no such collation sequence`. A `.db` only one program can
       query is not a `.db`.
    2. **An `INTEGER` of the field's units.** Portable and native for every
       aggregate -- and an invented storage format, which is what the doctrine
       refuses. It also cost `Serialize` its best property, that a row *is* a
       file.
  So: `Field.Decimal` -> `TEXT`, the program totals and sorts, and if an
  application's core is money then sqlite is a fair thing to call the wrong
  engine.
- **`NUMERIC` and `DECIMAL(12,2)` are affinities, not types.** Measured:
  `'19.90'` into either comes back as the REAL `19.9`. So an ORM that declares a
  `decimal` column in sqlite is storing a double, which is what `Decimal` exists
  to prevent -- worth knowing when comparing this design against Django's or
  Rails'. `Table` refuses a decimal field over any column whose affinity is not
  TEXT, judged by `sqliteAffinity` in rad.js, which is sqlite's own five rules in
  sqlite's own order.
- **The driver binds a `Decimal` as its own exact text, and what the column does
  with that text is affinity -- which the driver cannot see.** Into TEXT it stays
  exact; into a numeric column sqlite converts it to a REAL and the scale is
  gone. Asserted in the suite, because it is the one way it stays known.
- **The reason to distrust `SUM` on a decimal column is not the obvious one.**
  I first wrote *"it goes through a double"* implying lost cents, then measured
  it: **sqlite has Kahan-Babuska-summed REAL since 3.44**, so small totals come
  out exact. That makes `SUM` *worse* to rely on rather than better -- it looks
  right until it is not. The real costs: the answer is a REAL, so the scale is
  gone (`30`, not `30.00`) and it re-enters the program as a double; and past
  2^53 a double cannot tell whole numbers apart, so
  `9007199254740993.00 + 0.01` comes back `9007199254740992`. `AVG` has no exact
  form at all -- three tenners and a cent average to `10.003333333333332`.
- **A collation has to be a consistent *total* order, because sqlite builds
  indexes with it.** The first version of `decimal_collation` copied the two
  values into 64-byte stack buffers and **truncated**, which would make two long
  strings compare equal and an index built on it able to lose rows. It uses the
  stack buffer only when the bytes fit and `g_strndup` when they do not. For the
  same reason text that is not a decimal is *sorted* (after every decimal, by
  `strcmp`) rather than refused: refusing would be refusing to sort a table
  because one row is wrong.
- **`dec_parse` was split so a sqlite callback could use it.** The scanning half
  is `dec_scan`, which throws nothing and returns *how* it failed; `dec_parse`
  adds the complaining. The reason is that a collation runs in the middle of a
  statement, and that is the last place that may leave a JS exception pending --
  there is nobody to hand it to, and the next thing to touch the context would
  report it instead of its own trouble. `bta_decimal_from_text` and
  `bta_decimal_to_text` are the two exports.
- **`Execute` refuses a second statement, and that is load-bearing.** sqlite
  compiles up to the first `;` and hands back the tail; running only the head and
  reporting success is the bug. `Script()` is the multi-statement one and takes
  no parameters, since a script has no values.
- **Parameters are counted before any are bound.** sqlite binds what it is given
  and leaves the rest NULL, so three values into a statement with four `?` runs
  and answers about a NULL -- a *wrong answer* rather than an error.
- **The optional-dependency branch has to be compiled to be known to work.**
  `-DSQLITE3_FOUND=OFF` does nothing -- `pkg_check_modules` overwrites it -- so
  the way to check the `#else` half of `bta_sqlite.c` is to compile that one
  translation unit with the define removed, taking the command out of
  `build/compile_commands.json`. It had a `-Wmissing-field-initializers` warning
  that the ordinary build could not see.
- **QuickJS pads `argv` up to the arity the table declares, so a missing argument
  is `undefined` and not a short `argc`.** `db.Query()` reached sqlite as the
  literal statement `undefined` and came back *"no such column: undefined"* -- a
  real complaint about the wrong thing, which is worse than none. Every C
  function that reads `argv[0]` needs an `argc` check even though the signature
  looks like it guarantees one.
- **`Transaction` finishing on a connection the callback closed was a NULL
  dereference.** `Close()` inside a transaction is odd and reachable, and the
  COMMIT afterwards ran `sqlite3_exec` on a freed handle. There is nothing to
  finish in that case -- `sqlite3_close` rolls an open transaction back itself --
  so it is a sentence now. The general shape: any C function that calls back into
  JS has to re-check whatever the callback could have invalidated.
- **`Connection` is a base class with an empty prototype, and the emptiness is
  the design.** `bta_database.c` owns it and the `Database` object; each driver
  (`bta_sqlite.c`) makes its own `JSClassID` and builds its prototype with
  `JS_NewObjectProto(ctx, bta_connection_proto(ctx))`. That one line is what puts
  `rad.js`'s `Table` in the driver's chain and makes `conn instanceof Connection`
  true. Get it wrong -- a prototype built with `JS_NewObject` instead -- and
  `conn.Table` is simply not there, with nothing to say why. The four invariants
  (`instanceof`, `Table` on the base, `Query` *not* on the base, `Database.Sqlite`
  present) are asserted in `tests/widgets`'s `Database`, because each of them is
  the kind of claim that rots in a comment.
- **The language is curated, so the obvious way to check a prototype chain is not
  there.** `Object.getOwnPropertyNames` does not exist (nor most of `Object` --
  see `llm/issues.md`), and a probe written with it fails as a bare
  *"TypeError: not a function"* pointing at the column, which reads like the
  thing under test being broken. Check a chain with `instanceof`, with
  `typeof X.prototype.Member`, and by comparing `obj.Member ===
  Base.prototype.Member`.
- **Every one of sqlite's own aggregates is a window function, and a custom one
  registered with `sqlite3_create_function` is not.** `pragma_function_list` says
  `type='w'` for all 33 built-ins and said `type='a'` for `decimal_sum`, so
  `decimal_sum(p) OVER (ORDER BY id)` answered *"decimal_sum() may not be used as
  a window function"* -- and a running total down a column of amounts is most of
  what a report is. `sqlite3_create_window_function` takes four callbacks instead
  of two: xStep, xFinal, xValue and **xInverse**, which takes a value back *out*
  of the frame. Two consequences for the accumulator: a flag for "something in
  here was not a decimal" had to become a **count**, since a bad value can leave
  the frame again and a flag could never be put back; and because the
  accumulator's scale only ever widens, a running total can be written with more
  places than the rows currently in the frame have.
- **If a program does opt into the collation, the map of what it fixes and what
  it cannot is much smaller than it looks.** Measured on 3.51.2: `min`/`max` are
  correct through the collation; the whole positional family (`rank`,
  `dense_rank`, `row_number`, `ntile`, `cume_dist`, `percent_rank`, `lag`,
  `lead`, `first_value`, `last_value`, `nth_value`) is correct because an `OVER`
  clause's `ORDER BY` uses the column's collation; `count`, `group_concat`,
  `string_agg` and `json_group_array` are fine, and `group_concat(x ORDER BY x)`
  -- the aggregate's own `ORDER BY`, 3.44 and later -- uses the collation too;
  `median` and the `percentile` family **refuse** a text column (*"input to
  median() is not numeric"*), which is a loud failure rather than a wrong answer.
  Exactly three are wrong and quiet: `sum`, `total`, `avg`.
- **`decimal_avg` and `decimal_total` are absent on purpose.** An exact average
  of decimals is not a decimal at all -- 118.25 over three has no text -- so such
  a function would have to round, and how many places is the caller's decision.
  `total()` is only `sum()` answering 0 instead of NULL. Do not add either
  because the pair looks incomplete without them.
- **`ORDER BY` in sqlite compares bytes, so it is not the language's order
  either.** It puts `Ñanculeo` after `Zapata` and `Álvarez` last -- the mistake
  `examples/contacts` was written about, arriving from the database this time
  instead of from `localeCompare`. The doctrine above answers it the same way it
  answers decimals: **the program orders**, with `Locale.Compare`. A `LOCALE`
  collation would be the first wrong turn again, and there is a measurement
  against it beyond portability -- `g_utf8_collate` is ~1,5 us a comparison, so
  100 000 rows is two seconds unless indexed, and an index built on a custom
  collation is exactly what another client cannot read. It stops being an answer
  at stage 3's cursor, where the rows are not all loaded; `docs/plans/data-plan.md`
  carries that as an open question with two candidates.
- **A failed `sqlite3_bind_*` left its parameter NULL and the statement ran
  anyway.** `bind_one` returned `true` whenever the JS value was convertible,
  so `SQLITE_NOMEM` or `SQLITE_RANGE` became a wrong answer rather than an
  error. Every bind goes through `bind_ok` now, which throws sqlite's own
  message for that parameter; a `Bytes` past `INT_MAX` is refused up front
  rather than truncated into a shorter length.
