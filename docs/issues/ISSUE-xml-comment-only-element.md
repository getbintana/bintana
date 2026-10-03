# ISSUE: an element holding only a comment cannot be told from an empty one

## What the application needed

`bintana-project` promises that opening and saving an MSPDI plan leaves
everything it does not model exactly where it was -- timephased data, baselines,
the header comment, the exceptions of a calendar -- and it proves the promise by
reporting what a save changed, leaf by leaf, in a document called `touched`.
Walking a tree leaf by leaf needs one question answered per element: **is this
element empty?**

MSPDI files written by the desktop tool carry comments, including inside
`<Project>`, and the fidelity notes pin the header comment of every fixture as
something that must survive the round trip. So a container holding a comment and
a container holding nothing have to be two different things to that walk.

## What I wrote instead

The walk decides "empty" from the element children, because that is the only
reading available, and it is written down where the walk is:

```js
function leafValues(el, path, out) {
    const kids = el.Children;
    if (!kids.length) {                       // nothing inside: this is a leaf
        out.push(`${path}=${JSON.stringify(el.Text || "")}`);
        return;
    }
    ...
}
```

The consequence is that a comment is not a leaf and not a child, so it is in no
category the walk has: `<r><!--c--></r>` is reported as a leaf with the value
`""`, and a change to that comment cannot appear in `touched` at all. The same
reading is what the record mapper uses to decide that an emptied list takes its
wrapper out -- and there it deletes the comment.

## The code I wish I could have written

The question, asked of the same element:

```js
if (el.IsEmpty) { ... }        // nothing in it at all: no element, no comment, no PI
```

## Why the existing words do not cover it

Between them the accessors cover character data and element children and nothing
else, so an element with a comment in it has no description:

| asked | `<r><!--c--></r>` |
|---|---|
| `el.Children.length` | `0` |
| `el.Text` | `""` |
| `el.AttributeNames()` | `[]` |
| `el.Parent.Name` | whatever holds it |

and the comment is still there, because it is written back where it was found.
Measured on the same element, the one operation that follows from the reading
above: `Remove()` on a `<r>` that holds only a comment takes the comment with it,
and `<p><r><!--c--></r></p>` becomes `<p/>`.

This is not the mixed-content price, which is written down and is a price worth
paying: `Text` collecting every character under an element is what makes a leaf
one value. A comment is not character data, so `Text` is right to be empty, and
`Children` being element children only is stated in the reference. What is missing
is the third question -- *what else is in this element* -- and without it every
emptiness test in a program is wrong on a document that has one, including the
one this application uses to decide whether anything needs saying.

## Prior art

The DOM's `childNodes` includes comments and processing instructions, `nodeType`
tells 8 from 7, and `hasChildNodes` counts them -- which is what makes "is this
element empty" a question with an answer. .NET's `XmlNode` has
`ChildNodes` of `XmlNodeType`, and its `XElement` treats a comment as content.
Python's `ElementTree` keeps comments as elements in the tree when asked to.

## How much it mattered

It works, and a part of it is noticeably worse: the diff cannot report a change to
a comment, and an emptiness test deletes one. It is a small issue and it is filed
because it is the one place where the promise the application makes about other
people's files has a hole in it that no amount of care on this side can see.