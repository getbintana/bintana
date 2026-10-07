# ISSUE: `SaveXml` cannot place a new element among children its shape does not model

## What the application needed

To save an edited MSPDI plan so the schema still accepts it. MSPDI is an
`xsd:sequence`: a `Task` is `… PredecessorLink … ExtendedAttribute Baseline
OutlineCode IsPublished … CommitmentType TimephasedData`, in that order. Files
written by Project 2010+ carry `IsPublished` and `CommitmentType` on every task;
the application does not model them and `SaveXml` is meant to leave them alone.
Adding a link to a task that has none must put `<PredecessorLink>` *before*
them.

## What I wrote instead

Nothing yet; it is reproduced, not worked around. A task with
`<IsPublished>` and `<CommitmentType>` and no link, one link added through the
shape and `SaveXml`, then `Xml.Schema(...).Validate`:

```
PredecessorLink: This element is not expected. Expected is ( TimephasedData ).
```

The link was appended after `CommitmentType`. The input was valid; the output is
not. The same happens to a new `Baseline` after those, to a new `BudgetCost`
after an assignment's `TimephasedData`, and to variance fields added after
`FixedCostAccrual` or `Milestone`/`Overallocated`.

The only application-side road is to declare every later element name as a
field in the shape, modelled or not -- which makes the shape lie about what it
understands and invents a read/write policy for fields nobody reads.

## The code I wish I could have written

```js
class MspTask extends Record {
    static Xml = {
        Root: "Task",
        // the schema's whole sequence, so a modelled element knows where it
        // goes relative to the ones this class never touches
        Order: ["UID", "ID", /* … */ "PredecessorLink", "ActualWorkProtected",
                /* … */ "IsPublished", "CommitmentType", "TimephasedData"],
    };
    // fields declared as today; only the modelled ones are read and written
}
```

## Why the existing words do not cover it

`Record.#xmlOrder` builds the order from the **modelled** fields alone, and
`#xmlSlot` inserts a missing element before the first child the order puts
after it, or at the end when there is none. Unmodelled siblings are not in the
order, so they do not count: with the new element's successors all unmodelled
there is no "first sibling declared after", and the answer is the end -- past
elements the schema puts later. `SaveXml`'s promise (touch only what the shape
models) is kept; the placement it makes in the gaps is not the schema's.

## Prior art

The `xsd:sequence` itself, which is the order. XML binding tools (JAXB's
`propOrder`, .NET's `XmlElement(Order = n)`) take the order as a declaration
that is independent of which members the class maps.

## How much it mattered

It blocks the acceptance criterion of the application: "an edited XML opens in
Project without a repair dialog". It is silent -- no golden sees it, only a
schema check -- and it only shows with files that carry elements the shapes do
not model, which is every real file from Project 2010+. `Xml.Schema` is what
made it visible; the report is a fixture away from a test.
