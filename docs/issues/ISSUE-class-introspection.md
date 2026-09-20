# ISSUE: asking what a type has means building one

## What the application needed

To know what a control class offers **without making one**: which properties a
property grid should show for a `Button`, which of them hold prose the extractor
should collect, what a completion popup should offer after a type name.

## What I wrote instead

A disposable instance, made and deleted, six times:

```js
baseProperties() {
    const common = null;
    for (const type of Widget.Types()) {
        const probe = Widget.New(type);
        /* ...intersect probe.PropertyNames()... */
        probe.Delete();
    }
}
```

`PropertyGrid.baseProperties()` (`PropertyGrid.js:200-229`) constructs **every
type there is** to intersect them. `Names.sampleFor` (`:161`) builds one per type
and caches it. `Strings.textPropertiesOf` (`:211`) builds one, and a bare
`new Form()` for the form's own. `Completion` goes through `sampleFor`.
`Classes.componentProbe` (`:826`) does it for a project's own components, and
`Check.js:64` keeps `this.bareForm = new Form()` for the same reason.

## The code I wish I could have written

```js
Widget.PropertyNames("Button")      // or Button.PropertyNames()
Widget.EventNames("Button")
Widget.TextProperties("Button")
```

## Why the existing words do not cover it

`PropertyNames()`, `EventNames()` and `TextProperties()` are all on the
**prototype**, so they need a receiver, and `Widget.Types()` answers with names.
The three of them are already computed by walking the prototype chain and the
class table -- `class_list_of` and `w_property_options` in `bta_widget.c` read
statics off each `constructor` on the way up -- so the instance is not what holds
the answer. The serialiser knows this too: it discovers what to save by walking
accessors on the prototype, not by asking a widget.

Making one is not free and is not always safe. A `Form` probe is a window; a
`Terminal` probe wants a pty; `Widget.New` refuses entirely in a project with a
`main`, which is why `tools/typings` has to be a form project run headless with
a window nobody sees.

## Prior art

.NET `TypeDescriptor.GetProperties(typeof(Button))` and reflection generally.
Delphi's `GetPropList` takes a class reference. Qt's `QMetaObject` is a static
member. Every designer-bearing toolkit answers this about the *class*, because a
designer has to fill a palette before anything is placed.

## How much it mattered

Six sites, one of which instantiates every widget class the runtime has in order
to ask them all the same question. It is also the reason `tools/typings` cannot
be a console project -- the generated `bintana.d.ts`, which `tests/api.sh` holds
the public surface to, is produced by a program that opens an invisible window
because there is no way to ask a class anything.
