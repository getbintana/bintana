# Widgets

The property and event tables are in [llm/controls.md](llm/controls.md), said
briefly, and the same members explained are in [reference/](reference/README.md).
This document is what those tables cannot say: what each widget is made of, and
the behaviour that comes with that.

## Widget — the base

Every widget is one to three `GtkWidget`s (`gtk` / `inner` / `slot`; see
[architecture.md](architecture.md#the-object-model)).

**Geometry.** `Width`/`Height` are `set_size_request`, a **minimum**, so a control
whose natural size exceeds the request renders larger than the `.form` says — a
`Label` with long text is the usual surprise. `X`/`Y` only mean something inside a
`Fixed` parent; in a box the parent decides. `Move`/`Resize` are the same as
assigning the pair, and exist because that reads better in a loop.

The getters report what was **requested**, falling back to GTK's allocation when
nothing was. So `Width` on a control the `.form` never sized returns 0 until a
frame has passed, and `OriginIn()` before the first frame answers `(0,0)`.

`Bounds([container])` is the other side of it: `{X, Y, Width, Height}` as GTK
actually allocated, in the window's coordinates or in the given container's. It is
what makes the request-versus-reality difference visible — a `Label` declaring 120
and drawing 433 has stretched whatever holds it, and nothing else says so. What it
returns is the *drawn* box, so a theme's margins make a `Button` come out smaller
than the size it was given, while a `Panel` matches exactly.

**Focus.** `SetFocus()` moves it, `Focused` reports whether it is here, and
`GotFocus`/`LostFocus` fire when it arrives and leaves. All three answer for the
*control* and not for the widget GTK happens to have given it to: a `TextBox`'s
focus sits on the `GtkText` inside its entry, and an editor's on the view
inside its scroller, so both would answer `false` to `gtk_widget_has_focus()` on
the outer widget. What is asked instead is whether the focus is *contained* —
`GtkEventControllerFocus`'s own question — and the controller is kept on the widget
because it is the only thing that can answer it.

`Focused` is read-only: where the focus is is a fact about the moment, not part of
a design, and a setter would have the serialiser write it into the `.form`.

Leaving a control is where checking what was typed belongs — `Activate` (Enter) is
only the other half of "done editing". A check that ran on every keystroke would
refuse a value halfway to being valid, which is a mistake this repository has
already made once, in the find bar's half-typed regular expression.

`Dump()` renders the subtree as text with those numbers, one line per widget,
marking the hidden ones — a window in a dozen lines, which unlike a picture can be
diffed and asserted on.

**Where a control sits.** `HAlign`/`VAlign` answer it, and the answer is carried
out by whatever the control is in.

*On a drawing surface* they say what becomes of it when the surface is not the
size the coordinates were written for: `Start` stays put, `End` keeps the distance
to the far edge and slides, `Fill` keeps both and stretches, `Center` keeps the
proportion and moves half the slack. This is what a drawn form uses to survive a
resize without being rebuilt out of boxes; see
[architecture.md](architecture.md#anchoring-what-a-fixed-surface-does-with-the-slack).

*In a box* — or a split, or a page — they are handed to GTK and say where the
child sits in the cell it was given: `Fill` takes the whole of it, `Center` sits
in the middle at its own size, `Start`/`End` against either edge. Same four
words, which is why they are GTK's own: a control that stretches is `Fill`
wherever it lives.

`Auto` is the default and the fifth word, because the two disagree about what
*nothing was asked for* means — a drawn control stays where it was drawn, and a
child of a box fills its cell. Naming that disagreement is what lets the other
four mean the same thing in both, and it is what keeps a form that never said
anything from moving or from writing an answer it never gave.

The distinction is real work, not bookkeeping: a `BtaFixed` allocates a rectangle
it worked out itself, and GTK would then align the widget *inside* it — a control
drawn 200 wide with `Start` would come back its natural width. So a child of a
surface is left `Fill` as far as GTK is concerned and the surface does the
arithmetic; everywhere else the word goes straight through. Which of the two
applies is re-asked every time a control is added or moved, because a control
changes containers — `Arrangement` alone turns a row into a surface under it.

On a stretched axis `Width`/`Height` stop being a minimum — the size is derived,
so the number in the `.form` is the size it was *drawn* at and the window may be
made smaller than that. What stops it is `MinWidth`/`MinHeight`, or, when neither
is declared, what GTK says the control needs. Declaring one is how a form says
how small is too small, and it only means anything on an axis that stretches: on
any other the drawn size is already the minimum.

`Expand`/`HExpand`/`VExpand` are the other
half of the same question and belong to elastic containers: they decide who
absorbs the slack when there are cells to share out, which a fixed surface has
none of.

**Style** is how a control is dressed: the CSS classes it wears, as a list —
`"danger"`, `"card title-3"`. The classes come from `<project>/app.css`, which the
runtime loads at `GTK_STYLE_PROVIDER_PRIORITY_APPLICATION` because it is found by
name beside `project.json` (see [formats](formats.md)), or from the desktop's
theme, which declares a good many of them already.

**Which classes exist is the theme's answer, not this runtime's.** The grid's
drop-down offers a starting set and whatever `app.css` declares, and it can be
neither complete nor closed; [the vocabulary](#styling-the-vocabulary) below is
the reference, generated from the theme this machine has, together with the node
each control is — which is what decides whether a class can match at all.

What is stored is the list normalised to single spaces, and only what `Style` put
on the widget comes off again when it is reassigned: a control's own classes are
GTK's (a `Button` is `button`) and the per-widget colour class below is ours.
A name that is not a CSS identifier is **refused**, unlike a font family or an
icon name — nothing downstream could ever resolve one, so a typo is only a typo,
and it would show up as *the style did nothing*.

**Colour.** `Background` and `Foreground` take any CSS colour and are applied
through a CSS class unique to that widget, allocated lazily — most widgets never
set one. Assigning `""` restores the theme's. Setting a background also emits
`background-image: none`, or a themed `Button`'s gradient would cover the colour.

**`Border`** completes that list — `"2 dashed #3584e4"`, a width then a style then
a colour, normalised on the way in the way `Shadow` is. It is there because a
*class* wants one, which is the next paragraph but one.

**`FontScale` and `Opacity` are there because the theme's own classes are made of
them.** Read GTK's Adwaita and every type class is the same shape:

```css
.title-1 { font-weight: 800; font-size: 200%; }
.heading { font-weight: 700; font-size: 110%; }
.caption { font-weight: 400; font-size:  90%; }
.dim-label { opacity: 0.55; text-shadow: none; }
```

A weight and a size **in per cent**, and never a family — which is what lets them
compose, and what makes them follow a desktop whose font or text scale is not
yours. `.dim-label` is not even a colour. A Pango description can say neither: it
has no notion of *one and a tenth of whatever is in force*, and none of dimming.
So `FontScale = 1.1` is that 110% and `Opacity = 0.55` is that dim. **`1` is
"nothing said" for both**, and it is what they start at: `font-size: 100%` is a
declaration like any other, so on a control also wearing `.title-1` it would win
and undo it — the same reason `font-weight: 400` is not written. A scale of `0` is
refused, since a size of nothing is not a size.

That default is also what makes them usable: a spin that opens on the end of its
own range has a button that does nothing, and one that opens at `0` makes the text
5% tall on the first click. Both were true before this was `1`.

**And a partial font says only what it was given.** `Font = "Bold"` is
`font-weight: 700` and nothing else; `Font = "12"` is `font-size: 12pt` and
nothing else. That took a fix:
`pango_font_description_from_string` marks weight and style as *set* whatever the
text said, so every rule used to carry `font-weight: 400; font-style: normal` —
noise on a control, and on a class an override of whatever the theme or the class
before it had said. What is lost is spelling *regular* over something bold, which
reads the same as saying nothing.

**`StyleRule()`** is what those seven come to as CSS:

```js
w.Background = "rgb(255,0,0)"; w.Radius = "6"; w.Font = "Cantarell Bold 12.5";
w.StyleRule()
// background-color: rgb(255,0,0); background-image: none; border-radius: 6px;
// font-family: "Cantarell"; font-size: 12.5pt; font-weight: 700; …
```

It exists so that the IDE's class editor can write `app.css` **without writing
CSS**: it sets these properties on a control nobody sees and asks what they come
to. The units added on the way out, the colours re-serialised and the three ways a
font size reaches a stylesheet wrong are written once, here, in the code that
already had to get them right — a second spelling in JavaScript would drift the
first time one of them was fixed.

They, and `Font` below, load at `PRIORITY_APPLICATION + 1`: one above the
application's stylesheet, so a colour set on a control by hand still wins where it
is used. That is the whole of the arrangement — the sheet is the norm and these
are the exception, and an exception that lost to the sheet would be no use. What
they are *for* is what a class cannot say: a colour computed while the program
runs, which is what the designer's own selection bars are.

The tree agrees with that division on its own: across the thirty-nine `.form`
files here, `Style` is declared 125 times and `Background` three — all three of
them rulers in `examples/i18n`, which are marks to measure against rather than
design — while `Foreground`, `Font`, `Radius`, `Padding` and `Shadow` are declared
**none**. Every use from code is the IDE's, and every one of them is a colour it
worked out: `on ? SELECT_COLOR : ""` on a palette row, the outline of a selection,
the grey around the canvas.

**On a control that has a view of its own, the colour dresses the frame, and that
is usually invisible.** A `ListBox` is a `GtkScrolledWindow` with a `GtkListBox`
inside it; `Background` is applied to the outer one and the list paints its own on
top, so nothing shows — measured, and the same goes for `RowList`, `TreeView`,
`TableView`, both editors, `Terminal`, `Flow` and `Switcher`. `Foreground` loses
there too, and for a subtler reason: colour would inherit, but the theme names
`list` and `textview` explicitly and a more specific rule wins.

**The answer is a class, and it is not a workaround — it is what a cascade is
for.** `Style` puts the class on the same outer node, and a selector walks down
from it:

```css
.mine list     { background-color: @theme_selected_bg_color; }
.mine list row { color: @theme_selected_fg_color; }
```

Those two `@names` are the desktop's own, out of GTK's Adwaita, so the sheet
follows the theme instead of freezing a colour into it. Check a name before
reaching for it — `@accent_bg_color` and its family are libadwaita's, and GTK's
own theme does not define them; an undefined one makes the whole declaration
invalid and the rule quietly does nothing.

That works today with nothing added to the runtime, which is why there is no
per-widget rule here saying where a colour lands. Such a rule would also be wrong
where it matters most: the one composite anything in this tree really does colour
is a `Scroller` — the designer's canvas surround — and there the outer node is the
one meant. A table of exceptions, to reach a place the stylesheet already reaches.

**Font** is a Pango description — `"Cantarell Bold 12"` — applied through the same
per-widget CSS class as the colours, and `""` restores the theme's. It is parsed
and written back out, so what is stored is Pango's own spelling and never the
string as typed: a `.form` cannot smuggle anything into the stylesheet through
here, which is the same care the colours take.

It does not judge, though. Pango accepts almost anything — `","` comes back as
`"Normal"` — so a family nobody has is kept and falls back when drawn, exactly as
an unknown `Icon` name is kept. Only blank is nothing.

**A size has three ways to go wrong on the way into CSS**, and all three did:

- it is **fractional**, so integer division drew `"Cantarell 11.5"` at 11 while
  the property still said 11.5;
- a description can be **absolute** (`"Cantarell 12px"`), and then the number is
  device units rather than points — written out as `12pt` it draws a third too
  large, which looks plausible enough to go unnoticed;
- the decimal separator is the **locale's**, and GTK calls `setlocale()` at
  startup, so `%g` writes `11,5` in half the world and CSS does not parse it.
  `g_ascii_formatd` always writes a dot.

None of it is visible from the property, which kept what it was given throughout:
the only way to see any of it is to measure what was drawn, which is what
`tests/widgets` now does.

The **default** is nobody's decision here: with `Font` unset the runtime writes no
`font-size` at all, and the desktop's applies. On this machine GTK reports
`gtk-font-name = "Sans 11"` at `gtk-xft-dpi = 98304` (that is 1024ths of a point
per inch, so 96 dpi), and 11pt at 96 dpi is `11 × 96/72` = **14.67px** — which is
where that number comes from.

Both halves of it move: the font setting is the desktop's
(`org.gnome.desktop.interface font-name`), and the pixel count also follows the
DPI and the text-scaling factor. So 14.67 is this machine's answer, not a
constant.

**Radius** rounds the corners, through the same per-widget class the colours and
the font use, and it is there for the same reason they are: no theme has a class
for "this rectangle is rounded by this much". One number rounds all four corners
(`8`), four round them one at a time in CSS's order — top-left, top-right,
bottom-right, bottom-left — so `"8 8 0 0"` is a window: rounded where it meets the
sky, square where it meets its own body. Two and three follow CSS as well, `px` is
accepted and dropped, and `""` or all zeroes is square again.

Numbers and nothing else: the value is parsed and written back out, so no more can
escape into the stylesheet through here than through a colour. Anything that is
not one to four sizes is **refused**, since a radius that silently did nothing
would look exactly like a theme that ignores it.

**Padding** takes the same one-to-four sizes and is the half of spacing `Margin`
does not cover: margin pushes the neighbours away, padding pushes the contents in.

**On a form the margin is the inset**, which is the one place it cannot mean room
outside: a window has no outside. It lands on the form's surface, so the window
keeps its whole size and what moves is what is inside it — a menu bar, which sits
above the surface rather than in it, still spans the window. It has to be that
way round: applied to the window, GTK insets the content and the background with
it, and the band left over is painted by nobody — a window transparent along its
right and bottom edges, which is what the two examples declaring `Margin: 8` on
the form looked like before this.

**The two do not take the same value, and the mismatch used to be silent.**
`Margin` is one number for all four sides — GTK's four margin properties set
together — while `Padding` is a string of one to four sizes. So `Margin =
"0 0 0 12"`, written by somebody who had just written a `Padding`, went through
`JS_ToInt32` and landed as `0`: the gap never appeared and nothing was said. Found
in a delivered application, and fixed where it belonged rather than here — see
[`bta_to_number`](#numbers-and-what-is-not-one).
GTK has no widget-level padding at all — it is a CSS property and nothing else —
which is also what makes it the answer to a rule one cannot select into. GTK's own
window buttons are `padding: 0` and 26 square inside a `windowcontrols` node, and
nothing an application builds is that node: the designer's title bar came out 43px
tall against the desktop's 37 until it could say the same thing itself.

**Zero is a value here**, unlike in `Radius`: `0` is a control asking for no
padding *against* a theme that gives it some, while `""` is the control saying
nothing and taking whatever the theme says. A radius of zero is just a square
corner, so it collapses to nothing and writes nothing.

**Shadow** is what the control casts on whatever is behind it, in CSS's own
shorthand minus what nobody needs: `"x y blur spread colour"`, one shadow and
never `inset` — a control lit from inside is a border. The offsets may be
negative, the blur and the spread may not, the tail is optional (`"0 2 6"` is a
shadow with no spread, in the translucent black a shadow is), and the colour goes
through `GdkRGBA` exactly as `Background` does, so what comes back is GTK's
spelling and not the string as typed. A shadow has to fall *somewhere*: a colour
on its own, or a single number, is **refused**.

The three of them — `Radius`, `Padding`, `Shadow` — are here for one reason, and
it is the same reason `Background` is: a theme says these things about nodes an
application cannot always be. GTK draws a window as
`window.csd { border-radius: 8px 8px 0 0; box-shadow: 0 3px 9px 1px rgba(0,0,0,0.5) }`
and its title buttons as `windowcontrols button { padding: 0; min-height: 26px }`,
and neither `window` nor `windowcontrols` is a node a form designer can build. The
designer's preview of a form's decoration is what asked for all three.

### Numbers, and what is not one

Every numeric property goes through `bta_to_number` / `bta_to_int`, which answer a
number or refuse, naming the value:

```js
w.Margin = "0 0 0 12";   /* TypeError: Margin: "0 0 0 12" is not a number */
w.Width  = "wide";       /* TypeError: Width: "wide" is not a number */
w.Margin = "12";         /* 12 -- a string that reads as a number is one */
w.Margin = "";           /* 0 -- nothing asked for */
```

**It exists because `JS_ToInt32` cannot fail.** ToNumber on a string that is not a
number answers NaN, ToInt32(NaN) is 0, and nothing along that road returns an
error — so for as long as every setter converted its own value, every numeric
property in this runtime silently took whatever it was handed. `Margin =
"0 0 0 12"` was a zero, in a delivered application, and *the gap simply never
appeared*: no throw, no warning, nothing to search for.

**A range check is not a type check**, which is the half that makes this worth one
function rather than one fix. `FontScale` and `Opacity` both validated their range
and both let a word through, because NaN fails every comparison it is in: `NaN <=
0` is false and `NaN > 10` is false, so `FontScale = "big"` passed the guard and
was stored. Twenty-eight setters had the first bug and two had both.

`""` and `null` are `0` rather than a refusal: that is what ToNumber says they
are, and a property grid clearing a field means nothing-was-asked-for. What is
refused is a value with no numeric reading at all. And the properties that
genuinely take a list of sizes — `Radius`, `Padding`, `Shadow`, `Border` — go
through `sizes_parse` instead and are unaffected, which is the distinction the
whole thing exists to draw.

**Tooltip** is plain text; `""` means none, not an empty balloon.

**Dark** is whether the control is drawn on a dark ground, and it is read-only:
the desktop's answer, never a form's declaration. What it is derived from is the
one thing that is actually true — `gtk_widget_get_color()`, the ink this widget's
text is really drawn in, whose Rec. 601 luma over 0.5 means the ground under it
is dark. `Painter.Dark` has always said this and it is now literally the same
function, so a drawing and the form around it cannot disagree.

**The two settings that look like the answer both lie**, and it is worth writing
down rather than discovering twice. Measured here: `gtk-theme-name` reads
`"Default"` on a desktop running Adwaita, and
`gtk-application-prefer-dark-theme` reads `false` under `GTK_THEME=Adwaita:dark`.
Either of them as the source of truth is a property that answers *light* on a
dark screen.

**A widget that is in no window answers white in every theme** — it has no
resolved style — which would be *dark* on the lightest desktop there is. So a
control that has not been added to anything falls back to the application's
first window, which is the answer it will have the moment it is added. A control
that is on a form needs none of that, and neither does the form: both answer
correctly **before** the window is presented, which is what makes `Dark` usable
in `Form_Open`.

A `Form` raises **`ThemeChange`** when the desktop moves it, out of `GtkSettings`'
`gtk-theme-name` and `gtk-application-prefer-dark-theme`. Three things about it:
the colours are already the new ones inside the handler (measured: the ink goes
from 0.20 to 0.93 luma across that call), so nothing has to wait an idle for GTK
to catch up; **one change may raise it twice**, since a desktop can move either
property, which is fine because the event carries nothing and a handler re-reads
state; and it is the **form's** event and no other control's — what a theme
change costs is the icons and colours an application chose for itself, and that
is a decision a form made. `Form_Resize` is the same shape for the same reason.

The settings object belongs to the display and outlives every window on it, so
the handlers go through `bta_widget_watch`: one left behind would fire on a freed
form the next time somebody switched themes.

**Cursor** is what the pointer looks like over the control, one name out of a
closed list of twenty-eight: `Auto` `Arrow` `Hand` `Grab` `Grabbing` `Text`
`VerticalText` `Wait` `Progress` `Help` `Crosshair` `Cell` `ContextMenu` `Move`
`Scroll` `Copy` `Link` `NoDrop` `NotAllowed` `ZoomIn` `ZoomOut` `None`
`ResizeHorizontal` `ResizeVertical` `ResizeTopLeft` `ResizeTopRight`
`ResizeColumn` `ResizeRow`. `Auto` is nothing said.

It is **not** a CSS property — `button { cursor: pointer }` is answered by GTK
with *No property named "cursor"*, so unlike `Opacity` and the colours this one
could not go through the stylesheet even if one wanted it to.

Three things about it are decisions rather than plumbing:

- **The names are ours, and the list is closed.** `gdk_cursor_new_from_name` is
  documented to answer NULL for a name no theme knows and does not: it hands
  back a live cursor carrying whatever it was given, resolved at the surface or
  quietly replaced by the arrow. So a typo would be a property that reads back
  correctly and draws nothing in particular — the failure `Style` refuses a
  non-identifier to avoid. The setter checks the list and throws. This is the
  one vocabulary this runtime translates rather than passes through, because it
  is the only one that is closed *and* abbreviated: an icon name, a font family
  and a `Shortcut` are open and readable, `nesw-resize` is neither.
- **Two rows earn the translation.** `Move` is CSS's `all-resize` and not its
  `move`, because Adwaita links `move` to `default` — the value meaning "this
  can be dragged" would have drawn a plain arrow. And `ResizeColumn` is
  `col-resize` under CSS's own meaning-based name: the toolkits that name it by
  orientation disagree with each other, Delphi's `crHSplit` and WinForms'
  `HSplit` being opposite things.
- **The one-headed arrows are not offered.** `n-resize`, `se-resize` and the
  other six are X11's vocabulary for a window manager dragging a window by an
  edge; not one of VB6, Delphi, WinForms, WPF or Qt has them, and what an
  application resizes — a splitter, a corner, a designer's handle — is
  two-headed. Leaving them out is what lets `ResizeTopLeft` name a corner
  instead of a pair of axes spelled out.

**It is set on every part the control is made of**, which is `Focusable`'s rule
and for the same reason turned around: a cursor reaches a descendant only while
the descendant has none of its own, and the commonest controls have one — the
`GtkText` inside a `TextBox` and a `SpinBox` and the `GtkTextView` inside an
`Editor` all carry `text`, a `LinkButton` carries `pointer`. Set on the outside
alone, `TextBox.Cursor = "Wait"` would read back correctly and never be seen
over the text.

The same fact is the property's limit, and it is GTK's rather than ours:
**`Form.Cursor = "Wait"` is not a busy pointer for the whole window.** It covers
the window except over the controls that declare their own, and there is no way
down from an ancestor. A window that is working says so with a `Spinner` or a
`ProgressBar`; the pointer can only speak for the control it is over.

`Auto` puts back what the control had before the property was ever touched,
which is not the same as having no cursor: a `LinkButton` reads `Hand` before
anybody assigns anything, and `Auto` after a `Wait` gives the hand back rather
than leaving a link with no pointer of its own for the rest of the run.

**Focus.** `Focusable` has to be turned on for a container that wants keys: it is
how the designer's glass layer receives Delete, the arrows and Escape.

**Context menu.** `Menu` takes the same array of items a form's `menus` does, and
its entries land on the form by name and dispatch as `Name_Click` — a context
menu is not a second kind of menu, so a handler cannot tell which one it was
chosen from.

Three consequences worth knowing before building a menu from a spec you did not
write — which is what the IDE's designer does when it previews the menu bar of
the form being designed. The names land on **the form the widget belongs to**, so
a previewed `MnuOpen` replaces that form's own `MnuOpen`; the dispatch is an
ordinary property lookup, so clicking it runs that form's handler (and, the other
way round, a handler assigned from code — `this["X_Click"] = …` — is found just
the same, which is how a menu built at run time gets one at all); and a
`shortcut` on an item ends in `gtk_application_set_accels_for_action`, which is
**the whole application** and not that menu. A menu that is a picture of another
form's has to be renamed and stripped of its shortcuts first. It is an ordinary property, so a `.form` can declare one, and the
serialiser saves it because a `GMenu` cannot be walked back into a spec. Its
actions live in a `popup` group inserted on the widget, not the `form` group on
the window, so nothing it declares can shadow a menu bar action and two widgets
may both offer a `Delete`.

`PopupMenu(x, y)` opens it from code. Both it and the right click show the menu
of the **nearest widget that has one**, walking outwards: a `Button` handles its
own press so the event never reaches the panel it sits in, and without the walk a
container's menu would work everywhere except over its own contents.

**Events.** Mouse, motion, wheel and keys are attached to every widget in the
bubble phase, so a control's own behaviour still happens and these are additive.
Coordinates are relative to the widget. `DblClick` arrives *after* the second
`MouseDown`, not instead of it.

`MouseEnter(x, y)` and `MouseLeave()` come off the same motion controller as
`MouseMove`, and exist because motion cannot answer the question they answer:
there is no move event for the pointer having left. What wants them is a control
that highlights under the pointer -- the enter/leave pair is the whole of a hover.

`MouseWheel(dx, dy)` reports both axes, in the notches GTK gives:
`dy` is -1 for a notch up and 1 for down. **Returning `true` consumes it**, and
that return matters more here than on the other events: a wheel event nobody
claims keeps travelling outwards to whatever scroller contains the widget, so a
control that reacts to the wheel and does not consume it both zooms *and* scrolls
its parent. Nothing is consumed by default, which is what keeps a widget inside a
scroller from breaking scrolling by existing.

`KeyRelease` takes the same arguments as `KeyPress`, and the two are **not
symmetric** -- deliberately, and the asymmetry is worth knowing before pairing
them. Bubble phase means the focused widget refuses first, and a `GtkText`
*claims* the press of a printable key, because that press is the typing itself;
it makes no use of the release and lets it through. Measured on a `TextBox`:

    xdotool key b       -> KeyRelease b        (no KeyPress: the entry took it)
    xdotool key F5      -> KeyPress F5, KeyRelease F5
    xdotool key Escape  -> KeyPress Escape, KeyRelease Escape

So `KeyRelease` on a text box sees letters its `KeyPress` never will. Watching
what is typed is `Change`'s job; `KeyRelease` is for the widget that does not edit
text -- releasing a modifier, a key-held-down that ends.

## Two ways a handler is found, and which is for which

A `.form` names a control and the handler is `<Name>_<Event>` on the form. That
is the whole of how a designed window is wired, it needs no registration, and a
handler can be assigned or deleted at any moment because the lookup happens when
the event is raised.

It has nothing to say about a control **built in code**, and the count is not
known until the data is read — a button per widget type, a row per column of a
board, an editor per property. There is no name a designer chose. Inventing one
to build the property out of works, and costs two things that are not obvious:
the name is a *global on the form*, so building the same palette twice leaves
the old handlers behind unless something deletes them by hand; and a handler
that closes over a loop variable has to encode that variable into the name.

`On(event, fn)` is that case:

```js
const b = new Button();
b.Icon = name;
b.On("Click", () => this.choose(name));
panel.Add(b);
```

Nothing is left on the form, so nothing has to be cleaned up; installing again
replaces, so rebuilding needs no bookkeeping; and the handler goes when the
control goes. `On(event, null)` removes one. There is no `Off` — it would be the
same sentence said twice, and it would need the function back to identify it,
which is the one thing a closure does not hand you.

**A control never has both, and the pair is refused at whichever act completes
it.** `On` throws when the form already answers that event by name, assigning a
`Name` throws when the control already carries a handler the new name would
answer, and **adding the control to a container** throws when it arrives at a
form carrying both:

    On: BtnOk already answers 'Click' through BtnOk_Click on its form,
        and a control has one handler for one event

Two handlers for one event is an ambiguity this runtime cannot resolve by
merging them the way GTK or Qt would: eight of its events are asked a question
rather than told something — `Paginate` answers a number, `KeyPress` answers
whether the key was eaten — and only one of two answers could ever be used, so
preferring one would silence the other without saying so. `On(event, null)` is
let through either way: taking a handler away cannot make a pair.

The third of those is the one worth knowing about, because the other two cannot
cover it: both ask about the control's **form**, and a control built in code has
not got one until it is added. So naming it and installing a handler before
`Add` satisfies both, and the adoption is where the form finally arrives — which
is why that is asked too, and asked before the control reaches the container.

What is left is **not total**, and inherently so: a form is an ordinary object,
so a `<Name>_<Event>` assigned onto it after the fact is something nothing can
watch. There is no act to hook there.

**A component added from code is the case the convention cannot reach at all.**
It keeps *itself* as its event target, since only the `.form` loader rebinds one
to its host, so `<Name>_<Event>` on the host never fires for a card built with
`new TaskCard()`. `Emit` reads the control's own handler first, so the host
hears it:

```js
const card = new TaskCard();
card.On("Changed", (v) => this.recalc(v));
this.Board.Add(card);
```

Two things about the handler itself. It is called with `this` **undefined**,
like every other callback this runtime is handed — a closure captures what it
needs, and under the forced strict mode every project source runs in, a
non-arrow function that reads `this` throws where it is written instead of
finding the global object. And the event name is checked against
`EventNames()`: a name that is not there throws, rather than sitting in a
handler that never fires. A component of the project declares its own with
`static Events = [...]`, which is the same list the designer offers on a double
click.

## Shortcut: the key that presses a control

```json
{ "type": "Button", "name": "Btn7",
  "properties": { "Text": "7", "Shortcut": ["7", "KP_7"] } }
```

`shortcut` is the word a menu item has had since menus existed, and this is the
same word one widget further out — the question is the same one: **which key
means this command**. Without it, a window whose buttons are also keys carries a
table of key names and a `KeyPress` that dispatches it, which is the command
written twice in two vocabularies. `examples/calculator` was thirty lines of
exactly that and now has none.

A **list** because one accelerator is routinely not enough: the keypad `7` and
the row `7` are two keys meaning one thing, and desktops grab bare function keys
out from under an application. One accelerator may be written as text and comes
back as text; several come back as a list, so a `.form` round-trips whichever way
it was written. `""` or `null` takes them away.

The syntax is GTK's, the same the menu block uses: `"F5"`, `"KP_Enter"`,
`"period"`, `"<Control>s"`, `"<Control><Shift>n"`. Anything `gtk_accelerator_parse`
refuses is refused here, with the offending value — and **refused before the old
keys are taken away**, so a typo leaves the control with the keys it had.

**It activates the control**, which is what each kind already means by being
pressed: a `Button` clicks, a `CheckButton` and a `ToggleButton` toggle, a
`TextBox` reports `Activate`. A control with nothing to activate — a `Label` —
accepts the property and does nothing with it, exactly as `Focusable` does. It is
a `Widget` property for that reason: the machinery is the same for all of them
and GTK's own `activate` already means the right thing in each.

The action is GTK's `activate` and **not a callback of ours**, deliberately: a
callback would be a pointer to the wrapper held by a controller that outlives it,
which is the second crash class in [architecture.md](architecture.md#lifetimes).
Activating goes through the widget's existing handler, which the finaliser's
sweep already disconnects.

**Enter is not a shortcut.** `Return` and `KP_Enter` are claimed by the window
for its default widget before any shortcut controller sees them, so a `Shortcut`
naming either never fires. That is what `Button.Default` is for, and it is the
right answer rather than a workaround — the calculator's `=` declares
`"Default": true` and answers both. `Escape` has no such claim and works as an
ordinary shortcut.

### `Action`: one command in several places

A named command — label, icon, key, enabled state, handler — that a button, a
menu item and a key all point at. `Qt` has `QAction` for exactly this, WPF has
`ICommand`, and GTK has `GAction` plus `GtkActionable`, which the menu block was
already using underneath: **an `Action` is a menu item's action without the menu
item**, so the plumbing is one `GSimpleAction` in the form's own group and the
only thing it lacks is a place in a `GMenu`.

`Shortcut` on a control is not this: it says which key presses *that control*,
and a command in two places is still written twice.

```json
"actions": [
  { "name": "ActDelCtl", "text": "Delete control", "icon": "edit-delete",
    "shortcut": "Delete", "enabled": false }
]
```

Declared in a top-level block beside `menus`, and for the same reason menus have
one: a command is not a widget, and the children of a `.form` are widgets — the
argument [plans/data-plan.md](plans/data-plan.md#what-was-rejected-and-why) makes against a
non-visual child. Read back as `Form.Actions`, and serialised **before** `menus`
because the loader reads it first: an item and a control may both name one.

**What made it worth building was the shared `Enabled`, not the shared body** —
and the measurement that decided it turned out to understate the case.
`ide/forms/MainForm.js` had three commands reachable four ways each, and their
availability was computed in **two files with two different expressions**:
`Designer.refresh` said `selection.length > 0` while `MainForm.refresh` said
`design && designer.selected !== null`. Whether those agreed was not answerable
by reading either one. It is now three assignments in one place, and the second
place cannot come back, because **a control bound to a command refuses an
`Enabled` of its own**.

Three rules, each a mistake the runtime refuses rather than a convention:

| | |
|---|---|
| a bound control has no `Enabled` | assigning one throws, naming the command. Two places deciding one command's availability is the bug this exists to prevent |
| `Text` and `Icon` fill what the control left empty | so a toolbar stays icons and an Edit menu stays words while both name one command. **And a control that declared an icon is an icon control**: it takes no label, or a 34-pixel button grows until it pushes the tab strip under half the window — which is how the IDE's own layout test caught the first version |
| a menu item that points at one needs no name | it is a place a command appears and not a command. `MnuCvDel` and `MnuTrDel` existed because "two widgets cannot both own `MnuDel`"; an item that points at an action owns nothing |

The lent label and icon are **not written back** when the form is saved — the
loader's `__declared` note is what makes that work, recording that the control
declared nothing — so the command stays the one place the label lives. And
`Enabled` is not written at all for a bound control: it used to be, and a form
saved while a command was disabled produced a file that **would not load
again**, since the loader is refused the same assignment.

**`Action` is applied last**, whatever order the file lists its properties in.
It is the mirror of `Arrangement`, which is applied first: both are properties
whose meaning depends on what has been set already, and the loader is where that
is settled rather than in every file.

## Styling: the vocabulary

`Style` takes CSS class names, and **which ones exist is the theme's answer, not
ours** — the desktop's, the project's `app.css`, and whatever theme the person
running the program installed. A vocabulary that open cannot be a list in the IDE:
the grid's drop-down is a convenience with a starting set in it, and being a
closed list it cannot offer a combination either, though the property has always
taken one (`"card title-3"`).

So the reference is here, and `tests/styles.sh` generates it off the theme this
machine really has.

### What node a control is

**A class goes on one node, and that node decides which rules can match it.** This
is the table to read before writing a selector — and before wondering why a class
did nothing:

| Control | The node `Style` writes on | What is inside it |
|---|---|---|
| `Label` | `label` | |
| `Button`, `ToggleButton`, `LinkButton` | `button` | `> label` |
| `CheckButton` | `checkbutton` | |
| `TextBox` | `entry` | |
| `SpinBox` | `spinbutton` | `> text` |
| `ComboBox` | `dropdown` | `> button > box > stack` |
| `Switch` / `Slider` / `ProgressBar` / `Image` / `Separator` | `switch` / `scale` / `progressbar` / `image` / `separator` | |
| `ColorButton` | `colorbutton` | `> button > colorswatch` |
| `FontButton` | `fontbutton` | `> button > box > label` |
| `DatePicker` | `menubutton` | `> button` |
| `Calendar` | `calendar` | `> header > button`, `> grid > label.day-number` |
| `Panel`, `Component` | `fixed` | the children, directly |
| `Grid` / `Split` / `Overlay` / `Notebook` | `grid` / `paned` / `overlay` / `notebook` | the children |
| `Frame` | `frame` | `> fixed` |
| `AspectFrame` | `aspectframe` | its one child. **Not `frame`**: a `GtkAspectFrame` is not a `GtkFrame`, it descends straight from `GtkWidget` and has no caption |
| `Form` | `window` | `> fixed`, or `> box > fixed` once it has a menu bar |
| `ListBox`, `RowList` | `scrolledwindow` | `> viewport > list > row` |
| `TreeView` | `scrolledwindow` | `> listview` |
| `TableView` | `scrolledwindow` | `> columnview > row` |
| `TextEditor`, `SourceEditor` | `scrolledwindow` | `> textview` |
| `Terminal` | `scrolledwindow` | `> vte-terminal`, or `> textview` on a build with no VTE (see [*a build without VTE*](#a-build-without-vte)) |
| `Video` | `picture` | the paintable GStreamer draws into |
| `DrawingArea` | `widget` | nothing: what is inside it is ink, not widgets |
| `Flow` | `scrolledwindow` | `> viewport > flowbox > flowboxchild` |
| `Scroller` | `scrolledwindow` | `> viewport > fixed` |

`Widget.CssNode()` answers the middle column, read off GTK itself
(`gtk_widget_class_get_css_name`) rather than declared, so it cannot drift from
what the widget is. **And `tests/widgets` asserts the whole table**, including
that every placeable type appears in it — because moving a node is a breaking
change for anyone's `app.css` and there is nothing else that would notice. Three
of them moved in one afternoon with the suite green throughout.

The `viewport` in there is not a typo: a `GtkListBox` is not scrollable, so GTK
puts one in — see [RowList](#rowlist).

### What the theme gives you

From `tests/styles.sh` against the Adwaita compiled into GTK 4.22.4. Run it for
your own; the shape of the answer matters more than these rows.

| Class | Written for | Notes |
|---|---|---|
| `large-title`, `title-1`…`title-4`, `heading`, `body`, `caption-heading`, `caption`, `title`, `subtitle`, `dim-label`, `monospace` | anywhere | type; they set font and colour, and those inherit, so on a container they reach what is inside |
| `suggested-action`, `destructive-action` | `button` | |
| `flat` | `button`, `entry`, `spinbutton` | |
| `circular`, `image-button`, `text-button` | `button` | |
| `error`, `warning` | `entry`, `label`, `spinbutton` | the only two state colours plain GTK has — `success`, `accent`, `card` and `pill` are libadwaita's, and this theme does not define them |
| `frame`, `view`, `background`, `osd` | anywhere | `view` also has rules of its own for `columnview`, `listview`, `treeview` |
| `toolbar`, `linked` | anywhere, and they style `> button` — and, for `linked`, `> colorbutton > button`, `> fontbutton > button`, `> dropdown > button` and the rest of the composites | so they want a container whose children are buttons — a `Panel` arranged as a row is the case. `linked` also wants `:not(.vertical)`, so the panel has to be a row and not a column |
| `sidebar`, `content-view` | anywhere | |
| `boxed-list`, `rich-list`, `navigation-sidebar` | anywhere, but they style `> row` | **and that is why they do nothing here**: the class would have to sit on the `list` node, and `Style` on a `RowList` puts it on the `scrolledwindow` around it |
| `data-table` | `columnview` | |

Two rules read off that table cover most surprises:

- **A class written for a node other than yours is accepted, saved, and does
  nothing.** `Style = "flat"` on a `ColorButton` is the case: the class lands on
  `colorbutton`, and the theme writes `button.flat`. Measured, twice, with the
  same result both times.
- **A class that styles `> children` needs a widget whose children really are
  those.** `linked` on a `Panel` works, because a panel's children are the
  buttons. `boxed-list` on a `RowList` cannot, because the rows are three nodes
  further in.

The same `ColorButton` shows the other half of the first rule: a class *of its
own* cannot reach the button inside it, but a class on the panel **around** it
can, because the theme wrote that path itself — `.linked:not(.vertical) >
colorbutton > button`. Which is the IDE's colour row: the swatch and the clear
beside it are the two children of a `linked` panel, and they draw as one control.
What a class reaches is the theme's answer and not the widget's, so the way to
find out is to read the rule (`tests/styles.sh`) rather than to reason from where
the class lands.

### Writing your own

For the second case, the answer is a class of your own and a selector that walks
down from it — the recipe is under **Colour** above, and it is not a workaround:
it is what a cascade is for.

## Control

Nothing of its own: it exists so `Control` and `Container` can be told apart in
the prototype chain, and so a future property that belongs to leaves only has a
home.

### Label

A `GtkLabel` with `xalign` left, like VB. `Alignment` is `Left`/`Center`/`Right`
and is one of the enum properties, so the designer's grid offers a drop-down for it
without knowing it exists.

`Wrap` turns one long line into a paragraph. It matters more than it sounds:
`Width` is a *minimum*, and an unwrapped label asks for the natural width of its
whole text, so a sentence of help text stretches whatever holds it -- it grew the
menu editor to 1151 px from a declared 640. Wrapping caps the natural width
(`max-width-chars`), GTK clamps it back up to the requested `Width`, and the text
flows inside exactly the box the `.form` asked for. A wrapped label also reads from
the top of its box rather than the middle.

`Lines` caps how many lines a wrapped label may take, `0` for as many as it
needs. It only means anything with `Wrap` on -- a label that does not wrap has one
line by construction -- and it is at its best with `Ellipsize` too: three lines
and a `…` is what a description reads like when the text is somebody else's and
could be a paragraph.

`Selectable` lets the words be picked up. The case is always the same one:
something the program is *telling* you -- a path, an error, a version -- that you
then need somewhere else, and a label one cannot copy from turns that into
retyping.

`Markup` says `Text` is Pango markup: `<b>`, `<i>`, `<span foreground="…">`. It is
a way of *reading* `Text` and not a second property holding a marked-up copy --
two places for one sentence is how they end up disagreeing. `Text` reads back
**what was written**, tags and all, so a form that is saved does not lose them;
turning `Markup` on after the text is already there says it again the other way,
which is the order a `.form` writes properties in half the time; and the
catalogue still collects `Text`, markup included, which is what every gettext
project has always done with it.

`Ellipsize` is the other answer to that same question: one line still, and what
does not fit ends in a `…`. It caps the natural width the same way, so it stops a
long string from stretching its container just as `Wrap` does — the difference is
only what becomes of the text that does not fit. What wants it is a caption on a
strip that cannot grow: a window title over a form, a path in a status bar. **A
label can only give one of the two answers**, so setting either turns the other
off — text that wraps has no end to put the ellipsis at.

### Button

`Text` and `Icon`, **and both at once**: a `GtkButton` shows either a label or one
custom child and never both, so when a button has an icon and a caption the
runtime builds the box — `build_button` does it, not the caller. Which is also the
whole of what a `ToolButton` would have been, and the reason there is none. Both values are kept on
the widget and the child is rebuilt whenever either changes; otherwise setting
`Text` after `Icon` would silently throw the icon away.

An icon name the theme does not have is **dropped**, leaving the button readable by
its text. That is the right default, and also why `Application.HasIcon()` exists:
on an icon-only button, a dropped icon is an empty square, and only whoever picks
the name can pick a fallback.

`Click()` presses it from code, exactly as a user would.

**A button that drops a menu is this button and one line.** `Menu` is a property
of every widget and `PopupMenu(x, y)` opens it, so:

```js
TabActions_Click() { this.TabActions.PopupMenu(0, 0); }
```

That is the IDE's own tab-strip button, menu and all, declared in its `.form` like
any other context menu. There is no `MenuButton` class: what one would add is the
drop-down arrow — an `Icon` here — and announcing itself as a menu button to a
screen reader, against a second way of attaching a menu to a widget.

**`Default` and `Cancel` say what Enter and Escape do on the form this button is
on** — the VB, Delphi and Gambas spelling, and the only one that works here.
WinForms moved this to the form (`AcceptButton` / `CancelButton` naming a
control), which a `.form` cannot express: `bta_form_build` applies a form's own
properties *before* its children exist, so the name would point at nothing and
would have to be stored and resolved later — a hole where a typo does nothing in
silence, and the first control reference the IDE's rename would have to chase
through a `.form`.

The form's `DefaultButton` / `CancelButton` are the resolved answer, read-only, so
the serialiser and the property grid skip them on their own. Two places to declare
one fact is how the two come to disagree.

**Neither property tells GTK anything when it is set**, and that is the load-bearing
part. A window has one default widget, so the obvious setter calls
`gtk_window_set_default_widget` — and the designer builds the controls of the form
it is *drawing* inside the IDE's own window, where every one of them is bound to
`MainForm`. A setter cannot tell that from an application: both are a button whose
form is a form whose widget is the root window. It would hand the IDE's Enter key
to a button on a canvas, and no test of a drawn form would notice. `form_show`
resolves it instead, because a drawing is never shown as a form. What that costs is
stated rather than hidden: a `Default` assigned to an already-open form does not
move it until the next `Show`.

**And `form_resolve_buttons` runs after the `Open` handler, not before**, so a form
that builds its own buttons there is as ordinary as one that declared them in its
`.form`. That is what makes both properties `null` *inside* `Form_Open` — measured,
and the one thing to know before reading either. A test asks them a frame later:

```js
eq("the default resolved", this.DefaultButton, null);      /* in Form_Open */
Timer.After(0, () => eq("...a frame later", this.DefaultButton.Name, "BtnOk"));
```

Two buttons declaring the same one is a form in the wrong order rather than an
error — the first in tree order wins and the loser's flag is *cleared*, so the grid
and the `.form` show the button that really answers the key.

Escape presses the `Cancel` button, and does nothing without one. Qt and GTK3 close
a dialog on Escape whether it asked to or not, so discarding work on a stray
keystroke is a decision that has to be made out loud here — and what that button
does goes through `Close()`, which means a `Form_Close` that vetoes governs Escape
along with everything else. It runs *after* `Form_KeyPress` and only if nothing consumed
the key — code written for this form beats a declaration made about it — and a
disabled Cancel button refuses Escape exactly as it refuses a click. Escape finds
it by walking the form when it is pressed, rather than remembering it: a pointer to
a button is a pointer that outlives it, and GTK4's own unowned pointer to the
default widget is the cautionary case (see AGENTS.md).

It says nothing about how the button is **drawn**. `Default` is the keyboard,
`Style` is the looks, and a `Close` that answers Enter should not come out accented
— `Style = "suggested-action"` is the theme's class for the ones that should. VB and
AppKit draw their default button and this does not, which is the one thing given up
by keeping the two vocabularies apart.

### Image

A `GtkImage`: a picture and nothing else. Until it existed the only control that
could show one was a `Button`, so the one place an application most wants a
picture — the empty state, what a window shows before it has anything to show —
was a button pretending not to be one. The IDE's own welcome page is the case
that asked for it.

`Icon` is a name out of the theme and `File` a path, one property each, and
**setting either clears the other**. That is what a `GtkImage` is: it holds one
thing at a time, and remembering the other would be state GTK does not have — a
`.form` that wrote both would come back showing whichever was applied last.
Reading gives back what was assigned, so either round-trips.

**`LoadBytes(bytes)` is the third source and the only one that is a verb**, for
the reason the other two are properties: a property here is a promise that the
designer can edit it and the `.form` can carry it, and a megabyte of JPEG is
neither. It takes what `Http` answers with and what `File.LoadBytes` reads, and
it clears both names — after it, `Icon` and `File` read `""` rather than naming
something that is not what is drawn. See [`Picture`](#picture) for why this
exists at all.

**And clearing `Icon` now clears the name GTK was told to keep re-resolving**,
which is a fix and worth the sentence: an icon is kept by name on the widget and
re-asked for when the theme or the scale changes (see below), and that name used
to survive a `File` or a `LoadBytes` — so the next change of theme put the old
icon back over the picture that had replaced it. Nothing showed it until
something else was shown.

An icon name the desktop cannot draw is **dropped**, exactly as a `Button` drops
one — [`Application.HasIcon`](runtime-api.md) is the question about that. The name
still reads back: what a `.form` wrote round-trips whether or not this machine can
show it.

`Size` is the side in pixels, and `-1` — what an image that never asked has — is
GTK's own "whatever the icon size says". That default is right for a toolbar and
much too small for a page about nothing, which is the whole reason the property
is here.

### Separator

A `GtkSeparator`, and one property: `Orientation`, through the accessor `Slider`
and `ProgressBar` share — `GtkOrientable` is what the three have in common, and
the word is not `Arrangement`, which is what a *container* does with children
these do not have.

**Its thickness is the line.** A separator paints its whole allocation, so one
declared 12 high is a line 12 thick and not a line with room around it; the
natural height of a horizontal rule is a single pixel, which the suite measures
rather than assumes. Room above and below goes on `Margin` — the same answer this
runtime gives a form whose contents sit against the frame.

That does make it a one-pixel target once placed. Adding one from the palette
selects it, so the property grid is already pointed at it; afterwards it is
selected the way anything hard to hit is, from the control tree or with a rubber
band over it.

It is the last of the plain controls that was missing, and it was missing because
it is the one nobody notices until a dialog has three groups of fields and nothing
between them. That it is used less than it used to be is an argument about taste,
not about whether a widget set should have one.

### TextBox

A `GtkEntry`. `Password` swaps the visibility; `ReadOnly` blocks editing without
greying it out.

`Icon` puts a clickable icon **inside** the field, on the right, and clicking it
fires `IconClick`. That combination replaces `GtkFileChooserButton`, which GTK4
removed: a field showing the path plus an icon that opens the dialog says the same
thing and also lets the path be typed. `ide/forms/NewProjectForm.js` is built on it.

`Placeholder` is the hint drawn in an empty field — the standard way to say what a
field is for with no label beside it, and prose like `Text`, so it goes through the
catalogue. It is also what makes an *empty* editor mean something: the IDE's
property grid shows the real value there while the field itself holds the design
value, so "nothing set" and "set to nothing" stop looking alike.

`MaxLength` is how many characters it will take, `0` for as many as one types.
The field stops accepting them rather than complaining afterwards, which is the
point: a code that is six long says so while it is being filled in and never has
to say it again in a dialog.

`Purpose` declares what kind of thing goes in it — `Text`, `Digits`, `Number`,
`Phone`, `Url`, `Email`, `Name`. It is not validation: nothing refuses an address
that is not one. It is what an input method reads to open the number pad instead
of the alphabet and to stop autocapitalising a URL — nothing on a desktop, and
the difference between a form one can fill in and one one cannot on a tablet. A
curated seven and not GTK's eleven: `Password` and `Pin` are left out because this
class already has a `Password` flag, and two ways to say one thing is how they
end up disagreeing.

`Alignment` is `Left`/`Center`/`Right`, the same word a `Label` uses for the same
question — a right-aligned column of numbers is made of both.

**The selection** is `Select(start, length)`, `SelectAll()` and the read-only
`SelectedText`. `Select(5)` with no length is a cursor rather than a selection,
which is how one puts the caret somewhere; a length past the end is the end,
because the caller is usually a search that just found something and clamping is
what it would have written itself. `SelectAll()` is what every field that opens
with a value in it wants on focus, so that typing replaces it.

`Change` fires on every keystroke — and on assignment from JS, which is a real
signal and not a simulation. `Activate` is Enter.

**`Completion` offers the words already in the buffer** as you type, through
`GtkSourceCompletionWords`. It knows nothing about the language — what knows what
the text *means* is the `Complete` event below, which is a second provider fed
from the application. Off by default: an editor
is also used to show a log or a diff, and a popover over one of those is
uninvited.

Two things about it are worth knowing, and both cost a day each to find.
**GtkSourceView has to be initialised** (`gtk_source_init`, in `on_activate`
where there is a display) or the popover has no CSS, cannot size itself, and
appears exactly once before failing forever — everything else about the library
works without it, which is what makes the symptom so misleading. And **the index
is built in idle batches**, 50 lines at a time by default, so the first proposal
in a long file arrives after dozens of trips through the main loop; the runtime
asks for 1000, which puts an ordinary source in one or two.

**`ActivatesDefault` hands Enter to the form's default button instead**, and it is
one or the other: with it on the entry does not emit `activate` at all. That is
GTK's own bargain and it is the right shape, because Enter in a field means one of
two things and only the form knows which. Both are in this IDE, and were written by
hand before this existed: `TxtDesc_Activate() { this.accept(); }` is this property,
and `TxtPrName_Activate() { this.TxtPrDesc.SetFocus(); }` is Enter walking to the
next field — which is a tab order and not a default button. Off by default, so
nothing that already handles `Activate` changes meaning.

### CheckButton

A `GtkCheckButton`. `Active` is the boolean; `Click` fires on toggle, whichever
way it went.

**`Active` and not `Value`**, which is what GTK calls it and what reads right in
context: `if (this.ChkCase.Active)` says something and `.Value` of a tick says
nothing. The line runs through what the property *is* rather than through which
control has it -- `Active` where a thing is on or off (`CheckButton`,
`ToggleButton`, `Switch`), `Value` where it holds a number or a string
(`SpinBox`, `Slider`, `ProgressBar`, `DatePicker`, `ColorButton`, `FontButton`).
A menu item keeps `Value` for a reason of its own: there it is a boolean for a
tick and the chosen *index* for a set, one name over two types. And `Group` is what makes it one of a set instead of a box one ticks.

**There is no RadioButton, because there is no radio widget in GTK4.**
`GtkRadioButton` was removed: what a radio *is* now is a check button that belongs
to a group, and belonging is what draws the indicator round, makes the set
exclusive and makes a second click leave it on instead of turning it off. Two
classes over one widget, differing only in whether a property is set, is the
`ListBox`/`ListView` confusion by another name.

The two-class version had a hole that says the same thing from the other side: a
`RadioButton` that was the only one in its container had no group, so GTK drew it
square and let a second click turn it off. It *was* a check box -- in looks and in
behaviour -- and the first one dropped on a form is exactly when one looks.

**This is not what other RAD tools do**, and it is worth saying rather than
hiding. VB, Delphi and Gambas all ship two controls, so somebody arriving from
those will look for a RadioButton and not find one. What they get instead is one
control whose `.form` says which it is.

**What it cost is that a set has to be named.** The old class made a set out of a
*container* -- the radios of one Panel were one group, nothing declared -- and
that rule cannot survive one class: a check box and a radio being the same widget,
"everything in this Panel is one exclusive set" would turn every row of tick boxes
into a set of choices. So an empty `Group` is a tick, and a name makes it one of
that set:

```json
{ "type": "CheckButton", "name": "OptA", "properties": { "Text": "A", "Group": "size" } },
{ "type": "CheckButton", "name": "OptB", "properties": { "Text": "B", "Group": "size" } }
```

The container still **scopes** the name, which is the half worth keeping: the same
`Group` in two Panels is two sets, so a form holds as many as it has containers
without inventing unique names for each.

GTK's group is a linked chain and not a name, so it is rebuilt from the
container's children whenever the set can have changed: one added, one taken out,
a `Group` reassigned. Two things that rebuild has to get right, both found by
being got wrong:

- **The one leaving is unlinked first.** One still pointing into the chain it left
  would turn off a control in a container it is no longer in -- a bug you would
  find months later.
- **And everything else is unlinked before anything is relinked.**
  `gtk_check_button_set_group` moves a button out of its list and into the
  target's, so re-grouping one that is *already* in that list closes the chain
  into a ring. Nothing complains at the time; the next click walks the group to
  turn the others off and walks forever.

A lone member of a named set is grouped with a companion check button that is
never parented and never drawn, because a group of one is otherwise no group at
all and GTK offers no other lever -- no property, no CSS name.

Setting `Value = true` on one raises `Click` on it *and* on the one that went off,
because both toggled. That is GTK's doing and what a group means.

### Switch

A `GtkSwitch`: the same question a `CheckButton` asks, drawn the way the desktop draws
a setting that takes effect the moment it is flipped. So it is the check box's
`Active` and the check button's `Click`, and that is the whole class.

It has **no caption**, because a `GtkSwitch` has none: the words beside one are a
`Label`, and a row is the label with `HExpand` on plus the switch after it — which
is what puts the switch against the right edge, as the desktop's own settings do.
The IDE's *Design values* row in the property panel is exactly that, and is the
reason this control exists.

A switch in a box gets the whole cell like anything else, and a stretched trough
reads as a control nobody has seen before: it is the one widget where the row it
sits in is part of the design. The label expanding beside it is the usual answer;
`HAlign` is the other.

Reported through `notify::active` rather than `state-set` — the hook for a setting
that takes a while to apply and may refuse, where what the handler returns decides
whether the switch moves at all. There is nothing here to refuse, and `active` is
the property both the pointer and an assignment from JS go through, which is what
makes `Value = true` come back as a real `Click`.

### ToggleButton

A `GtkToggleButton`, which is a `GtkButton`, so `Text` and `Icon` are the button's
own accessors. What it adds is a `Value` that can be read and written, and a `Click`
that reports the new state rather than the press. `Click()` from code toggles it,
and does nothing while it is disabled -- as `Button.Click()` does.

### Picture

A `GtkPicture`: `File`, `Fit`, `Zoom`, `LoadBytes()`, and `SourceWidth` /
`SourceHeight` read-only.

**An image already in memory is `LoadBytes(bytes)`**, and it is the half of
showing a picture this runtime did not have. `Http` answers a body as `Bytes`
and `File.LoadBytes` reads one, and the only thing that could *show* an image
wanted a path — so the whole of "download it and show it" was a temporary file,
written and deleted around a control that would rather have been handed the
bytes. The gap was never GTK's: `gdk_texture_new_from_bytes` sniffs the format
exactly as the filename version does.

It is a **verb** and `File` stays a property, which is the same line `Image`
draws: a property is designable and serialisable, and bytes are neither. The
rule that matters is unchanged — one source at a time, the last one wins — so
bytes clear `File` and `SourceWidth`/`SourceHeight` measure what is really
shown. The complaint names what it got rather than what it wanted (*cannot show
17 bytes: unknown image format*), because bytes that are not an image are the
ordinary failure here: an error page answered with 200, most often.

**`Image` and `Picture` are two controls because they answer two questions.**
`Image` is a `GtkImage` and draws an *icon* -- a name from the desktop's theme,
or a small file standing in for one -- at its natural size, and refusing to
scale is exactly right there: an icon blown up to 300px is a blurry mistake when
the theme has a proper 48px file for the asking. `Picture` draws a
*photograph*, and a photograph that is not scaled to the space it was given is
not being shown.

`Fit` is the whole of the difference between showing an image and showing it
well, and the four words are GTK's own: `Contain` (all of it, letterboxed --
the default, and what a viewer wants), `Cover` (fills the frame, cropping what
does not fit -- what a thumbnail wants), `Fill` (stretched), `ScaleDown`
(natural size, shrunk only if it does not fit, which is `Image`'s behaviour).

**`Fit` and `Zoom` answer two different questions**, and a viewer needs the
second:

| | |
|---|---|
| `Fit` | what to do with the room there is — a picture on a form |
| `Zoom` | how big to be, whatever the room is — a picture in a `Scroller` |

`Zoom` is `0` by default, which leaves it to `Fit`. Any positive number makes
the picture that many times its own size, which inside a `Scroller` is what
panning around a photograph means. So **fit-to-window is not a mode**: it is a
zoom worked out from the room (`Scroller.Bounds()` over `SourceWidth`), which is
what every image viewer does and the reason those two are published.

Two things learnt implementing it, both worth knowing before writing a viewer:

- **A declared `Width` is a floor**, here as everywhere, so a control drawn 200
  wide never shows a zoom smaller than that. A viewer sets the zoom and lets the
  picture be the size the zoom makes it.
- **A zoom is not a size request.** It was one at first, and lasted until a
  picture was moved between containers: `set_size_request` is the runtime's own
  channel, re-applied from the declared `Width`/`Height` on every adoption and
  relayout. The zoom lives in the paintable instead — a wrapper that reports a
  scaled intrinsic size — which is where a widget's natural size comes from and
  what nothing else overwrites.

**It cannot show SVG.** `GdkTexture` reads PNG, JPEG and TIFF; anything else is
the pixbuf loaders' business, which is how `Image` gets scalable icons and this
does not. `File` throws rather than leaving an empty frame, which is also what
tells a missing file from an unreadable one.

**And it loads on the calling thread.** GTK's own `image_scaling` demo decodes in
a worker with a wait cursor and a cancellable, because a large photograph takes
long enough to freeze a window; that demo also shows what a viewer needs beyond
this control -- free rotation and a choice of scaling filter -- and does it with
a custom widget, since a `GdkPaintable` in a `GtkPicture` is drawn the way GTK
decides. Both are doors left open rather than things pretended about.

### Spinner

A `GtkSpinner`: `Active` and nothing else. A `ProgressBar` says how far along a
piece of work is; most work does not know, and a spinner is the honest answer
while a child process runs or a file is read.

`Active` and not GTK's own `spinning` — the one place the naming rule beats
mirroring the toolkit. Everything here that is on or off says `Active`, and a
second word for the same question would be one more thing to look up.

### LinkButton

A `GtkLinkButton`: `Text` and `Uri`. Pressed, it hands the address to the
desktop, which is why it is not a `Button` whose `Click` calls `Exec` — what
opens a link is the user's browser and the desktop is the one that knows which.
A link given only an address shows the address; giving it words replaces them
without touching where it goes.

### LevelBar

A `GtkLevelBar`: `Value`, `Min`, `Max`, `Mode` and `Orientation`. **Not a
progress bar**, though both are filled strips: a progress bar says how far
along a piece of work is and ends; a level says how full something *is* — a
battery, a signal, a disk — and has no end. `Mode` is the difference the theme
draws: `Continuous` fills, `Discrete` shows blocks.

`Value` is clamped to the range rather than refused, the way a `ProgressBar`'s
is: a reading out of range is still a reading, and a meter that threw would take
the program down for a disk that filled up.

### ProgressBar

A `GtkProgressBar`. `Value` is a **percentage**, 0 to 100, and not GTK's 0.0 to 1.0:
a bar is filled in by a loop that counted something, and `done / total * 100` is
what that loop has. Out of range is clamped rather than refused, because a rounding
error at the end of a long job is not worth stopping a program for.

The getter rounds. What GTK keeps is the fraction, and multiplying it back does not
always land where it started -- 42 came back as 42.000000000000006, which is a
property a grid flickers on and a `.form` grows a decimal tail in.

`Text` is drawn over the bar when `ShowText` is on, and empty puts GTK's own
percentage back (`NULL` is how GTK spells that, so an empty string cannot be stored
as one). `Pulse()` is for a job whose length nobody knows: the bar says "still
working" instead of pretending to a number it does not have.

### Slider

A `GtkScale`. `Value`/`Min`/`Max`/`Step` are the same four words a `SpinBox` uses
for the same four things, because they are the same question asked with the mouse
instead of the keyboard. `Step` also sets the page increment to ten steps, which is
what `PageUp` moves by -- as the spin does.

`ShowValue` draws the number beside the handle and `ValuePosition` says which
side -- `Top`, `Bottom`, `Left`, `Right`. `Orientation` is `Horizontal` or
`Vertical`, and both are `PropertyOptions` lists so the grid offers the words.

`Decimals` -- **and not GTK's `digits`**, because a `SpinBox` already calls this
`Decimals` and it is the same question about the same kind of number. It rounds
the *value* and not only the label: GTK snaps a dragged value to it, so reading
back one set from code has to agree with reading back the same one the user could
have landed on. A slider of whole numbers never hands a program 7.000001.

`Inverted` puts the low values at the other end -- a volume that fills upwards is
this turned over.

`Mark(value, text)` puts a tick on the rail with a word under it, and
`ClearMarks()` takes them off: the names a `SourceEditor` uses for the same idea,
something put *at* a place rather than a property of the whole. It is the
difference between a slider one drags blind and one that says where *Normal* is,
and a drag that lands near a mark snaps to it -- which is what a mark is worth
over a label beside the widget.

Shrinking `Max` below the current `Value` brings the value down with it: the
adjustment will not hold a value outside its own range.

### DatePicker

A `GtkMenuButton` with a `GtkCalendar` in its popover. GTK has a calendar and no
date field, so the field is made here -- and what that buys over a bare calendar is
room: a calendar is the size of a month, and a form asking for a birthday has a line
for it.

`Value` is an ISO date (`"2026-08-11"`) and not a `Date`, because a `.form` is JSON:
a value that cannot be written down is one the designer cannot edit and the
serialiser would drop. It is exactly what [`Day`](runtime-api.md#day) is — the
same text, so `Picker.Value = Day.Add(Picker.Value, 1)` needs no conversion at
either end, and `examples/agenda` is that line. A string that is not a date is refused rather than guessed
at, `2026-02-30` included, and a tail after one is refused too. `Format` is what the
button *reads* (strftime), so the string a program compares and the text a person
recognises need not be the same one.

**`Value = ""` is no date at all**, and it is the one piece of state GTK does not
have: a `GtkCalendar` always holds a day, with no null in it and nowhere to put
one. So the flag is ours and the calendar underneath keeps whatever it held --
which is what the popover opens on, and why browsing the months of an empty
picker does not fill it in on the way. **Choosing a day is what ends the empty
state**, because it is the one gesture that means *this date*; and a page turn
while empty raises no `Change`, since nothing changed.

This is not a convenience. `Field.Date` already spells an empty date `""` and
lets it through when the field is not required, so before this the control
answered *today* for a field nobody filled in -- a date the program never meant,
going into the record with no error and no warning, which is the one failure in
this widget set that was invisible rather than merely wrong.
[`plans/data-plan.md`](plans/data-plan.md) had written it down as the limit that kept an
optional date from making the round trip.

`Placeholder` is what the button reads while there is no date, an em dash by
default and prose when a form wants words (`"Sin fecha"`). Prose, so it is
declared as `texts` and travels through the catalogue -- `Format` beside it is
**not**, for the reason `SourceEditor` declares none: a strftime pattern put
through a translation comes back as a different date. `""` restores the dash
rather than blanking the button, which would be a button the size of its own
padding.

**There is no gesture for emptying one**, and that is deliberate rather than
missing: a calendar has no "none" to click, and inventing one -- a checkbox
beside the field, which is what Delphi and WinForms do -- would be a second
control grown inside this one. A form that offers it says so itself, with a
button and `Fecha.Value = ""`.

A [`Calendar`](#calendar) **refuses** `""` instead of accepting it: there is no
way to draw a month with no day on it, so accepting would be a value the control
could not show. The same call `Style` makes about a class name it could never
resolve.

One assignment is one `Change`. GTK offers no way to set a whole date without
raising the floor to 4.20, so it is set as year, month and day -- with the day put to
1 first, or standing on the 31st and moving to February would clamp on the way
through -- and both handlers are blocked for the three, then the event is raised
once.

**Both**, because turning the page in the popover is a change of value too, and
that took finding. GTK has one date and no separate notion of the month on screen,
so browsing to April moves `Value` to April -- and `day-selected` does not fire for
it, only `notify::month`. Until `on_date_page` was connected, a picker's `Value`
went stale behind the user's back and the button's own label went with it: two
presses of the arrow and it read March while `Value` answered May. The handler
brings the three answers back together -- the marks in view, the label, and
`Change` -- and it is shared with [`Calendar`](#calendar) because the surprise is
GTK's calendar and not either control.

The calendar is not the widget and lives in a surface of its own, so the handlers on
it are registered with `bta_widget_watch`: the finaliser's sweep cannot find them
otherwise.

### Calendar

A `GtkCalendar`, and that is the whole widget: where a [`DatePicker`](#datepicker)
keeps one in a popover behind a button, here it is what the parent lays out. The
two share every line of the value -- `date_calendar()` asks whether the widget
*is* a calendar and answers for both, `date_parse()` is the one parser, and
`date_relabel()` returns early where there is no button to relabel. So `Value`,
the ISO text, the refusals and the one-assignment-one-`Change` bargain are
[the picker's](#datepicker), described there and not twice.

**What only this one has is marks, and they are the reason it exists.** A month
with the taken days marked is what a calendar is *for*, and a popover has nowhere
to say it.

**A mark here is a date and GTK's is a day of the month.**
`gtk_calendar_mark_day()` takes a number from 1 to 31 and puts the mark on
whatever month is on screen, so marking the 4th and turning the page would show
the 4th of the next month marked too. That is never what an application means, so
what the widget keeps is the list of dates -- sorted, since ISO text sorts
chronologically, and normalised on the way in so `"2026-3-9"` and `"2026-03-09"`
cannot become two marks of the same day. The marks GTK holds are a *drawing* of
the part of that list in view, re-applied on `notify::month` and `notify::year`.
The list is `Marks`, read-only: which days are taken is what the application
knows and not something a designer draws, so no `.form` carries one.

That was measured rather than reasoned about, because "the mark is drawn" is not a
question JS can ask -- a day is a label inside GTK's own grid. Four renders of one
form under an `Xvfb` of its own, compared with `tests/probe.sh diff`: a mark in
the month on screen changes the picture, a mark a month away changes **nothing at
all** (zero pixels), and turning the page to that month brings it out. What
`tests/widgets` asserts is the list, which is the part an application reads.

`Unmark` on a date that was not marked is not an error: it is the state the caller
asked for, and a calendar clearing a day it never marked is the ordinary case. A
string that is not a date is refused by both, naming the member that took it --
`Mark: 'nope' is not a date (expected YYYY-MM-DD)`.

**A marked day is `calendar > grid > label.day-number:checked`**, which is how
`app.css` recolours one; `.today` and `.other-month` are the theme's own and are
in [the vocabulary](#styling-the-vocabulary) below. `ShowHeading`,
`ShowDayNames` and `ShowWeekNumbers` are GTK's three, and they are here because
the month is a page of a wall calendar in one form and a bare grid under a heading
the form drew in another.

`Value` is the day selected **and** the month on screen, since GTK has one of
each: assigning a date in another month turns the page to it, and turning the page
by hand moves the value -- raising `Change`, because it is the same property. That
last part is a fix and not a design: see [`DatePicker`](#datepicker), where the
same handler answers for the popover.

**Neither half of the page turn is in the suite, and cannot be**: nothing in JS can
press GTK's own arrow, and an assignment blocks the handler by design. Both were
measured under an `Xvfb` of the probe's own with `xdotool`, and the commands are in
[AGENTS.md](../AGENTS.md#traps) so the next person does not have to invent them.

### ListBox

A `GtkListBox` of label rows in a scroller. `Items` is an array of strings and
round-trips through the `.form`; `Index` is the selection or `-1`;
`Text` is read-only, being whatever is selected. `Add`, `Remove(i)` and `Clear`
mutate the list.

`Index = -1` is legitimate and has to survive: the property grid's spin for it
allows negatives for exactly this reason.

**More than one.** `MultiSelect` switches the list between GTK's `SINGLE` and
`MULTIPLE` (never `NONE`: a list nobody can select in is a different control, and
`Index` would stop answering). `Selection` is the selected indices, ascending, and
read-only on purpose -- what is selected is a fact about the moment and not part of
the design, and a setter would have the serialiser write it into the `.form`.
`Select(i)`/`Deselect(i)` answer whether there was such a row; `SelectAll()` needs
`MultiSelect` and says so rather than selecting the one row a single-selection list
would allow.

**Picking a row is not landing on one.** `Select` fires wherever the highlight
goes -- on every arrow key -- and `Activate` is the user saying *this one*: a
double click, or Enter. `TreeView` and `TableView` both raised `Activate` from the
start and a `ListBox` did not, which made "open what I picked" impossible to write
without watching for double clicks by hand. `ActivateOnSingleClick` turns one
click into the decision, for a list that *is* the choice -- a palette, a picker in
a popover -- and is off, like every other list here.

`Activate(i)` does from code what the double click does, the way `Button.Click()`
presses a button. It selects the row first, deliberately: `Activate` carries no
row of its own -- `TreeView`'s does not either -- so the handler asks the list
which one and the list has to already know. A row that is not there is not an
error, the way a list nobody has selected in is an ordinary state.

`Index` and `Text` are worked out by walking the rows and not by asking
`gtk_list_box_get_selected_row`, which answers `NULL` in multiple mode: the two
would have gone blank the moment `MultiSelect` was turned on, on a list with three
rows selected.

`Select` fires for both modes, but from two different signals -- GTK reports a
single selection through `row-selected` and a multiple one through
`selected-rows-changed`, and it emits the second in both modes, so the multiple
handler stays quiet while the single one is talking. Either way it fires only when
something *is* selected: a list that just went empty selected nothing.

### ComboBox

A `GtkDropDown`. Same `Items`, but `Text` is **settable** — and rejects anything
not in the list, which is what one wants from a drop-down. Two consequences: a
newly created ComboBox has no items, so it has no `Text` either (the designer skips
naming it, unlike every other control), and with items there is always exactly one
selected — a drop-down cannot show nothing. That is the difference from `ListBox`.

### SpinBox

A `GtkSpinButton`. `Min`/`Max`/`Step`/`Decimals` shape it; the factory range is
wide on purpose, because a `.form` applies properties in the order written and a
narrow default would silently clamp a `Value` set before its `Max`.

`Wrap` is the hour that goes `23` → `00`: a range that is a circle, which is a
property of the quantity and not of the widget style.

`Numeric` is the box refusing letters as they are typed, and it is **on** --
`gtk_spin_button_new_with_range` turns it on and this runtime keeps it that way,
because a box with arrows on it that accepts "hola" is a surprise. Turning it off
is for the box that also takes a word: a page number that accepts `end`, a size
that accepts `auto`, parsed by the program itself.

There is deliberately **no `Page`**: `Step` already sets what `PageUp` moves by --
ten steps -- and a `Page` that the next assignment to `Step` quietly undid would
be worse than not having one.

`Change` fires per click on the arrow and per keystroke — which is why the
designer's grid coalesces consecutive edits of one property into a single undo
entry.

### ColorButton

A `GtkColorDialogButton` — the swatch that opens the desktop's colour chooser —
and nothing else. `Value` is the colour as a CSS string and `""` is **none**,
which is the part GTK's own has no idea of: for `Background` and `Foreground`,
`""` means "whatever the theme says", the state most controls are in and the one
a person needs a way back to. Set to `""`, the swatch goes transparent, which GTK
draws as a chequerboard and reads as nothing rather than as black.

**The clear button beside it belonged to one program and now lives there.** It
was a second widget in a box that this control made, and its only user was the
IDE's property grid — which builds rows of controls for a living, and puts its
own clear in the row now. `Value = ""` is the way back and always was; the button
was only the affordance for it. What the removal buys is one widget instead of
three; what it does *not* buy, measured, is `Style = "flat"`: a
`GtkColorDialogButton`'s CSS node is `colorbutton` with a `button` inside it, and
the theme writes `button.flat`. The remaining nesting is GTK's own.

What it holds is exactly what a colour property takes, so it edits one with
nothing in between. Assigning `Value` reaches GTK and comes back as a real
`Change` — the same round trip a `TextBox`'s `Text` makes — and a string that
does not parse as a colour is `""` rather than an error.

There is also `Dialog.Color()` for a chooser with no button attached; the IDE's
property grid used it until this control existed, and an application that wants
to ask for a colour from a menu item still would.

### FontButton

The same shape as `ColorButton`, for the other thing a person picks rather than
spells: a `GtkFontDialogButton` that shows the font in itself and opens the
desktop's chooser. One widget, and `Value = ""` is the way back to the theme's;
the clear button beside it in the property grid is that panel's, for the reason
above. `Value` is a Pango description — exactly what `Widget.Font` takes, so it
edits one with nothing in between.

GTK's own button has no idea of *no font* and asserts on a NULL description, so
"none" is drawn as the font the theme would use anyway — which is what `Font = ""`
means in the first place.

**Where that font comes from matters.** Taking it from the widget's Pango context
looks right and is not: a context holds the size in *device units*, so an empty
button reported the desktop's 11pt as `14,67px` — a unit nobody chose, and a
different number from the one the same button shows the moment a font is picked.
It comes from `GtkSettings:gtk-font-name` instead, which is the setting as the
desktop states it, in points.

An untouched button needs telling too: left alone GTK shows a default of its own
(12 here, where the desktop's is 11), so the empty state is set explicitly at
build. Empty has to say the same thing whether it was never set or was cleared.

### TreeView

`GtkListView` + `GtkTreeListModel`, not `GtkTreeView` (deprecated since 4.10). The
API is Gambas-shaped: nodes are addressed by **string key**, and a child is placed
by naming its parent's key.

```js
Tree1.Add("forms", "Forms");
Tree1.Add("Form1.form", "Form1", "forms");
Tree1.Key = "Form1.form";          // selects it, fires Select
```

`Key` reads and writes the selection, `Exists(key)` tests, `Text` is the selected
label, `Remove(key)` takes a node out **with its subtree**, `SetText(key, text)`
and `SetIcon(key, name)` change one after it was added, and `Clear` empties it.
`Select` fires on selection, `Activate` on double click or Enter.

**`SetText` and `SetIcon` are recent, and their absence was a real hole**: a node
used to be write-once, so renaming a file in a project tree meant rebuilding the
branch and marking one as modified could not be done at all. They are
`TableView`'s `SetCell` and `SetIcon` for the control with one column, which is
why they take no column. (This paragraph used to say the tree was always expanded
and had no icons; `AutoExpand` and the icon argument below have both existed for
a while, and nobody came back to it.)

**Changing a node loses the selection unless it is put back.** Telling the store
an item changed is what rebinds the row, and under a `GtkTreeListModel` that
answers with fresh `GtkTreeListRow` wrappers — the highlight was on one of those.
A flat list does not have the problem (GTK's selection model follows the *item*),
so this is the price of the hierarchy: `SetText`, `SetIcon` and `TableView`'s tree
mode all remember the node and select it again. Renaming is not moving.

And `GtkTreeListModel`'s child-model callback must never return `NULL` —
returning it for a childless node marks that node a leaf *permanently*, and
children added later never appear. `bta_tree.c` returns an empty store instead
and hides the expander reactively.

#### Reaching a row, which is shared with TableView and used to be quadratic

**A node's row is found by descending the tree by index, not by searching for
it.** Both controls used to scan the whole flattened list looking for the row
whose item was the node, each with its own copy, saying *"scanning is the only
way: the tree model flattens on demand and has no node-to-row map"*. There is no
map and it was not the only way: GTK3 addressed a row by `GtkTreePath` — a path
of indices — and GTK4 only spelled it differently,
`gtk_tree_list_model_get_child_row` for a root and
`gtk_tree_list_row_get_child_row` for a child. Descending those *is* a
`GtkTreePath`, and it costs one indexed step per level instead of one pass over
everything on screen. The one copy is `bta_treerows.c`; each control declares
its node type in three one-line accessors and nothing else.

It mattered because `AutoExpand` is on unless turned off. Measured, filling with
it on — a folder of nine files repeated, and flat (every node a root, which is
what a project with its files in one directory looks like):

| nodes | `TreeView` nested | flat | `TableView` nested | flat |
|---|---|---|---|---|
| 400 | 29 → 12 ms | 21 → 11 ms | 25 → 15 ms | 15 → 14 ms |
| 800 | 133 → 25 ms | 84 → 24 ms | 79 → 28 ms | 28 → 27 ms |
| **1600** | **578 → 57 ms** | **328 → 53 ms** | **317 → 67 ms** | 64 → 63 ms |

Doubling the nodes used to roughly quadruple the time; now it about doubles.
`TableView`'s flat column is the one that does not move, and that is the clue to
the other half: **it never had the second bug.**

**How a tree opens is the model's job, and `TreeView` was doing it by hand.**
`TableView` passes `autoexpand` to `gtk_tree_list_model_new` and lets GTK open
each row as it arrives; `TreeView` passed `FALSE` and opened every node itself on
every `Add`, under a comment saying the model's own *"would undo every
Collapse"*. Measured side by side, the two mechanisms answer the same on all
three questions they can differ on — a childless node reads open, an explicit
`CollapseNode` survives until that node gains another child, and with
`AutoExpand` off nothing opens itself — so the fear was of something neither
does, and the hand-rolled half cost a reveal per node.

It takes **both** halves to keep those three answers, which is how the
difference was found: GTK's autoexpand opens a row as it arrives but does *not*
reopen one collapsed by hand, and the explicit reveal of the **parent** when a
child arrives is what does. `TableView` had both; `TreeView` now has the same
two, and `tests/widgets` pins the three answers against both controls rather
than against one.

A node opens and closes by name: `ExpandNode(key)`, `CollapseNode(key)`,
`Expanded(key)`, and `ExpandAll`/`CollapseAll` for the lot. Opening a buried node
opens the way to it, and so does selecting one — a closed node is not in the
flattened list at all, so without that `Key =` would silently do nothing for a
node that exists.

`AutoExpand` (on by default) is whether a node arrives open. It used to be the
model's own autoexpand, which cannot coexist with closing anything: it would
reopen it. Doing it on `Add` instead is what lets both exist, and the default
keeps a project tree readable at a glance.

**The method is `ExpandNode` and not `Expand`** because `Widget.Expand` is
already the layout boolean. A method of that name shadows it on the prototype and
is then shadowed right back the moment a `.form` sets the layout property on the
instance — which is exactly how it was found.

A node may carry an **icon**, named the way `Button.Icon` is: a fourth argument
to `Add`, from the desktop's theme or the project's own `icons/`. A name the
theme turns out not to have is dropped rather than drawn as the broken-image
glyph, so a tree degrades to text on a desktop that ships less than it claims.

Rows are built one shape whether or not a given node has an icon — but **a hidden
image takes no room**, so a tree where only some nodes carry one is ragged: the
labels of the others start further left. This paragraph used to claim the
opposite. Keeping the image visible and empty would line them up and cost a 16px
gutter in every row of every tree with no icons at all; `TableView` makes the same
choice, so the two at least agree. Give a tree an icon on every node or on none.

### TableView

`GtkColumnView`, the same list machinery `TreeView` is built on — a selection
model and a signal factory per column — and for the same reason: `GtkTreeView`
has been deprecated since 4.10 and a new toolkit should not be founded on it.

**One factory per column, told which column it is.** That index is the whole of
what a cell needs to know: the row carries its own values and a column is a view
of one of them. Rows are recycled, so a cell is a `GtkLabel` made once and
re-bound, exactly as a `TreeView`'s rows are.

**`Columns` is kept as it was declared**, and not read back out of GTK. A
`GtkColumnViewColumn` cannot be walked back into a width and an alignment
without losing which of them were defaulted — and a column that asked for no
width must not come back asking for the one it happens to be drawn at, which is
the trap `Width` on a control already had, where saving an allocation turned
today's measurement into tomorrow's floor.

It is kept **on the widget's own wrapper** (`__columns`), not in C. A `JSValue`
held from C is a strong reference the collector cannot see, and `JS_FreeRuntime`
aborts on anything still alive; the object graph owning it means nothing has to
be freed, and a `__` name is invisible to the serialiser besides, which discovers
accessors and not own properties. `__menus` and `__declared` are the same
pattern.

**`MultiSelect` swaps the selection model**, which is the only way GTK4 offers,
and the swap carries the handler with it — a table that changed mode and stopped
reporting `Select` would be the obvious bug. The selection does not survive the
swap, because the model that held it does not.

The declaration is refused whole or applied whole: every column is checked before
any is torn down, so a bad `Alignment` in the third one leaves the table exactly
as it was rather than half rebuilt.

**On demand is a second GListModel**, not a flag on the first. `BtaTableModel`
holds a `guint` and implements `GListModel`: `get_item` makes a bare row carrying
its index, and GTK only ever asks for what it is about to draw. A fresh object
per asked-for item and not a cached one — GTK holds it while the widget it built
is alive, and two visible rows that were the same object would rebind each other.

`Add` and `Count` swap the live model between that and the store, and the swap
goes through one function (`table_use_model`) because the selection mode and its
handler have to travel with it. A table that changed mode and stopped reporting
`Select` would be the obvious bug.

**The sorter GTK is given never reorders anything.** `Sortable` puts a
`GtkCustomSorter` returning `EQUAL` on every column, which is what makes a header
clickable and carries the arrow; the column view's own sorter is watched, and a
change becomes `Sort(column, ascending)`. Declaring `Columns` rebuilds the
columns and a rebuilt column has no sorter, so the flag is re-applied — which is
asserted, because the failure is silent headers.

`SortBy` collates: it compares with `g_utf8_collate`, so a column of names comes
out in the desktop's order and not in codepoint order. A table that sorts its own
rows therefore needs nothing said about it — but a list an application sorts by
hand does, and the answer for that is
[`Locale.Compare`](runtime-api.md#ordering-names-and-finding-one). The two were
apart for a long time, which is how the IDE's project tree came to file every
accented file name after Z.

**What it does not do yet**, said rather than implied: editing a cell in place by
clicking it — which in Gambas is exactly what separates `GridView` from
`TableView`, so this one does not yet mean what that one does — and per-column
types (`DataGridViewCheckBoxColumn` and its family). Binding a table to a
`Record` is [plans/data-plan.md](plans/data-plan.md), and `Data` is the hook it was missing.

**`examples/table` is the whole of it running.** Two pages side by side, because
which mode you picked is what everything else follows from: one table holds five
rows and answers `Cell`, `SetCell`, `SetIcon` and `SortBy`; the other claims a
hundred thousand and answers `Data`, refusing all four. The second page counts
the questions it was asked and shows the number, which is the argument for the
mode in one line -- a hundred thousand rows, a few hundred questions. Its
`po/es.po` is worth a look too: the column headings are in it and the alignments
are not.

### TableView: the tree mode

A `GtkColumnView` over a `GtkTreeListModel`, with a `GtkTreeExpander` in the
first column's factory — the same three pieces `TreeView` is built from, put
under the control that already had the columns.

**Why here and not columns on `TreeView`.** The column machinery — widths,
alignment, headings, the sorter, `Cell`/`SetCell`/`SetIcon` — exists once, in
`bta_table.c`. Growing it on the other control would be a second copy of it, and
a fact written twice goes stale in one; extracting it is not available either,
because `GtkColumnView` is not a `GtkListView` and the `Editor` precedent (one
implementation because *GTK's own hierarchy has the same shape*) does not apply.
What this costs instead is a third **mode**, and this control already has modes
with a table of refusals to say so. It also avoids swapping a widget's class from
a property setter, which is a trap this codebase has already paid for once.

**And the boundary between the two controls is GTK's.** `GtkColumnView` has no
`show-header`: `set_show_row_separators` and `set_show_column_separators` are
what can be turned off, and `set_header_factory` is for *section* headings. So a
hierarchy with no heading row is not expressible here, and `TreeView` is not a
`TableView` with one column — it is the other control, permanently.

**A key, not an index.** A position in a `GtkTreeListModel` is a position in the
flattened, currently-expanded list: it changes when a node above collapses. So
the tree mode addresses rows by the key the application chose, and keeps a
`key -> node` hash beside the store. `Index` still answers — it is where the
highlight is — and it is not something to remember.

**Two things fall out of the model that had to be written by hand.** A node's row
only exists once its ancestors are open, so `ExpandNode` and selecting by key
both walk the chain from the root first (`table_reveal`) — setting the flag on an
unreachable node does nothing at all. And sorting a level makes the tree model
build fresh `GtkTreeListRow` wrappers, so the selection is lost where a flat
table keeps it (GTK's selection model follows the *item* across a reorder):
`SortBy` remembers the node and selects it again, which is only possible because
a node has a key.

**The child-model callback always hands back the store**, even when it is empty.
Returning NULL marks a node a leaf permanently — `GtkTreeListModel` asks once,
and a child added afterwards would never appear — and `Add` takes a parent by
key, so a parent is routinely inserted before its children. The cost is that GTK
would draw an arrow on every node; the bind hides it on the ones with nothing
under them.

**A hidden icon takes no room.** A cell is an icon and a label in a box, and the
image is hidden when the cell has none — so a column where only *some* rows carry
an icon is ragged, the text of the others starting further left. Both this
control and `TreeView` make that choice; keeping the image visible and empty
would line them up and put a 16px gutter in every cell of every table that has no
icons at all. Give a column an icon on every row or on none.

### Scroller

A `GtkScrolledWindow` around a `BtaFixed` in a viewport, so `X`/`Y` inside it
mean what they mean everywhere and the content may be larger than the view.

**The scroll position is the adjustments', and the maximum is `upper -
page_size`.** A `GtkAdjustment`'s `upper` is the size of the *content*, so
scrolling there would ask for a position with the last screenful already off the
edge; what a caller means by the end is the last position that still shows
something. That is also what makes `ScrollY === ScrollMaxY` the test for *at the
bottom*, which is the whole of infinite scroll.

**The `Scroll` event is on both adjustments and reports both axes.** GTK moves
one axis at a time, and by the time either says so the other's value is already
the new one — so a diagonal move is one event carrying the new position, not two
carrying halves of it. The adjustments are not the widget, so the handlers are
registered with `bta_widget_watch`: without it they outlive the scroller and fire
into freed memory.

**And `Arrangement` decides whether it also *fills*.** The `BtaFixed` above is
the default and not the only slot: arranged `Horizontal` or `Vertical` the slot
is a `GtkBox`, which stretches an expanding child across itself and lets it ask
for more than the view along itself. That single property is the difference
between the two containers other toolkits keep apart — WinForms'
`TableLayoutPanel` and `TableLayoutPanel` + `AutoScroll`, CSS `grid` and `grid`
inside `overflow: auto` — and it is what a wall of tiles whose count is not
known in advance needs: one tile takes the stage, four come out 2x2, twenty
scroll. Measured in a 900x500 view, a `Grid` of `Homogeneous` tiles with a
180x130 floor and `HExpand`/`VExpand`:

| tiles | the grid | `ScrollMaxY` | the view |
|---|---|---|---|
| 1 | 898x498 | 0 | 900x500 |
| 4 (2x2) | 445x245 each | 0 | 900x500 |
| 20 (4 columns) | 924x538 | 38 | 900x500 |

and the same grid in an unarranged scroller is **180x130** for the one tile and
**366x266** for the four, with the rest of the view empty — which is what was
reported as a missing container before anybody tried the property.

The `Fixed` slot cannot do it, and the reason is worth keeping: an anchor keeps the gap a control was *drawn* with, against a design
size that only a **form** has (see the anchoring notes above), so `HAlign: Fill`
on a scroller's content has nothing to fill.

**What decides whether it scrolls or grows the window is `Scrollbars`, and not a
floor.** An axis that may not scroll has to be given its content's minimum and
propagates it outwards: the same twenty tiles under `Scrollbars: "Vertical"`
take the window from 900 to 924 wide, and a `MinWidth` on the scroller changes
nothing either way (measured both). [`examples/kanban`](../examples/kanban) is
the shape in both directions — a board arranged `Horizontal` whose columns are
as tall as it is, each column a scroller arranged `Vertical` whose cards are as
wide as it is.

### DrawingArea and Painter

A `GtkDrawingArea` with `gtk_drawing_area_set_draw_func`, and a `Painter` over the
`cairo_t` that function is handed. It is the one control in this set with no
content of its own: whatever the handler paints is what is on the screen.

**Three shapes it deliberately is not.** *Not a retained scene graph*
(`Plot.Add(shape)`, objects that redraw themselves): a chart's frame is different
every time, so the graph would be rebuilt per frame and the API would have bought
an allocation per shape. Immediate mode is what cairo, canvas, `Graphics` and
Gambas' `Draw` all are, and `Redraw()` is the whole of the state it needs. *Not a
`Draw` event on every `Panel` and `Form`*, the way VB let one draw on a form:
`BtaFixed` implements its own allocation, so a `snapshot` override emitting `Draw`
under or over the children is genuinely reachable -- and it is a paint layer on
every container in the language for one client that actually wanted a control. If
a real case turns up -- a watermark, a connector line between two controls -- that
is where it goes. *And not charts in C*: it would give the designer a live
preview, since the IDE runs this same runtime, and it is well over a thousand
lines of C against the rule that what an application needs belongs in the language
this thing ships. The preview is worth having and is the designer's problem to
solve for every component at once.

**A `DrawingArea` is not accessible, and nothing here can make it so.** A screen
reader gets nothing from ink. A drawing that carries information has to say it
some other way too -- at minimum a `Tooltip`, and for a chart a `TableView`
alongside with the same numbers. It is worth knowing before the drawing is written
rather than after.

**The painter is valid only inside the `Draw` it came from.** Every call goes
through one function that refuses otherwise (`Painter: the frame is over`), and
that is not defensive programming: the natural mistake is to keep the painter in
`this` and draw from a timer, and without the refusal that is a write into a
`cairo_t` GTK destroyed several frames ago -- which would surface as a crash in
whatever ran next.

**It is one painter per surface, reused**, kept on the widget's own JS object as
`__painter` -- the way `__children` is kept -- so the collector holds it for
exactly as long as the widget and there is nothing to free by hand. A wrapper
allocated sixty times a second and thrown away is a cost that is invisible until
something animates.

**A painter arrives with the theme's ink**, a line one pixel wide, no dashes and
the widget's own font. Cairo's own default is opaque black, which is invisible on
half the desktops there are, and a control's font is what every other control
follows -- so a handler that draws without setting anything is legible, and one
that draws text follows the desktop's font and text scale for free.

**An image is decoded once and kept.** `Painter.Image` goes through
`gdk_texture_new_from_filename` -- the same call `Picture.File` makes, so the two
agree about what is an image -- and downloads the pixels into a cairo surface,
because a painter is a cairo context and nothing else. That download is the
expensive part (a 1200x600 logo is 2.8 MB of ARGB) and a drawing paints every
frame, so surfaces are cached by path with the file's mtime and size beside them:
a logo replaced on disk is read again, and a program that walks ten thousand
photographs does not grow without end (the cache is emptied whole past 32
entries). **One of `width`/`height` is enough** -- the other follows the file's
proportions, since asking the caller for both is asking it to know what shape a
file it just read is.

**A file that is not there throws, and that ends the frame.** The alternative --
drawing nothing where a masthead goes -- is a report that looks finished and is
missing its letterhead. It is the same bargain `Picture.File` makes.

**`SavePdf` is `Save` with more than one page, and a vector surface.** The size is
in points because that is what a PDF page is, the handler is told those numbers as
its frame size, and `before(page)` says which page is coming. `lib/report` is what
uses it, and what asked for it.

**The page is an argument now, and `Draw` never grew one.** Growing a fourth
argument on `Draw` would have changed every handler ever written, so paper got an
event of its own instead: `DrawPage(painter, page, width, height)`, raised in
place of `Draw` by `SavePdf` and by `Printer` when the form declared one. A form
that declares none still gets `Draw`, which is why nothing had to change when it
arrived -- and a drawing that is one page never needs it. What it retired is the
arrangement underneath `before`: the page travelled through a field of the form,
written by one callback and read back in another, which was the only place in
this runtime where two handlers talked through `this`.

**Paper is `Printer`'s and not the drawing's**, and that is the one decision in
it: a printer is a thing outside the program -- it has a name, a default and a
dialog -- so the questions about it do not belong on a widget, while `Save`,
`ToPng` and `SavePdf` do because they write what the drawing *is*. The noun is
also why it is not called `Print`: `print` is already a global of this runtime,
and `Print` as a verb means *writing text* in the family this language comes
from. VB6, Delphi, Gambas and .NET all landed on the same word.

**How many pages there are is asked, not assumed.** `Pages` in the setup is
worked out against the paper the *caller* had, and the person may pick another in
the dialog: a `Markdown` laid out for A4 is six sheets on A5, and the operation
printed the four that were declared and dropped the rest -- measured, and silent.
`Paginate(width, height)` is raised in GTK's `begin-print`, which is the only
place both halves hold: the paper is resolved and `set_n_pages` may still be
called. The size it is asked with is the **printable area**, the sheet less the
printer's own margins, which is the size `DrawPage` will be handed. A control
whose layout does not move with the paper declares none and keeps the count it
was given -- `lib/report` scales a page to fit and does not answer,
`lib/markdown` re-flows and does. **Measure inside it and raise no events**:
`lib/report` answered `PageCount` for one afternoon, `PageCount` measures when it
has to, and measuring inside `begin-print` re-entered the drawing the operation
was in the middle of. The suite hung.

**Two verbs, because they are two things.** `Printer.Send(area, setup, cb)`
opens GTK's print operation -- asynchronously, with a callback, the way
`Dialog`'s three verbs do, and not called at all on a cancel -- and
`Printer.ToFile(area, path, setup)` exports a PDF with no dialog, synchronously,
because there is nobody to wait for -- "print to PDF", and the only road the suite can assert on, since a
test cannot click a dialog. They were one call with a `ToFile` key once, and what
settled the split was measurable rather than tidy: `Copies: 3` with a file
answered *three copies sent* and wrote the same file, byte for byte, as one copy.
A file has no copies, so `ToFile` refuses the key instead of carrying a number
nobody applies. It is the same split `Dialog.OpenFile`/`SaveFile` is.

The dialog is the desktop's -- printer list, page setup, range, copies -- and so
is the preview: `Vista previa` opens it in the desktop's preview application
(Evince/Papers), so a machine with neither installed has no preview to open. The
rendering is the same handler against the print context, so a page that fits the
paper in `SavePdf` fits it here; its frame is the printable area in points, not
the whole sheet. Measured while building it, and worth knowing before touching
this path again: on `EXPORT` this GTK renders every page whatever range the
settings carry, so a range there is said with the page count instead -- the file
then holds exactly `From..To`. `Send`'s callback is handed what was actually sent -- `{ Copies, From, To }` --
and is not called when the dialog was cancelled; `ToFile` comes back with how
many pages it wrote. **One control prints once at a time**: the nested main loop
GTK runs means a timer or a second click can reach a print that is still waiting,
and a second one used to start and write its pages, which the painter's own guard
cannot see because between two sheets no frame is open.

**`Names` and `Default` are the Unix print backend's**, a GTK module of its own
(`gtk4-unix-print`), and they have **three** answers rather than two: the
printers, `[]` for a machine with none, and `null` for a session that cannot ask.
They threw at first, on the argument that an empty list cannot be told apart from
a machine with no printer -- which is true, and is an argument for a third value.
A throw made asking what this build can do something a program has to catch, and
the suite paid for it twice: unguarded it ended `Form_Open` with 1633 assertions
unrun, and guarded it was a `try` around a capability question. Printing is unaffected either way: the dialog is core GTK. Not cached,
at 33.6 ms cold and 6.2 ms warm on this machine, because GTK caches its backend
underneath and the printers a machine has do change while a program runs.

**A `Draw` that throws now fails the export.** The handler's error is reported
where every event's is and then consumed, so `Save` could not tell -- it wrote a
PNG of whatever had been drawn before the error and returned happily, which is the
one thing an exporter must not do. `bta_emit_ok` is the same emit answering
whether the handler threw; `paint_frame` turns that into an exception the exporter
can fail with, and the on-screen draw function throws it away, because there a
frame that died is a frame that died and there is nobody to tell.

**`Foreground` is the control's own, resolved.** `gtk_widget_get_color()` answers
the *computed* colour, so a `.form` that sets `Foreground` on the surface colours
its drawing without the handler knowing anything about it -- and a drawing that
says nothing is drawn in that colour, since it is what the painter arrives with.
One wrinkle, measured: **changing** it after a frame has been drawn does not reach
the painter until a turn has passed (the computed style is a frame behind), while
setting it before the first frame lands at once. On screen this never shows,
because a frame is always a turn away; it shows in a `Save()` called in the same
turn as the change.

**There is no `Background`, and that is GTK4 rather than a choice.**
`gtk_widget_get_color()` answers what colour this widget's text is drawn in, which
is what `Foreground` is; there is no supported per-widget answer for the ground --
the way to paint one is the widget's own CSS. So a drawing does not paint its
background, the control's `Background` shows through, and `Dark` (the ink's
luminance, over a half) is how a palette picks colours that work either way round.
Inventing a `Background` by reading a style property would have been a number that
is right on one theme.

**`ArcNegative` is there because a ring cannot be drawn without it**, and it is
the one primitive the chart set asked for that stage 1 did not have. A doughnut
segment is the inner start, out to the outer radius, the outer arc forwards, in
again, and the inner arc *backwards* -- one path, closed once, filled once. With
only a forward arc the way back has to be a `MoveTo`, and a `MoveTo` starts a new
subpath: the fill then runs the winding rule across both and cuts wedges through
the middle of the chart, which is exactly what the first doughnut in
`examples/charts` looked like. Approximating the way back with two dozen `LineTo`s
also works, and is a visible polygon at any size worth looking at.

**`Text` clears the path and `Arc` does not.** Cairo appends an arc to the current
path, joining it with a line from wherever the current point was -- which is
exactly what a pie slice wants (`MoveTo` the centre, `Arc`, `ClosePath`, `Fill`).
Showing a text layout leaves a current point behind, so the first drawing this
file ever made had a stray diagonal from a label to an arc. `Text` is a drawing
call and not a path call, so it now leaves no path, like `Fill` and `Stroke`.

**Angles are in degrees**, for `Arc` and `Rotate` both, and cairo takes radians:
the conversion is at the edge on purpose. This is a language where a person writes
a form, and a slice or an axis label is written in degrees by everybody who is not
a graphics library. The two would be a trap if they disagreed.

**`Polyline(points)` takes a flat array**, `[x, y, x, y, …]`, and it is worth
about 2x over a loop of `LineTo` -- not the hundredfold one expects. Measured:
filling a JS array costs ~405 ns an element and a two-argument call into C ~465 ns,
so the interpreter is the floor and batching moves the work rather than removing
it. The honest budget either way is tens of thousands of primitives a frame.

**`Antialias` is the one performance knob, and it is there because of a
measurement**: in an 800x400 area, 5,000 points cost 2.15 ms stroked as a curve
one can read and **109 ms** stroked as a zigzag crossing the full height, because
the rasteriser pays per covered pixel and not per point. With antialiasing off the
second one is 7.8 ms. `tests/manual/cairo-cost.c` is that measurement, kept -- a
standalone program, because it was taken before there was a binding to measure
through. The rest of what it says about an 800x400 surface, 20 repetitions:

| | |
|---|---|
| 50 filled bars | 0.03 ms |
| 200 points, smooth line, stroked | 0.42 ms |
| 500 points | 0.61 ms |
| 2,000 points | 1.17 ms |
| 5,000 points | 2.15 ms |
| 20,000 points | 8.33 ms |
| 200 text labels, laid out and drawn | 1.84 ms |
| 200 text measurements only | 0.75 ms |
| the surface written out as a PNG | 9.81 ms |

Text is cheap enough to be uninteresting -- an axis of twenty labels is about
0.2 ms -- with one note: **measuring is 40% of the cost of drawing**, which is why
the painter keeps one `PangoLayout` and reuses it, and why a drawing that lays out
the same axis every frame should keep its strings rather than rebuild them.

**And a stopwatch inside `Draw` cannot see any of it on screen.** GTK4 gives the
draw function a cairo context over a *node*: the calls are recorded there and the
rasterising happens afterwards. So the handler reports about the same milliseconds
whether antialiasing is on or off, while the window's frame rate collapses. The
only honest way to ask *is this smooth* is to count frames, and `Save()` is the
other side of it: an image surface rasterises inside the call, so there the
handler's own time is the real one -- 283 ms against 28 ms for that jagged line.

**A number without its conditions is no use here, so these are the conditions.**
Counted frames while redrawing as fast as GTK will, in the 402x159 sparkline of
`examples/drawing`:

| points | shape | antialias on | off |
|---|---|---|---|
| 120 | either | 60 | 60 |
| 360 | either | 60 | 60 |
| 1080 | jagged | 51 | 60 |
| 3240 | jagged | **15** | 60 |
| 9720 | jagged | **3** | 31 |
| 9720 | smooth | 56 | 60 |

**And the box counts as much as the data**, which is what "covered pixels" means
in practice: the same table measured again in a 402x419 sparkline -- the same width,
two and a half times the height -- is 29 frames a second at 1,080 points, 7 at
3,240 and 1.2 at 9,720. Roughly twice the cost for roughly twice the vertical
travel per segment.

**The practical conclusion is the reassuring half, and it deserves to be said
first: below about a thousand points nothing shows, whatever the shape.** A chart
of a hundred bars or a series of five hundred readings draws at sixty frames a
second and no knob matters. What the cliff needs is *thousands* of points **and**
a line that crosses its own height -- and at that point the drawing is also
illegible, six points to the pixel, which is why the answer in a chart is to
decimate and not merely to turn antialiasing off.

It does not depend on the renderer: measured at 8.5-8.8 frames a second under all
four of `GSK_RENDERER=cairo`, `gl`, `ngl` and `vulkan`, because a cairo node is
rasterised on the CPU whichever renderer composites it afterwards.

`examples/drawing` has the measurement as a button, and its status line says when
what you just measured was not in the interesting regime -- which is most of the
time, and was the first thing anybody running it noticed.

**A handler may delete its own surface**, which is the one re-entrancy worth
naming since `Draw` runs while GTK is painting: measured, and it neither crashes
nor complains -- the painter's frame is closed on the way out and every later call
on it refuses, the same as any other frame that has ended. What it must not do is
ask for a second frame; see `Save()` below.

**A drawing area has no natural size**: there is nothing inside it to measure, so
one placed with neither a size nor an `Expand` is allocated 0x0 and its handler is
called with a 0x0 frame. Nothing draws, and it reads as a broken control rather
than as an unsized one. The designer's palette gives a placed one 240x160 for that
reason.

**`Save()` is refused from inside a `Draw`.** There is one painter per surface, so
a frame asked for from inside a frame would hand the handler's own painter a second
context and take it away on the way out -- leaving the outer frame refusing with
*the frame is over*, which is true and unactionable. It is also refused above 16384
a side, before the allocator is asked for the gigabyte a transposed digit would
want.

**`Save(path, [width], [height])` is the same `Draw` against an image surface**,
and it is in the first version of the feature rather than a later one because it
does two jobs: a chart in a report is what people ask for, and a frame rendered
without a screen is what makes the whole thing testable. `Dump()` is the other
half -- the last frame as text, one call per line -- and it is what `tests/widgets`
asserts a drawing with, on the same argument `Widget.Dump()` makes: a picture
proves nothing twice and cannot be diffed.

**`ToPng([width], [height])` is that same frame as `Bytes`**, and it closes a
circle the runtime had open at both ends. `Http` answers `Bytes`,
`File.LoadBytes` reads them and `File.SaveBytes` writes them -- but the only way
*out* of a drawing was a path, so a chart to be posted, mailed or put in a reply
meant a temporary file written and deleted around the one call that mattered.
`Picture.LoadBytes` is the way in and this is the way out. It shares every line
of `Save` but the disposal of the pixels, `area_frame`, so the two refusals (a
surface that was never allocated has no size; 16384 a side) and the rule that **a
frame whose handler threw is not an answer** hold for both without being written
twice. `To`-something is what this tree already calls the same thing in another
form -- `Bytes.ToText`, `ToBase64`, `ToHex` -- and PNG is in the name because it
is a decision: lossless, alpha kept, read by everything.

**`Painter.Image` takes either too**: a string is a file and `Bytes` are the
image, which is the whole of the choice. One thing to know before drawing in a
loop -- **bytes are decoded on every call**. The image cache is keyed on the
path, with the file's mtime and size behind it; bytes have no key that stays
true, since a freed buffer's address can be handed out again and a cache keyed
on one would eventually paint the wrong picture. Measured here, painting a 640x480 PNG
costs **2.7 ms from bytes against 0.045 ms from the cached path** -- sixty times
the work, and still nothing worth naming for a report drawing a logo on every
page. A handler painting the same bytes sixty times a second is the case that
cannot afford it, and wants a `Picture` instead, which decodes once.

Numbers in a `Dump()` go through `g_ascii_formatd` and not `%g`, which is not
pedantry: printf follows `LC_NUMERIC`, so the point `(380, 142.449)` came out as
`(380,142,449)` on the machine this was written on -- a decimal comma in the
middle of a comma-separated pair, in the one output a test reads. An image drawn
from bytes is named in the dump by how many there were (`Image "24630 bytes" at
(120,5) 30x20`), since there is no path to name.

### Editor, TextEditor and SourceEditor

**Three classes over two widgets, and the shape is GTK's own**: a `GtkSourceView`
*is* a `GtkTextView`, so everything a plain view can answer -- the buffer, the
cursor, the selection, undo, and the `Change` and `Cursor` events -- is declared
once on an abstract `Editor` ([bta_text.c](../runtime/src/bta_text.c)) and
inherited by both. `TextEditor` is the plain one and `SourceEditor` is the source
one ([bta_editor.c](../runtime/src/bta_editor.c)); everything from `Language`
down in this section is the second one's.

**`TextEditor` is the control this widget set went without**, and the cost of not
having it was paid in the IDE: a `TextBox` is one line and a `GtkEntry` cannot
hold a newline at all, so an observations field, a note or a log pane had to be
the source editor with its languages turned off. `PoForm`'s translation boxes were
exactly that, in three lines -- `Language = ""`, `ShowLineNumbers = false`,
`Wrap = true` -- and those lines are gone: a plain editor arrives that way.

**The one default the two disagree about is `Wrap`**, and it is the whole
difference in use. Prose in a box 240 wide with a horizontal scrollbar under it is
a field nobody can read, and code that wraps hides its own indentation. So a
`TextEditor` wraps and a `SourceEditor` does not; the property is the same
inherited one, and what differs is what each control starts at. A `TextEditor` is
also not monospaced, for the same reason -- it holds text a person writes, not a
file a program reads -- and a form that wants a fixed pitch says so with `Font`,
which is every control's answer to that question already.

**And `Text` is prose on one and not on the other, which is why they are siblings
rather than one extending the other.** A `.form` may declare a starting note in a
`TextEditor` and have it translated like any caption; a `SourceEditor`'s `Text`
must never reach a catalogue, or a `.po` would rewrite somebody's code, silently
and only in one language. `texts` accumulates *down* a class chain (see
`class_list_of`), so a source editor whose parent were `TextEditor` would inherit
that declaration and there would be no way to refuse it. Two siblings can
disagree about a property; a child cannot disagree with its parent -- which is
the whole argument for the abstract class in the middle, and it is asserted as a
pair in `tests/widgets` so neither half can quietly become the other.

The rename it came with has one sharp edge: **a `.form` that still says
`TextEditor` where it means the source one now loads the plain editor, and the
source-only properties in it do nothing without saying so.** `applyNode` assigns
what a file declares (`widget[key] = value`) and never asks whether the class has
that property, so `Language: "js"` on a plain editor is an ordinary JavaScript
property on the object and nothing else. Renaming the type in the file is the
whole of the fix.

#### What the source editor adds

`GtkSourceView` in a scroller. `Language` and `Theme` are GtkSourceView's own ids,
and `PropertyOptions()` for either asks the library what it has, so the list cannot
drift from what the setter accepts (`""` is plain text, and is in the list).

`Line`/`Column` are read-only and 1-based; `GotoLine(n)` scrolls with the line
against the top edge, not centred — 0.3 looked like an empty block above a short
file. `Modified` is the buffer's dirty flag, reset on load; the serialiser skips it
because it is editing state, not design state. `Insert` writes at the cursor;
`Append` writes at the end and scrolls there whatever the cursor was doing — what a
log pane wants — and works even when `ReadOnly` is set, since that only blocks the
user's keyboard and not the program. `Undo`/`Redo` and `CanUndo`/`CanRedo` are the
buffer's.

**An `Offset` is a character and an index is a JavaScript number, and the two are
not the same count.** `Offset` and `OffsetAt(line, [column])` count characters, as
`Column` and `Select` do: an emoji outside the BMP is one, and
`OffsetAt(Line, Column) === Offset`. `LineOf(index)` is the other direction and
takes the number a *search* returned — `Regex.Index`, `indexOf` — which counts
UTF-16 units and calls that emoji two. It does not fail on it: the walk converts
exactly, which is the difference between the two numbers and why
`GotoLine(LineOf(m.Index))` lands on the line the match was on. The pair is not
interchangeable, and the reason is that nothing here can change what JavaScript
calls a position: `slice` and `Regex` hand out UTF-16 units, GTK counts
characters, and each verb is handed the one its caller already has. Which
separator counts as a line is GTK's too — `\n`, `\r\n` as one, a lone `\r` and
U+2029 break, U+2028 does not — and that is deliberate, because the line is about
to be given to `GotoLine`.

Loading text resets the cursor to the start and the view to the top, which
`gtk_text_buffer_set_text` does not do on its own.

**Searching** is a `GtkSourceSearchContext`, made on the first `Search()` and tied
to the view's lifetime -- it references the buffer, so it may not outlive it.
`Search(text, opts)` says what to look for, highlights every match as a side effect
of the context existing, and answers how many there are; `opts` takes
`CaseSensitive`, `WholeWord` and `Regex`, and a broken pattern is refused with what
is wrong with it. An empty text clears the search, highlight included.

**`Regex: true` here is a different engine from the language's `Regex`**, and
nothing but this paragraph says so. GtkSourceView compiles the pattern with
GRegex -- PCRE2 -- always with `G_REGEX_MULTILINE` and with `CASELESS` when the
setting asks for it, and GLib turns PCRE2's Unicode properties on for every
pattern. So in the find bar `^` and `$` match at every line whatever the
pattern, `\d`/`\w`/`\b` are Unicode-aware, `$` also matches before a final
newline, and PCRE2 grammar (`\p{L}`, `\K`, atomic groups) is available. In a
`Regex` the same text is ECMAScript: ASCII `\w`, one line unless
`{ Multiline: true }`, and `\p{L}` behind `{ Unicode: true }`. A pattern shared
between a find bar and a lint should be written the language's way; the
[`Regex` page](reference/globals/Regex.md) has the detail.

It does **not** move the cursor. Highlighting the matches and going to one are two
things a find bar does at different moments -- typing versus pressing Enter -- and
only the caller knows which this is. `FindNext`/`FindPrevious` are what move, from
the far side of the current selection so the match one is standing on is not found
again, and they wrap around. `Replace(with)` acts on the selection if it is a match
and leaves the replacement selected, so a Replace/FindNext loop walks the file;
`ReplaceAll` answers how many it did.

`Matches` and `MatchIndex` (the "3" and the "12" of `3/12`) are counted by walking
the matches, not taken from GtkSourceView's own `occurrences-count`: that one is
filled in by a scan running in the background and answers `-1` until the scan
lands, so a count would arrive some frames after the search and a test could only
wait and hope. Walking is synchronous, exact, and assertable -- and on a source file
it is work nobody can measure.

`Selection` is the selected text, read-only: what is selected is a fact about the
moment, and a setter would put it in the `.form`. Pre-filling a find field with the
word under the cursor is what it is for.

`Select(line, [column], [length])` is the other end of it: the cursor to a place
and `length` characters taken from there. `GotoLine` reaches a *line*; this
reaches a **match**, which is what a list of results somewhere else in the window
has to be able to hand back. A column past the end of that line is the end of it,
so a result standing on a line edited since lands where it can rather than
somewhere else entirely. What is revealed is the start of the match, and through
the selection's mark rather than an iter -- a tab that has just been opened has no
allocation yet, and scrolling to an iter in a view with none does nothing at all,
silently.

**Completion has two halves, and the second one is an event.**
`Completion` turns on GtkSourceView's own words provider, which proposes what is
already in the buffer -- the floor of what an editor owes, and the whole of what
can be known without being told anything. `Complete` is the telling:

```js
Ed_Complete(word, line, column, before) {
    if (before.endsWith("this.")) return this.Controls.map((c) => c.Name);
    return [];
}
```

`word` is what is being typed and `before` is the line up to where **that word
starts** -- not up to the cursor, and not the whole buffer. `line`/`column` are
that same point, 1-based. Measured rather than assumed, because both halves
matter:

| typed | `word` | `before` |
|---|---|---|
| `this.Ok.` | `""` | `"        this.Ok."` |
| `this.Ok.Te` | `"Te"` | `"        this.Ok."` |
| `Ok_` | `"Ok_"` | `"    "` |

So a name being completed **is the word**, punctuation and all -- `_` is a word
character, which is why a handler being written arrives whole -- and `before` is
the stable context to its left, the same string whether two letters of the
property have been typed or none. A handler that looked for the word inside
`before` would answer for the first keystroke and stop for the second.

Not the whole buffer because this fires on every keystroke that could start a
completion, and copying a source file into a string per character typed would be
the feature's whole cost. Anything that really wants the file reads `Text`.

**Narrowing is the runtime's, not the handler's.** Asked about `this.Btn1.` a
handler says what a `Button` has; that the user has typed `Te` since is not its
business, or every application would write the same filter differently. The
proposals are matched and ranked with GtkSourceView's own fuzzy match, so the
list narrows and highlights exactly as every other provider's does.

An answer is an array of strings, or of `{ Text, Detail }` for a row that says
something about itself; anything else in the array is skipped rather than
refused, so one odd entry costs an entry and not the popover. Returning nothing
at all is a form with nothing to say, which is also what an editor whose form has
no handler does -- and such an editor behaves exactly as it did before this
existed, `.` included, since a dot only starts a completion when there is
somebody to ask.

**The handler is a lookup.** It runs inside GTK's completion machinery, on the
keystroke, so a slow one is a keystroke that stutters and one that throws is a
popover that does not appear. What makes that a reasonable rule rather than a
warning is that the interesting completions in this runtime *are* lookups:
`PropertyNames()`, `EventNames()`, `PropertyOptions()` and a sibling `.form`
answer them without anything being inferred. What the IDE answers with them is in
[ide.md](ide.md#what-the-editor-proposes).

`CompletionTitle` is the heading the answers appear under, and it is prose --
declared as such in the class row, so it goes through the catalogue like a
caption. It is the first heading the runtime shows that the application gets to
name: a msgid living in C is invisible to the IDE's extractor, so a fixed English
word there could never be translated by the application that owns the words.

`ShowCompletion()` asks for a completion where the cursor is, which is what a
*Complete* menu item on `Ctrl+Space` does. It answers `false` on a view that is
in no window -- and it needs the keyboard focus to show anything, which means its
window has to be the active one.

**Marks in the gutter.**

```js
Ed.Mark(12, "Error", "SyntaxError: unexpected token");   // and the line it is on
Ed.Marks("Error")        // [{ Line, Kind, Text }], in line order
Ed.Unmark(12, "Error");  // that kind, that line
Ed.ClearMarks("Error");  // that kind, everywhere; no argument is every kind
```

Seven kinds, named after what they mean rather than after an icon: `Error`,
`Warning`, `Info` and `Bookmark`, which put an icon in the gutter — and `Added`,
`Removed` and `Gap`, which **paint the line**, because a side-by-side diff whose
two panes are two files is two files. The tints carry an alpha and are therefore
blended over whatever the theme paints, which is what keeps one pair of numbers
right in a light scheme and in a dark one; `Gap` is a line that is not there on
this side, which is how ten added lines on the right can face the place they were
added on the left. Anything else is refused, because the
alternative — a free-form category — makes every caller pick an icon name, and one
the desktop turns out not to have draws a blank square with nothing to say why.
Each kind carries a list of icons and the first that really renders wins: this
desktop has `dialog-warning-symbolic` and neither `dialog-error-symbolic` nor
`dialog-information-symbolic`, so a single name would be an empty gutter here and
perfect under Xvfb, where GTK falls back to Adwaita.

The text is what the mark's tooltip says, so the message belongs to the line it is
about rather than to a second table to keep in step. `Marks()` walks GTK's own
marks for the same reason: a mark moves with the text it sits on, and a copy kept
here would be wrong the first time somebody typed a line above it.

`ShowMarks` is the gutter itself, and `Mark` turns it on — a mark nobody can see
is a flag that reads back while the effect never happened, which is a failure mode
this codebase has met twice. Clearing the marks deliberately does *not* turn it
off again: a gutter that comes and goes moves the text sideways under the cursor.

### Terminal

VTE with a real pty. `Run(argv, cwd?)` spawns; `Feed(text)`
writes to the display without a child; `Clear()` resets. `Stop()` asks the child
to end (SIGTERM) and `Kill()` makes it (SIGKILL) — the same two verbs, meaning the
same two things, that an `Exec` handle takes; both answer whether there was a
child at all, so a Stop button pressed twice is an ordinary thing to do.

**The pty is optional at build time**, and it is worth knowing that before the
rest of this section: everything below describes a build that has VTE, and
[*a build without VTE*](#a-build-without-vte) says what the other one does.

`Exit(code)` fires when the child ends, `Running` says whether one is alive, `Text` is everything it has shown
— scrollback included, not just the rows that fit — which is how a test can assert
what a child printed.

`Text` takes its range from the cursor and the scrollback size, not from the scroll
adjustment: rows are numbered from the first line the terminal ever showed, and the
adjustment of a terminal nobody has scrolled still reports the default 24 rows,
which would cut the answer off at the first screenful. What was fed is digested on
GTK's own time, so reading it back in the same turn reads a terminal that has not
seen it yet.

Because it is a pty and not a pipe, colours, prompts, `less` and interactive input
work. A terminal wants CRLF: `Feed`ing `\n` alone leaves the cursor in the column
it was in.

**`LinkPattern` makes text in the output clickable.** Some of what a program prints
is a *place*: a file and a line in a compiler's complaint, a URL, a ticket number.
VTE can recognise a pattern in what it has drawn and say what was under the pointer,
which is all it takes -- so the runtime offers the pattern and the `Link(text)`
event, and what the text *means* is the application's business. One pattern per
terminal, replaced on assignment; a broken one is refused; `""` takes it off. The
pointer becomes a hand over a match, which is what says it can be clicked before
anyone clicks it.

Two things about how the click is read, both of which cost time:

- **It is reported on release, and only when press and release landed on the same
  match.** Otherwise dragging across a match to select it would activate it, and a
  terminal one cannot select text in is worse than one whose errors are not
  clickable.
- **It is a raw event controller in the capture phase, not a `GtkGestureClick`.**
  VTE has a gesture of its own for selecting text and it *claims* the press --
  and claiming a sequence cancels every other gesture on it, so the click gesture
  saw the press and then never saw the release, in either phase. A legacy
  controller has no sequence to lose. It returns `FALSE` always: it only reads what
  is under the pointer, so selecting, scrolling and VTE's own menu go on working.

A button event's position is in the surface's coordinates and what VTE checks a
match at are the terminal's, so the point is translated through
`gtk_widget_compute_point`.

#### A build without VTE

`BTA_HAVE_VTE`, and the bargain is sqlite's, libsoup's and GStreamer's: CMake
looks for `vte-2.91-gtk4`, says what it found either way, and the runtime builds
without it. What makes this one different from those three is *why* it is
optional — VTE is the only dependency with no Windows port, and it stopped being
required the day the IDE's own output pane stopped being a terminal.

What a build without it has is the whole class minus the child:

| | |
|---|---|
| the class | registered, constructs, is in `Widget.Types()` |
| the GTK shape | the same `GtkScrolledWindow`, with a `GtkTextView` inside it instead of a `vte-terminal` — so the designer places one, the serialiser saves it, and `CssNode()` still answers `scrolledwindow` |
| `Feed`, `Text`, `Clear` | work, on the buffer. `\r` is dropped rather than drawn as a box: a carriage return is a terminal's and means nothing to a text buffer |
| `LinkPattern`, `ScrollbackLines`, `FontScale` | kept and read back. They are **state a `.form` declares**, and a getter or setter that refused would make a build with no VTE one that cannot *open* a form with a Terminal in it |
| `Run`, `Stop`, `Kill` | refuse, naming the package |
| `Link`, `Exit` | never fire: there is no child and nothing highlighting anything |

The split of *state answers, verbs refuse* is not a nicety and is the same one
`Video` makes without GStreamer. The designer reads every property of a selected
control and the serialiser reads them all again to save, so one getter that threw
would take a form with a `Terminal` in it out of reach of a runtime that can still
draw it perfectly well. **Optional at build time was never meant to cost loading a
form.**

`Available` is how a program asks, and
[`Widget.Available("Terminal")`](llm/controls.md#what-there-is-and-what-this-build-can-run)
is the same question about the class, for a caller that has a name and no control
— which is what the IDE's palette has when it decides whether to draw a button.
The palette filters on it, and the IDE's terminal tab is built only where the
answer is yes.

### Video

A `GtkPicture` whose paintable is GStreamer's, not a file's: one playbin3 per
control, with the `gtk4paintablesink` as its video sink. `GtkVideo` was refused
for this -- `GtkMediaFile` takes a `GFile` and nothing else, so a camera asking
for digest auth has nothing to say to it. Sound with no window is `AudioPlayer`,
the same pipeline with the video branch switched off.

`Uri` takes a URI or a plain path (`file://`, `http(s)://`, `rtsp://`); one
property for both, so there is nothing to disagree. `User`/`Password` ride the
playbin's `source-setup` into whatever source it built -- an `rtspsrc` answers
with its digest challenge, anything without an identity ignores them. A secret
in the URI works too and loses: it puts the password in every log that prints
the property. `Password` reads back `""` and is never serialised, for the same
reason. `Latency` is the `rtspsrc` jitterbuffer in ms (`2000`, the source's
own); lower it for a live camera, not for a file.

`Play` with no `Uri` is refused, and so is a `Seek` with nowhere to go. `Duration`
is `-1` while unknown -- which is always on a live stream -- and `Seekable`
answers once the stream is known rather than with the first frame;
`SourceWidth`/`SourceHeight` answer later again, with the first decoded frame,
because that is when the paintable has anything to measure. `Save(path)`
writes that frame out as a PNG. `Ended` leaves the last frame up (`Pause`, not
a black `Stop`); `Error` parks instead and carries a sentence and a `kind`
(`NotFound`, `NotAuthorized`, `Unreachable`, `Decode`, `Error`) so a form can
tell a password to ask for from a camera to retry. Setting `Uri` stops whatever
was playing; `Loop` reseeks instead of ending, which a live stream refuses by
ending anyway.

`Playing` is what `Play` asked for -- cleared by `Pause`, `Stop`, the end and
an error -- and not a sample of the pipeline's state. Sampling was wrong twice
over: a flushing seek (which is what `Loop` is) and a network stream refilling
its buffer both read back as not-PLAYING, and the console loop asks this to
know whether anything is still owed an answer, so a looping cue ended the
program at a loop boundary at random. Buffering is handled rather than
watched: a stream that runs its queue dry is held at PAUSED until it refills,
which playbin leaves to whoever owns the pipeline, and a live source is left
alone because `NO_PREROLL` said it has nothing to catch up on. `Buffering`
(`0`…`100`) is that state made visible, polled beside `Position` rather than
announced -- it changes per cent, several times a second. Measured against a
local server throttled to just above the clip's bitrate: it read 5, 38, 80,
then 100, and playback started at 100 and ran to the end, with `Playing` true
throughout because that is what `Play` asked for.

Five things learnt plumbing it, each measured rather than argued:

- **The sink is owned, not borrowed.** The playbin takes the video sink into one
  of its own bins, sinking the floating reference the factory gave -- the
  `gst_bin_add` ownership. An `unref` after the set destroys the sink while the
  playbin still points at it, and its finalizer then touches freed memory (two
  `GStreamer-CRITICAL`s at teardown, found with a three-variant probe). The
  tutorial pattern of set-then-unref is the bug here.
- **Teardown waits for NULL, capped.** The state change is async, and unref-ing
  with it still in flight finalises the playbin under its own feet. The wait is
  two seconds so a wedged network source cannot hold teardown hostage.
- **A password in `user:pw@host` form reaches `rtspsrc` too**, but it stays in
  the URI every log prints. `User`/`Password` exist so it does not have to.
  They are read on GStreamer's thread (`source-setup` runs wherever the source
  was built, and again on a redirect), so the two strings are behind a mutex:
  a setter freeing the old one is otherwise a free under a reader.
- **`gst_init` costs 6 ms warm and 573 ms cold**, so it happens on first use
  and not at startup. Every program in the tree was paying it, the IDE
  included, for a feature most of them never touch.
- **A build without the engine must still draw a form.** The designer reads
  every value of the selected control and the serialiser reads them all again
  to save, so a getter that threw for want of GStreamer meant a runtime that
  could not lay out -- or even load -- a form with a `Video` in it. What
  refuses without the engine is the verbs.

GStreamer is optional at build time, like `Http`'s libsoup and `Database`'s
sqlite: without it the control still places (a `GtkPicture` with nothing in it),
every property still answers and is still serialised, and the verbs refuse:
`Play` and `Seek` name the package, `Save` says what it always says when
nothing has been decoded, and `Pause`/`Stop` have nothing to stop. The frames need one plugin beyond the base
ones -- the GTK4 sink from gst-plugins-rs -- and where it is missing `Play`
says which element it is, while `AudioPlayer` plays on.

**`Available` is the one member that is asked of the machine** rather than
declared at build time, because the sink is the case a build-time flag cannot
see: a runtime linked against GStreamer on a machine whose registry lacks
gst-plugins-rs can place a `Video` and never play one. `Widget.Available("Video")`
and `Video.Available` answer *no* there, which is what the palette asks before
offering the control -- it asks once, and the answer is cached, since the
question is a registry read (6 ms warm, 573 ms cold). `Terminal`'s `Available`
is the other kind, a constant of the build; `bta_class_runnable` is where a
class says which of the two it is.

## Containers

### Which of the two models a form should use

Everything above describes both ways of laying a form out and does not say when
to reach for which, which is a gap this section is here to close. It was closed
by measurement: [`examples/clients`](../examples/clients) was drawn twice.

**Drawn in coordinates** it is 27 controls and **117 numbers, 54 of them an X or
a Y** — and it broke on a resize. On a drawing surface `HAlign`/`VAlign` are what
a control does with the slack, and the default is *stay where you were drawn*, so
two tables given `Fill` grew straight over the twenty-five controls that had been
given nothing. The failure is invisible at the size the form was drawn at.

**Written as boxes** the same window is **17 numbers and not one coordinate**: a
column of a filter row, a split and a status line, with the split's right half a
column of a grid of labelled fields, the orders, their fields and the buttons.
Nothing anchors because nothing is positioned; the divider between the list and
the detail comes free; and `Tab` follows the child order instead of needing one.

So the line is not about taste and not about how many controls there are:

| | |
|---|---|
| **One dense grid of labelled fields** — a dialog, a properties panel, a login box | a `Fixed`, or a [`Grid`](#grid) when a caption may grow in translation. Dragging is the right way to build it and anchoring is a handful of decisions |
| **A window with regions** — a list beside a detail, a toolbar over a body, anything with a status line | boxes for the skeleton, with a `Fixed` or a `Grid` *inside* each region |

That is what every RAD toolkit converged on — Delphi's `TPanel` + `Align`,
WinForms' docking with anchoring inside it — and both halves are here already:
`Arrangement` on a container, coordinates inside it, and the designer swaps the
slot when it changes.

**And the one that bit after it was written**, in the IDE's own *Changes*
window: a `Split` whose two halves were bare `Panel`s, inside a `Fixed` root.
`VExpand` on a control is a claim on the room **its parent has**, and a parent
that claims none has none to give — so the two `SourceEditor`s asking to expand
got the natural height of the tab strip above them, and a diff drawn in a
620-pixel window was **46 pixels tall**. It is worth saying plainly because the
`.form` looked right: every leaf said `VExpand: true`, and the one container in
the middle said nothing. Expansion is a chain, and it breaks at the quietest
link.

**Two things that bit while measuring it.** `MinWidth` *"only means something on
an axis whose `HAlign` is `Fill`"* — the split's halves had a `MinWidth` and no
`HAlign`, so squeezing the window dragged the divider down to 46 pixels instead
of stopping at 280. And a `Button`'s natural width is its label and nothing else,
so a row of them wants a declared `Width` even in a box; that is a size and not a
position, which is the distinction that matters.

### Split

**Neither half may be squeezed below what it needs**, which is not GTK's default
and is the same promise every other container here makes: a `Fixed` keeps a floor
under each child, a box refuses to go under the sum of its children.

Left as GTK has it a paned reports a minimum of nothing, so a window holding one
can be made smaller than its own contents — and what happens then is not clipping
but **overlap**: the halves keep the size they need and are drawn over each other
and over whatever is beside them. The catalogue editor asked for 760x200 and came
out with its buttons across its own list.

`Position` says where the divider is; **`Grows` says who takes the room when
the window grows** — `Both` (the default), `Start`, `End` or `Neither`. Without
it a split could only be *drawn*: the layout every application wants, a sidebar
that stays the width it was while the work beside it takes the window, had to be
got by luck or by moving the divider from code on every resize. One enum rather
than GTK's two booleans, because the four combinations have names one already
thinks in, and `Neither` pins the divider where it was put.

`WideHandle` asks the theme for a grip instead of a hairline, which on a
touchpad is the difference between resizing and clicking.

The divider can still be dragged the whole way; what it cannot do is take room
that is not there. The cost is that a window's minimum becomes real rather than
fictional — the IDE's went from 720 wide (and broken at that size) to 1100, which
is what its declared panel widths actually add up to.

### Grid

Rows and columns whose sizes come from what is in them — the one thing a form
drawn in coordinates cannot do, and the answer to a caption that grew in
translation pushing a dialog out of shape.

**Children flow into it in order**, left to right, wrapping at `Columns`. There is
no per-child row and column to fill in: a grid's order *is* its layout, which is
what makes it the same thing to add to as a box — `Add`, `Reorder` and dragging
one in the designer all mean what they already meant. `ColumnSpan` on the child is
the one exception, for the note that runs the width of the form and the row of
buttons that sits under both columns.

`RowSpacing` and `ColumnSpacing` are the room between the cells, and a grid had
neither until a form was laid out on one and every control touched its
neighbour. Two names because a grid has two axes -- a `Panel` says `Spacing`
because a box has one. `Homogeneous` makes every column as wide as the widest
and every row as tall as the tallest, which is what a form of labelled fields
wants and what a keypad needs; it is one property rather than GTK's two, because
a grid that is even one way and ragged the other is a shape nobody has asked
for.

**And there is no new vocabulary for sizing.** A column is as wide as its widest
child needs; a child that says `HExpand` makes its column take the slack;
`HAlign` says what it does inside its cell. Those are the words a box already
uses and they mean the same here, so a grid is a thing to reach for rather than a
thing to learn:

```json
{ "type": "Grid", "name": "Fields",
  "properties": { "Columns": 2, "Spacing": 8 },
  "children": [
    { "type": "Label",   "name": "LblName", "properties": { "Text": "Name:", "HAlign": "End" } },
    { "type": "TextBox", "name": "TxtName", "properties": { "HExpand": true, "HAlign": "Fill" } },
    { "type": "Label",   "name": "LblHint", "properties": { "ColumnSpan": 2 } }
  ] }
```

The IDE's own *New project* dialog is exactly that, and it is what the shape buys:
the label column comes out 92px wide in English and 103 in Spanish, the fields
move over to match, and nothing else in the file changes.

`Spacing` and `Homogeneous` are the container's own and apply to both axes — a
homogeneous grid is a chessboard, and one axis of it is a thing nobody has asked
for by that name.

**And a `Fixed` is the wrong container for a shape that is merely rectangular.**
It latches its design size from its first allocation, so one that is first shown
at a size other than the one it was drawn at anchors from the wrong origin — a
hidden `Switcher` page is exactly that, and enlarging the IDE on its welcome page
before opening a project left the whole workspace laid out at the old size. Three
panels of the IDE were `Fixed` when each was a *column*: a label over a tree, a
toolbar over a split, every child `Fill` at the full width, and coordinates that
never meant anything. A box has no design size to get wrong.

**A grid on a `Fixed` surface still cannot negotiate**, which is worth knowing
before reaching for one: its neighbours are placed by coordinate and have no say,
so a grid whose contents outgrow its declared width overflows them exactly as a
row of buttons would. What makes columns give way to each other is the *parent*
being elastic. Converting the IDE's menu editor is the case: putting its six
buttons in a grid changed nothing until the dialog itself stopped being a surface.

`Anchored` is on by default and says whether this container's children follow it
when it is resized. Off is for a **drawing board** rather than a window: one
stretched to room that is nobody's design size, whose children must still be
shown at the size and place they were drawn. The designer's canvas is the case —
without it, a control declaring 380 was shown at whatever the canvas happened to
be. Meaningless on a container that is not `Fixed`, and ignored there rather than
refused.

### The order Tab takes them in

`TabIndex` on each control, read by the surface it sits on. Ties go to the order
the children are in and the default is 0, so a form that declares nothing is
walked in the order it was drawn — every form written before this existed.

**Why it is a declaration and not the child order.** GTK4 walks the focus in
child-list order and removed `GtkContainer`'s focus chain, so on a surface the
order controls were added in *is* the order Tab takes them in. That list is
already spoken for: children paint in it, which is exactly what `Raise` and
`Lower` say. One list cannot carry both orders, and VB, Delphi and Gambas all
reached the same conclusion — ZOrder and TabIndex are separate properties in all
three.

**What carries it out is `bta_fixed_focus`**, the surface's own `focus` vfunc.
That is the supported place for a GTK4 widget to say what its focus order is, the
same standing `measure` and `size_allocate` have, and choosing it over catching
the key is what keeps everything else working: a focused editor or
`Terminal` takes Tab for itself — indentation, shell completion — long before GTK
asks a container for the next target, so neither needs a special case. Only the
two Tab directions are ours; the arrows are GTK's *spatial* navigation and
`TabIndex` says nothing about where a control sits.

**Sparse, and never renumbered.** VB and Delphi keep a dense sequence by
shuffling every sibling whenever one is set. That is the fiddly half of using
them, and here it would be worse than fiddly: a control's siblings are its
*form's*, and on the designer's canvas that form is `MainForm`, so a renumbering
setter would be rewriting the IDE's own declarations. Sparse costs nothing —
`g_array_sort` on a handful of children when Tab is pressed.

**`Focusable` is the `TabStop`**, and no second word was added. A control Tab
must skip is a control that cannot take the focus. That property had to be fixed
to mean it: it set the flag on the widget the parent lays out, and a `TextBox`'s
focus sits on the `GtkText` *inside* its entry — so `gtk_widget_child_focus`
walked past the unfocusable outside straight into the focusable inside, and
`Focusable = false` on the commonest control in the set read back correctly and
did nothing. It now reaches `inner` and an editable's delegate, which is the same
*contains* rather than *is* that `Focused` has always reported.

`Container.FocusNext()` / `FocusPrevious()` are what Tab does, from code,
answering whether the focus moved. They go through `gtk_widget_child_focus`, so
what decides is the surface's order and not the caller — and being on `Container`
rather than on `Form` is what lets the walk be confined to the panel holding the
fields. A form is a container, so a dialog's `this.FocusNext()` still means the
whole window.

### What an anchor is measured from

The gap a control keeps is the one it was **drawn** with, so a surface has to
know the size the coordinates were written against. For a **form** that is what
it declared: `Width: 380` in a `.form` is the number every coordinate in that
file was measured from. Anything else takes its first real allocation, because it
has no declaration worth trusting — a `Width` inside a box is a *minimum*, not a
size, and the designer's canvas is sized by the IDE.

**The file's number and not the window's current one**, which are two different
things the moment an application restores a remembered size: `Resize` writes what
`Width` reads, so a form told to open at 680 has stopped reporting the 760 its
coordinates were drawn against before it is ever laid out. The declaration is
recorded when the `.form` finishes loading, before any code can have run, and
that is what the anchors measure from. Reading the current size instead put a
strip drawn at `12..748` in a 680-wide window: a trailing gap of **minus 68**,
which `Fill` then kept faithfully at every size, so the strip was 68 pixels wider
than its own window whether that window was 680 or maximised to 1920. A form
built from **code** has no file, so there the size set before it was shown *is*
the declaration and is what gets latched.

A trailing gap is a gap, so it is never negative: a control drawn past the edge
of its own surface is owed nothing on the far side of it.

That distinction is not academic: **a control's text can make a form open wider
than it was drawn.** `Fixed` asks each child for its minimum and reports the
bounding box of those, so a caption that outgrew its declared width pushes the
surface out rather than clipping — right, and what translation does to every
dialog. Latching *that* as the design size made the slack invisible: every anchor
went inert, an input declared to stretch never stretched, and the buttons never
reached the corner. Measuring from the declaration instead, a pushed form lays
out exactly as it was drawn, only wider.

A stretched control was drawn with a gap on its **far** side too, and `Fill` is
the promise to keep both — so the room it needs is its own minimum *plus* that
gap. Without it, the control that pushed the surface pushes by exactly its own
growth and ends up flush against the edge while everything beside it keeps the
margin: a prompt touching the frame over an input that stops short. Only for
`Fill`, because nothing is promised about the far edge of a control anchored
`Start`, and adding its trailing gap would grow the surface by the whole width of
the margin it was drawn inside.

Measuring needs the design size to know that gap, and the first pass has none, so
latching one asks for a second measure. **A pushed form is therefore laid out
twice**, which is worth knowing when testing one: `Width > 1` is true a frame
before the answer is.

The floor is honoured **after** the anchor and **away from the edge the control
is anchored to**. Both halves matter, and only for a control that outgrew its
declared width: applying the anchor to the already-grown size would count that
growth twice and put an `End` control past the edge it is anchored to, and
growing it rightwards would do the same. So a button drawn 120 wide whose
translated caption needs 167 sits 47px further left and keeps its gap.

All of them: `Add(widget)`, `Children`, `Anchored`, `Reorder(child, index)`, plus
three questions for the layout:

- `PickAt(x, y)` — the topmost child at that point, or null.
- `ContainerAt(x, y, ignore?)` — the innermost container that could accept a drop
  there. `ignore` matters while dragging: the dragged widget sits under the pointer
  for the whole gesture, so without excluding it the answer would always be "its own
  parent". GTK has no ignore-list for picking, so it is made untargetable for the
  duration of the call.
- `LocalPoint(x, y, from)` — a point in another widget's space converted to this
  container's. Re-parenting needs it: `X`/`Y` are relative, so keeping them would
  teleport the control.

All three read GTK's allocation, so they answer nonsense before the first frame.

**`Clear()` is not in that list because it is worth a paragraph of its own.**
`bta_container_detach` has a branch per kind of slot — a `BtaFixed`, a `GtkBox`, a
notebook page, a `GtkStack`, a `GtkGrid`, a `GtkPaned`, a `GtkOverlay` — and each
one takes the child out the way that kind of container *holds* it, which is the
mirror image of the attach above. That symmetry is the whole of the design, and it
is what three defects had in common when an application went looking:

- **A `GtkGrid` had no branch at all**, so `Grid.Clear()`, a grid child's
  `Delete()` and `Remove()` all fell through to `cannot remove from this
  container`. A grid could be filled once and never rebuilt — and a month view, a
  schedule and a timetable are exactly the shapes that rebuild one. It is
  `gtk_grid_remove` now, and `bta_grid_reflow` re-places whoever stayed, so a hole
  closes up instead of persisting.
- **`bta_container_clear`'s walk reached GTK's own internal children.** It took
  `gtk_widget_get_first_child` until the slot was empty and unparented anything
  that was not ours — which on a `GtkPaned` is the drag handle. Three
  `Gtk-CRITICAL gtk_widget_unparent: assertion 'GTK_IS_WIDGET (widget)' failed`
  per call for a split, one for an overlay, and success reported either way. It
  collects what is ours first and then detaches it: a container empties of its
  children and keeps its own machinery. Two passes, because detaching moves the
  sibling list underneath a walk, and a `while (first_child)` loop only terminates
  while *every* child is going.
- **And a `Split` and an `Overlay` were unparented rather than cleared through the
  property that held them.** GTK keeps a pointer per paned half and one for an
  overlay's base layer; unparenting leaves it set, so the container went on
  believing it was full. A cleared split whose `Children` read empty refused the
  next `Add` with *holds exactly two children*, and a cleared overlay tripped
  `gtk_overlay_add_overlay: assertion 'widget != overlay->child'`. Latent for as
  long as nothing refilled one — which is why fixing the walk above is what found
  it.

What ties all three together is the **round trip**: fill, empty, fill again.
Nothing had ever asked a container to do that, so `tests/widgets`' `Removal` does
it to every one of them.

**`Arrangement` is not in that list either, and that omission *is* the point.****`Arrangement` is not in that list either, and that omission *is* the point.** It is the
word for a container whose slot is a `BtaFixed` — `Panel`, `Frame`, `Expander`,
`Scroller`, `Form`, `Component` — because those are the ones with a choice to
make. A `Split` overrides it with `Horizontal`/`Vertical` and no `Fixed`: two
halves have an axis and nowhere to put a coordinate. Every other container's
arrangement *is* its nature, and `cont_set_arrangement` says so rather than
accepting a value that could not mean anything:

```js
Widget.New("Grid").Arrangement = "Vertical";
/* TypeError: Grid arranges its children by its own nature */
```

`Grid` is a table, `Flow` wraps, `RowList` is rows, `Notebook` and `Switcher` are
pages behind a strip, an `Overlay` is a stack, an `AspectFrame` is one rectangle. They read `""` — not `"Fixed"`,
which would be a claim about coordinates that do not apply — and the serialiser
skips them under its rule about values equal to a fresh control's, so no `.form`
carries an `Arrangement` its container would refuse.

**`Placement` is the question they *do* all answer**, and it exists because an
editor has to ask it: `Coordinates`, `Order`, `Layers`, `Pages`, `Halves`,
`Single`. Six words and not a boolean, because there are six kinds of gesture — a
coordinate to move, a place in a line, a layer to stack, a page at a time, one of
two halves, and one child with one place (an `AspectFrame`, where a drop simply
lands). Read-only: it is a fact about the class and its arrangement, not a
property of the file.

It was a table of class names in `Designer.js` until this existed, and that table
is how `Overlay`, `Flow` and `RowList` came to be on the palette with every
gesture treating them as rows — dropping a control into one added it and *then*
asked for an order the runtime refused, so the drag read as failed and left a
child behind that nothing had selected. The runtime is the only thing that knows
what its slot is; the same trade `Widget.Available` made for the palette.

### Frame

A `GtkFrame` holding a `BtaFixed`: a `Panel` with a title (`Text`), and arranged
the same way. Both default to `Fixed`, so they are the containers a drawn form
uses.

A `Frame`'s border and label shift its content by whatever the theme decides, which
is why the designer asks the layout where a child ended up instead of adding
coordinates up.

### Panel and the boxes

There is no separate box class. A `Panel` **is** the box: `Arrangement` says
whether it lays its children out on coordinates (`Fixed`, the default) or as a
row or a column (`Horizontal`, `Vertical`), and `Spacing`/`Homogeneous` belong to
the box it is arranged as — they read `0` and `false` when it is not one, the
same bargain `Expand` makes inside a `Fixed`.

Three spellings of one idea collapsed into this. GTK had already dropped
`GtkHBox`/`GtkVBox` for one class with an orientation; we had a type per axis
*and* a `Panel` whose `Arrangement` did the same job with different words. What
the extra classes bought was nothing a value could not say, and what they cost
was that turning a row into a column meant deleting it and building the other
one, children and all.

**And it is one widget, which is what makes that sentence true rather than a
figure of speech.** `Arrangement` swaps the *layout manager* — `BtaFixedLayout`
or a `GtkBoxLayout` — and the widget the parent lays out stays exactly where it
was, with its CSS node, its handlers and its place among its siblings. The
children never move: they are children of the same widget, and the new manager
lays out the list it finds.

It was two boxes until it was not: an outer one that stayed put and an inner slot
that the swap replaced, because something had to survive being replaced. Two
things came of removing it. `cont_set_arrangement` lost the thirty-one lines that
did the moving — every child taken off, the old slot removed from whichever of
four kinds of holder it sat in, the new one put in, every child re-parented in
order — and **a theme class now lands where the children are.** That second one was a real bug and an invisible
one: Adwaita's rule is `.linked:not(.vertical) > button`, a *direct* child, so a
class on the outer box missed it entirely and `Style = "linked"` on a row of
buttons rendered identical, pixel for pixel, to no class at all. The same went for
every `> child` rule a theme has. `examples/files` uses the class now with no
stylesheet of its own.

One thing the holder had been hiding, too: a surface's `measure` counts the far
margin a `Fill` child was drawn with, so that a caption whose translation outgrew
its declared width does not end up flush against the edge. That belongs to a
*window*, which opens at the size it declared and has nothing above it to make
room. On a `Panel` it made the surface refuse to be squeezed past its design
size — and while the surface sat inside a holder, the holder was squeezed instead
and nobody could tell. It is a form's own surface that adds the term now, which is
the same limit the design size is latched under.

**Re-arranging keeps the children**, in order, and it has to: refusing once a
container held something — which is what it used to do — left the property
useless for the one thing anybody wants it for. The swap re-parents them from
the old slot to the new one; nothing changes hands, since the JS wrapper still
owns each child. Their `X`/`Y` stay on the `BtaWidget` untouched, so going
`Fixed` → `Horizontal` → `Fixed` puts every control back exactly where it was.

Order is position in a box: a child has no `X`/`Y` that means anything, and
`Reorder(child, index)` is what moves it. The index counts the siblings *without*
the child being moved, so carrying one forward has to account for the hole it
leaves behind. **Every container that has an order answers it** — a box, a
`Grid`, a `Flow`, a `RowList`, a `Notebook`, a `Switcher`, a `Split` whose index
names the half, and an `Overlay` whose index `0` is the layer that fills — and a
`Fixed` is the only one that refuses: there the order is the painting order, and
`Raise`/`Lower` already say that. One function answers all of them
(`bta_container_reorder`, beside the attach and detach it mirrors), because
`Raise`/`Lower` and the designer's drag ask the same question and an index has to
mean the same thing to all three.

Children do not expand unless asked: `Expand`, `HExpand`, `VExpand` are what
decides who absorbs the slack. A container does not expand unless asked either,
and that takes saying so: GTK propagates a child's expand upwards, so left alone
every `Panel` would be greedy inside an elastic parent — a row of buttons taking
half the window. `build_panel` sets its expand explicitly false to stop it, and
false-and-said is not the same as unset: an explicit value is what ends the
propagation, and `Expand` from the `.form` overrides it like any other property.

This is where a whole class of layout bug lives — a `Notebook` whose page is
empty still absorbs height if it expands, which is what left a blank band between
the IDE's tab strip and its designer until `VExpand` was turned off in design
mode.

### Flow

A gallery: children laid side by side, wrapping into as many columns as fit. A
box makes one line and a grid makes a table; neither reflows, and a wall of
equally sized things — icons to pick from, images, templates — wants to answer
the width it is given.

`Spacing` is the gap, the same word every container uses, kept square because
nobody wants the two directions apart. `MinPerLine`/`MaxPerLine` hold a line to
a shape when the room would allow more; left alone the width decides, which is
what reflowing means. GtkFlowBox caps a line at seven by default, which for a
gallery is not "as many as fit" but "seven", so the class raises it.

**It scrolls itself**, the way a `RowList` does: a wall of things is long by
nature, and a gallery that had to be put inside something to be scrolled would
be one nobody could use without knowing that. A `GtkFlowBox` is scrollable in its
own right, so the scroller takes it with no viewport in between. Never sideways —
reflowing to the width is the point.

Each child is wrapped in a cell of its own, so a child's GTK parent is that cell
and not the slot; `bta_slot_child()` and `bta_container_detach()` look through
it, exactly as they do for a `RowList`'s rows.

Selection is off: this is a layout, and the things in it answer for themselves.
It can become a list that selects when something needs one.

`RowSpacing`, `ColumnSpacing` and `Homogeneous` are the grid's, for the same
reason: a gallery whose items touch reads as one block of pictures rather than
as several.

### Expander

A `GtkExpander` over a `BtaFixed`: a caption one presses, and everything under
it appears or goes away. `Text` is the caption, `Expanded` says whether it is
open, and `Toggle` fires when it changes.

What it is for is the half of a dialog nobody needs until they do — the advanced
options, the details of an error. And the reason it is a container rather than a
`Panel` with `Visible` toggled from code is that the **window** has to know:
folding it takes its height back, which hiding a panel inside a fixed surface
does not.

**`Expanded` and not `Expand`**, which is the layout boolean every widget
already has. A property of that name here would shadow it, and the two would be
told apart by nothing but which class you happened to be looking at — the tree
made the same choice and calls its method `ExpandNode`.

### Scroller

A `GtkScrolledWindow` around an ordinary fixed slot, so `X`/`Y` mean here what
they mean everywhere. It is the container for content whose size is not its
parent's business: the **view** is as big as the room it is given, the **board**
inside it is as big as what is on it, and the difference scrolls.

Every other container answers "there is not enough room" by making its parent
bigger, and a `GtkPaned` that cannot give a child its minimum hands it the space
anyway — which is how the IDE's design canvas used to spill out of its half of
the split and over the panel beside it. This is what a form drawn 1100 wide is
edited in when the canvas showing it is 520.

`Scrollbars` says which way it may scroll: `Both`, `Horizontal`, `Vertical`,
`None`. One property and not GTK's two policies, because what one wants to say is
"this is a list, it grows downwards" — and `Vertical` says that, while
`hscrollbar-policy = never, vscrollbar-policy = automatic` says it twice in the
language of the toolkit. It is the word `ScrollBars` has meant since VB.

**An axis that may not scroll is not a hidden scrollbar.** GTK stops offering the
child a viewport it can be bigger than, so the view has to be as wide as the child
asked for — and the window with it: measured, a 400-wide view of an 800-wide board
becomes 800 the moment sideways scrolling is turned off. That is what makes a list
of long lines wrap or ellipsize instead of running off the side.

### Split

A `GtkPaned` with exactly two children; a third is an error. `Position` is the
divider in pixels, and `Arrangement` which way it is split — the same word every
container answers, though a `Split` declares only the two values it can be: two
halves and a divider is what it *is*, so there is no `Fixed` on offer. Its class
row shadows `Container`'s accessor to say so.

`Reorder(child, 0)` puts a child in the start half and `1` in the end half,
swapping whatever was there -- with two children that is the only thing ordering
can mean.

### Notebook

A `GtkNotebook` whose slot is itself. Pages come from `Append(child, label?)`,
which returns the index, and each page's tab is a **widget** — so a tab label that
has to change is a `Label` you keep and mutate. `SetTabLabel(i, label)` sets it
after the fact. `Current` is the page, `Count` the total, `Switch(index)` fires on
change (including while the `.form` loads, before `Form_Open` has initialised
anything, which is a guard every handler needs).

Scrolling is on, so a project with more tabs than fit still works, and that is also
what gives Ctrl+Tab a way to move between them.

`Strip` is where the tabs are — `Top`, `Bottom`, `Start`, `End`, or `None` at all.
**The same word a `Switcher` uses**, and the same five values: it is the same
question about the same thing, and answering to `Strip` on one and `TabPosition`
on the other would be one concept with two names and a coin flip every time
somebody writes it. `Start`/`End` rather than left/right because which side that
is depends on the language the program is read in. `None` is the notebook somebody
else turns the page of — a wizard's Next button, a menu of views — and it is
`show-tabs` off rather than a strip hidden behind the pages, so the pages get the
room back; the side it had is remembered, so turning the tabs back on puts them
where they were.

`SetTabLabel` takes a widget, which is what the IDE needs to colour its own tabs --
but a widget is not something a `.form` can carry, so `Tabs` is the same strip as
an array of plain strings: an ordinary property that round-trips through the file
and that the designer's grid edits like any other list. Reading answers what the
labels say, whatever they are made of; writing replaces them with plain labels.

The list is also *remembered*: the loader applies properties before it builds
children, so a notebook is told its tab names while it still has no pages, and
each page takes its name as it arrives. Without that the names would be assigned
to nothing and lost on every load.

`Reorder(page, index)` moves a page, and the tab goes with it.

`SetAction(control, "Start" | "End")` puts a control in the **tab strip**, in the
room at either end that GTK reserves for one (`gtk_notebook_set_action_widget`) —
a "new tab" button, a menu for the whole set. What makes it worth a method of its
own is that it is emphatically **not a page**: `Count` and `Children` go on
counting pages, which is what they mean.

It is *adopted* like a page, though, and has to be: the JS wrapper owns the
`BtaWidget`, so a control only GTK holds is collected while GTK still shows it
and the next motion over it reads freed memory. Passing `null` takes it out.
Two ordering rules follow from the adoption — set the control's `Name` **before**,
since that is what its events are looked up by, and its `Menu` **after**, since
the items are named on the form the adoption binds it to.

### Switcher

A `GtkStackSwitcher` over a `GtkStack`, in a box: the **stack** is the slot, so a
child put in by the loader, by `Add()` or by the designer is a page like any
other, and the strip follows along because GTK builds it from the stack rather
than from anything the class says.

The same shape as a `Notebook` and a different bargain. A notebook's strip grows
with its pages and scrolls when they stop fitting, which is what a set that
changes while the program runs needs — one tab per open file. A switcher's is one
segmented control, every button the same size, and it says *these are the two or
three views of this panel* the way a row of tabs never quite does. That set is
part of the design: named once in the `.form`, and not added to afterwards.

`Tabs` is the whole of the strip, as an array of plain strings — a page's name
here is a **string** on its `GtkStackPage` and not a widget, so there is nothing
else it could be, and nothing else to keep in step. It is *remembered* the way a
notebook's is: the loader applies properties before it builds children, so a
switcher is told its names while it still has no pages and each page takes its
name as it arrives. A page nobody named gets `Page N` rather than nothing — a
button with nothing written on it is not something anybody can aim at, which a
notebook's thin blank tab at least still is.

`Current` is the page on screen, `Count` the total, `Switch(index)` fires on
change (during the `.form` load too, like a notebook's). `Append(child, name?)`
is `Add()` with the name in the same call. Setting `Current` past the end leaves
the strip alone rather than blanking it: a switcher is routinely told which page
to show before its pages exist.

`Strip` is where the buttons go — `Top` (the default), `Bottom`, `Start`, `End` —
or **`None`**, and that last one is why it is a property and not a second class.
The stack is the half that does the work: one child on screen at a time, sized so
that swapping does not resize anything around it. That is worth having on its own
— a welcome screen swapped for the workspace behind it, a "no results" page, a
wizard — and it should not cost a class with the same `Tabs`, the same `Current`
and the same everything. With `None` the pages are changed by code alone; the
names are still there, and putting the strip back is one assignment.

Nothing about it is remembered: the answer is read back off the widgets — which
way the box runs, which child comes first, whether the strip is shown — so it
cannot drift from what is on screen. Being an enumerated property, the designer's
grid offers the five and not a text field.

Inside, the stack expands and the holder does not — the same bargain a `Panel`
makes with its slot, and it is two different questions that look like one. *How
the switcher divides the room it has* is settled by the stack expanding: the
strip is worth its own height and the pages are worth all the rest. *Whether the
switcher claims room from the container around it* stays its parent's business,
so the holder's expand is explicitly off, or GTK's upward propagation would make
every switcher greedy in an elastic parent. Answering only the second left a page
at its natural size inside a switcher that had been given the whole window — 44
pixels of button in a 560 pixel window, with a band of nothing under it.

`Arrangement` is refused, as it is on a `RowList`: swapping the slot out would
leave the strip pointing at a stack that is no longer there.

`Reorder(page, index)` works, and is the one thing here GTK does not offer — a
stack has no reorder at all — so the runtime takes every page out and puts them
back, carrying the titles across by hand. Each is referenced first, because
removing one drops the last reference GTK holds; and the `Switch` handler is
blocked for the duration, or a rebuild that ends where it started would report a
fistful of switches the user never made.

### Overlay

A `GtkOverlay`: the first child fills and the rest float on top of it. It is what
makes the designer possible — a transparent `Panel` over the surface, taking the
mouse so that clicking a `Button` selects it instead of pressing it.

**Not at their own coordinates**, which this page said for a while and which sent
somebody looking for a coordinate that is not there. A `GtkOverlay` places a
floating layer by `HAlign`/`VAlign`/`Margin` and by nothing else; `X`/`Y` are
stored on the widget, read by no layout, and dropped by the serialiser like any
other child of a container that is not a surface. So a hand-written `.form` with
`X: 16, Y: 16` on a layer loses those two numbers the first time it is saved —
now visible rather than silent, since the property grid greys those rows and says
why.

**The first child is a *property* of the overlay and the rest are a list**
(`gtk_overlay_set_child` against `gtk_overlay_add_overlay`), and everything about
the order follows from that. The base is the layer the stack hands its whole
allocation to; GTK keeps it as the first sibling, so `Children[0]` **is** the
base, and the layout tells it apart by comparing against
`gtk_overlay_get_child()` rather than by any position of its own. Three
consequences, each of which was a defect:

- **`Reorder(child, index)` works**, and index `0` means *be the base*. It swaps
  the two through `set_child`, both referenced across the swap — GTK refuses a
  widget that still has a parent, and `set_child` unparents whoever was base,
  which is the last reference it holds. Every other index is a place in the paint
  order, which is the ordinary sibling reorder every container shares.
- **`Raise`/`Lower` go through the same door.** `Raise()` on the base used to move
  it to last sibling while `overlay->child` still pointed at it: it went on
  filling and painted *over* its own floaters, and `Children[0]` stopped being the
  base. In a stack the bottom is the layer that fills, so `Lower()` means *become
  the base* — and `Raise` then `Lower` is a round trip.
- **The layer above takes over when the base leaves.** Detaching it used to leave
  an overlay holding floaters with nothing filling, and `Children[0]` no longer
  the base. Attach makes the first child one, so removal has to promote the next
  — the symmetry every branch of `bta_container_detach` is held to.

`Arrangement` is refused, as on a `RowList`, and `Placement` answers `Layers`.
That is the property an editor asks, and it is how the designer tells a stack
from a row without a table of class names — the table that let `Overlay`, `Flow`
and `RowList` onto its palette while every gesture treated them as boxes.

A message over the content rather than in front of it is
[`examples/notify`](../examples/notify): one overlay, three layers — the form's
content as the base, a spinner `Center`/`Center` while something is going, a
banner `Center`/`Start` with `Style: "osd"` — and all three declared in the
`.form`, where a designer can draw them.

### AspectFrame

A `GtkAspectFrame`: one child, given the biggest rectangle of a declared
proportion that fits, centred in what is left over.

**What it exists for is the rectangle and not the picture.** `Picture` and
`Video` letterbox inside themselves with `Fit: "Contain"` already — what neither
can do is say *where* the image ended up, so a caption meant for the corner of a
16:9 stream lands out on the black beside it. This makes that rectangle a
container: the picture goes in here, an `Overlay` goes over the picture, and
`HAlign`/`VAlign` then mean the image's own corners. The application that asked
for it was sizing the video widget from code instead — sixty lines of
measurement, a `Timer` and a settling loop, none of it about cameras.

**Four numbers, measured against GTK 4.22 rather than assumed**, because the
first two are what decide whether it is usable at all:

```
a child asking 200x100, Ratio "16:9"  ->  the frame's minimum is 200x113
a child asking nothing                ->  the frame's minimum is 0x0
Ratio 0, i.e. the child's own          ->  200x100, the child's exactly
in a 640x480 box                      ->  the child gets 640x360 at (0,60)
```

That `0x0` is the whole reason this is a container. Sizing the child from code
makes the size request a *minimum*, so the largest tile a full screen ever
needed becomes the window's floor — after a full screen the window could not be
made smaller again, which read as a zoom that would not undo. A frame asks for
what its child asks for, and the proportion is applied to the room it is given
rather than demanded from its parent.

`Ratio` is written the way people mean it: `"16:9"`, or `"16/9"`, or a number for
whoever has one. The text is **kept as it was given**, so the getter, the
property grid and the `.form` answer `"16:9"` and not `1.7778` — a reconstruction
from the float could not be exact anyway. `0` and `""` are GTK's `obey-child`
said once instead of as a second property, the same trade `Scrollbars` makes
with GTK's two policies, and it is the default: a frame that does not know the
proportion yet has no business imposing one, since a stream's shape arrives when
the server answers.

Two traps, both paid for once:

- **It is not a `GtkFrame`.** `GTK_IS_FRAME` does not catch it, so
  `bta_container_attach` and `bta_container_detach` need a branch each — and the
  detach goes through `gtk_aspect_frame_set_child(af, NULL)` rather than
  unparenting, or GTK keeps its pointer and the container goes on believing it
  is full. That is the fault a cleared `Split` and a cleared `Overlay` both had.
- **`printf("%g")` writes the locale's decimal separator.** `Ratio = 1.5` came
  back `"1,5"` on this machine, which is what the `.form` would then carry and
  what `JSON.parse` would read as nothing — the same fault the QuickJS number
  patch exists for, one layer up. `g_ascii_dtostr` on the way out and
  `g_ascii_strtod` on the way in.

`Arrangement` is refused, as on a `RowList`, and `Placement` answers `Single`:
one child and one place, so there is no coordinate to give it and no order to
put it in. A second `Add` is refused where it is asked for, because GTK would
drop the first one without a word.

### RowList

A `GtkListBox` in a scroller: one row per child, each row **a widget of its own**.
A `ListBox` holds strings; this holds controls, which is what a property editor, a
settings page or a list of results needs.

`Index` is the selected row or `-1`, `Count` the number of rows, `Select` fires on
selection. `Arrangement` is refused: the rows *are* its arrangement.

**`Reorder(child, index)` works, and it goes out through the list and back in.**
A `GtkListBox` and a `GtkFlowBox` keep their wrappers in a sequence of GTK's own,
which the sibling order does not move — indices, the keyboard walk, headers and
the filter all read that sequence — so a reorder is `remove` plus `insert` at the
position asked for, and three things have to be got right. The wrapper is
referenced across the two calls, because the list holds the only reference to it
and `remove` ends in `gtk_widget_unparent`: a row finalised between them takes
the control's parent with it, leaving a control that still exists, still answers,
and is in no list. The handlers are blocked for the duration, or a move that ends
where it began reports a `Select` nobody made. And **the row is unselected before
the remove**: `gtk_list_box_remove` clears the box's pointer but leaves the row's
own flag set, and `select_row` returns early on a row that already claims to be
selected — so without it the row comes back drawing selected while `Index`
answers `-1`, with nothing but a click to get out of it. `tests/widgets`'
`Reorder` asserts the selection survives and that no event was raised.

**Nothing dragged out of one ever starts, and that decides what a board is made
of.** A `GtkListBox` claims the press for its own selection, so a row whose
control has `DragData` selects and does nothing else — measured with a one-row
probe that printed `SELECTED` and never `DROPPED`, while the same gesture from a
bare `Button` dropped fine. It is not the phase: a widget that claims a gesture
sequence cancels the others on it in capture as much as in bubble, which is the
same thing VTE does to a click (above). A column of *draggable* cards is a
[`Scroller`](#scroller) arranged `Vertical`, which claims nothing, with what the
list would have given written by hand — selection is a `MouseDown` and a class,
filtering sets `Visible`, editing is a double click, and each of those is one
`On(event, fn)` on the card itself. [`examples/kanban`](../examples/kanban) is
that, both halves.

**A drag can be shown while it travels, and the board above is what does.**
`Drop` used to be the whole of what a target heard, arriving once at the end, so
the placement was exact and invisible until the button came up. The target now
hears `DragEnter(data, x, y)` and `DragOver(data, x, y)` with the same point
`Drop` will carry — a column lights up, an insertion line sits where the card
would land — and `DragLeave()` when the drag goes without dropping. The source
hears `DragBegin()` and `DragEnd()`, the second on a drop and on a refusal, so the
card greys itself in the air and is put back on a refusal too. `data` is the
dragged string, preloaded on hover: without preload the value only exists at
drop, and `enter`/`motion` carry just the point. A handler that answers `false`
to `DragOver` refuses the drop at that point — strictly `false`,
since answering nothing is `undefined` and must stay an accept. Measured with a
real pointer, because there is no synthetic one: enter, motion with the data,
leave, drop, a refused drop that never arrives, and the end on a drop and on a
refusal.

**And a drop is not a leave**, which is why `dropOn` there puts the column out
itself before it moves the card. Measured in the same sitting: after a `Drop`
no `DragLeave` follows — five seconds of stillness and nothing — and the leave
for that target arrives at the *next* drag instead, after its `DragBegin` and
for a target that drag never went over. A column that lights up in `DragEnter`
therefore stays lit after a card lands on it unless `Drop` undoes it.

**And the rest of the list vocabulary is `ListBox`'s, because underneath they are
the same widget.** `MultiSelect`, `Selection`, `Select(i)`, `Deselect(i)`,
`SelectAll()`, `DeselectAll()`, `Remove(i)`, `Activate([i])`,
`ActivateOnSingleClick` and the `Activate` event are the same members with the
same meanings and, in the C, nearly the same code. They were missing here and
nowhere else — a program that moved a list from strings to widgets lost half its
vocabulary and invented replacements for it.

Two of them are not quite a copy. **`Remove(index)` goes through the container**:
a row holds a widget the application made and the list is holding a JS reference
to it, so unparenting the `GtkListBoxRow` would leave that behind —
`bta_container_detach` is the same act as deleting the child. And **`Select`
needs `selected-rows-changed` as well as `row-selected`**: GTK says nothing
through the second one when several rows may be chosen, so without both the event
would have gone quiet the moment `MultiSelect` was turned on.

**What it costs against a `ListBox`, measured** (marginal, from 1,000 rows to
10,000, one `Label` per row against one string): **0.053 ms and 11.3 KB a row
against 0.029 ms and 7.6 KB** — 1.8× the time and 1.5× the memory. That is the
price of a row being a widget you built, and it is smaller than it looks: the
extra is the wrapper, the JS object and the `Add` call. What it does *not* buy is
`Items` (a whole list as one translated property, which a `.form` can hold) or
`Text` (a row is a widget; which of its labels would that be) — which is why the
two controls both exist.

**A row of several controls is a different number.** The same measurement with a
`Panel` holding a `CheckButton` and two `Label`s is **0.18 ms and 40 KB a row**:
a thousand rows are 262 ms and 40 MB, ten thousand are 1.9 s and 459 MB. Neither
this control nor `ListBox` recycles — a `GtkListBox` builds and measures every
row it holds — so **past about a thousand rows of controls the answer is a
`TableView`**, which is a `GtkColumnView` and does recycle: 10,000 real rows
there cost 74 MB and 108 ms of layout, and on demand (`Count` + `Data`) they cost
nothing at all.

**Recycling here would be a different contract, not a flag.** The one this
control makes is *the row is yours* — you build it, you keep it, you change it.
Recycling requires the opposite (*the row is the runtime's*, filled on demand),
which is `GtkListView` with a `GtkSignalListItemFactory`: a `Build` event to make
a row, a `Bind` to fill it for row N, and an `Unbind` to let go of whatever the
bind connected — Android's ViewHolder, and GTK's own signal factory, are the same
four moments. It would go in as a mode, switched by assigning `Count` the way
`TableView`'s on-demand mode is, with `Filter` refused in it (a filter over
widgets cannot survive rows that are transient; a model filters the data). It is
written down here and not built because no application has asked: the measured
ceiling is a `RowList` of thousands of rows of controls, and the three cases this
control exists for — a property editor, a settings page, a list of results — are
tens to hundreds.

**`Filter` is asked, not raised.** `Filter(control, index)` — the widget in the row
and where it sits — and its **return value** decides: `false` hides the row, and a
form with no handler shows every one of them. The same shape as `TableView`'s
`Data` and `Form_Close`, and the same rule: it runs while GTK is laying the list
out, so a lookup and nothing that is not a lookup. `Refilter()` says the answer may
have changed and is the whole of the API on this side — what a handler answers
from, a search field or a checkbox, is the application's and nothing here can see
it change.

This is what a search box over a list of controls has to be. Without it the only
way to hide a row is to rebuild the list, which is what the IDE's property grid did
on every keystroke: forty editors destroyed and forty built to answer a question
GTK was going to ask anyway.

**`examples/files` is the whole of it running**: a directory listed one row per
file — icon, name, size — with a name field, a kind drop-down and a hidden-files
switch all feeding one predicate. It counts the two numbers that make the argument,
rows built and questions asked, so typing five letters is visibly five passes over
the rows and no rows built at all.

**A hidden row is still a row.** `Count` counts it, `Index` numbers by it, and
`Children` returns it — what a filter changes is what is on screen, not what the
list holds. An index that meant one thing while nothing was typed and another
afterwards would put every list that keeps rows and data side by side out of step
exactly when someone starts searching. And a filtered row is hidden with
`child-visible`, so GTK never allocates it again and the width and height it
reports are the ones it last had: what proves a row is off screen is that the rows
under it moved up, not a size of its own.

The trap: every child is wrapped in a `GtkListBoxRow`, so a child's GTK parent is
that row and not the slot. `bta_slot_child()` looks through it, `Children` returns
the widgets and not the rows, and deleting a child takes its row with it — but code
that walks a slot's children by hand will trip over it.

## Form

A `GtkWindow` whose child is a column: the menu bar goes above the slot, so
`Arrangement` can swap the slot without disturbing it.

`Show()` adds the window to the application, makes a modal window transient for the
active one, fires `Open` the first time, and presents it. `Close()` closes it,
firing `Close`. `Center()` is a no-op on purpose rather than a lie: on Wayland the
compositor decides placement.

**And `Show()` holds the form, so a dialog needs no reference kept anywhere.**
`new AskForm().Show()` is the whole of it: the runtime takes a strong reference
while the window is open and drops it when the close is allowed — a vetoed
`Form_Close` keeps it, `HideOnClose` releases it and a later `Show()` takes it
again, and hiding with `Visible = false` does not end it. The reference is
invisible to the collector on purpose (the `AudioPlayer` claim, for the length of
a sound, is the same bargain), so the runtime releases it on every road out,
including teardown.

**A form is asked whether it is closing, not told.** `Form_Close` returning true
keeps the window open — the convention `KeyPress` already uses for a key it
consumed, and returning nothing at all, which is what every handler written before
this did, lets the window go. The window's own X is the path an application cannot
otherwise govern, so without this a form with unsaved work had to choose between
saving behind the user's back and dropping what they typed; the IDE's translation
editor did the first and said so in a comment. With a veto, *"three files have
unsaved changes, really quit?"* is an ordinary dialog: refuse now, and quit from
the answer.

Nothing in this runtime blocks, so answering **is** that shape — veto, ask, and
act when the answer arrives. What the handler must not do is close the same window
again from inside itself; `Application.Quit` and a later `Close()` from the
dialog's own button are both fine, being a return to the main loop away. And it
governs `Close()` as much as the X, which is what makes it one road rather than
two: a Cancel button pressing Escape ends up in the same handler.

`Modal` has to be set before `Show()` to be taken into account for the transient
parent. `Controls` is every child the loader bound by name.

**The window's state.** `Resizable` is a request GTK keeps whether or not there is
a window, so it reads back and serialises like `Modal` and a `.form` can declare
it. `Maximized` and `FullScreen` are the other kind: they *ask* before the window
exists and *report* afterwards, so they read `false` on a form that has not been
shown -- not a lie, an answer about a window that is not there. That is also why
they are not in a `.form`: what the designer means is the size it drew, and a
window remembering it was maximised is the application's business or the desktop's.
`Minimize()` is a method because the state has no reader at all: a minimised
window is one the compositor chose not to map, and GTK reports nothing about it.

**`HideOnClose` is closed against put away, and it is not a nicety.** A form's
window is built once, when the form is constructed, and GTK takes the window apart
on close — so `Show()` on a closed form is not an error and not a window either:
measured, it stays 0×0 forever. A form meant to be opened again either declares
this or is constructed again every time, which is what the IDE's dialogs do.
Hidden instead, `Show()` brings it back at the size it had with everything still
in it — which is what a palette, a log or a find window wants, because coming back
to a field one had half typed is the whole point of putting it away. `Form_Close`
still runs and can still veto: what this chooses is what happens once the close is
allowed, not whether it is.

`Resizable: false` bounds the *user*, not the layout. The contents still drive the
window's size, so a label whose translation is longer than the box it was drawn in
opens the window wider anyway -- the dialogs in the IDE that declare it were
measured doing exactly that. A layout that must not move is a layout whose widths
are declared, not a window with the grip taken off.

`Resize(width, height)` fires with the size GTK settled on -- the same numbers
`Bounds()` gives, so a handler that relays out by hand has them without measuring.
It fires when the window is first given a size too, which is where `Bounds()`
first means anything.

**A control has `Allocated` for its own version of that fact, and it is what
anything inside the window should wait for.** `Resize` is the form's;
`Allocated(box)` is raised **once** for a control that asked, the first time GTK
gave it a real rectangle, with the same box `Bounds()` answers. A fit-to-the-room,
a dialog centred on its monitor, a translated label measured against its panel:
`Form_Open` runs before the window is presented, so all of it measures zero
there. That is what the five bounded retries this replaced -- `Ide.Chrome`,
`ImageForm`, `examples/viewer` and both `examples/i18n` -- were for, each with its
own number of tries.

It fires **once**, so a control that was already on screen has missed it: the
moment is gone and `Bounds()` is the answer for that case. A control on a hidden
page hears it when the page is shown, because that is when it gets one. Nothing
polls and nothing is held: the hook is the window's own layout pass, the same
`GdkSurface::layout` `Resize` rides. GTK4 offers nothing more exact per widget --
it has no `size-allocate`, `GtkWidget` has no `width`/`height` property to notify
on (measured: `notify::width` never fires), and `realize` and `map` both arrive
while the allocation is still 0x0, which is the too-early moment the event exists
to replace.

GTK4 has no `size-allocate` on a window, and the obvious substitute is a trap.
`notify::default-width` fires when GTK updates the size the window would
*remember*, which is **before** the window has been laid out at the new one: an
event wired to it carries the size the window had a moment ago and never
mentions the one it was notified about. Measured on a real display, a window
dragged from 400x300 to 640x500 raised one `Resize` saying `400x300` while
`Bounds()` already answered 640x500 -- and on the way up the notification comes
while there is no allocation at all, so it was dropped and no window was ever
told the size it opened at. A secondary window suffered most, since a form
nobody drags got no `Resize` in its whole life.

What the event rides is `GdkSurface::layout`, the signal `GtkWindow` itself lays
the window out on, hooked from the form's own `realize` so that this runs after
GTK's. `layout` is emitted for a relayout that is not a resize as well, so the
runtime remembers the last pair it reported and drops a repeat: one drag step
raises one event per size. A form is *told* its size: nothing here can refuse a
resize, which is the one way it differs from being told it is closing — that one
it may refuse (see `Form_Close`).

A form is a container, so everything above applies to it — including that its slot
is a `BtaFixed` by default, whose children follow the window according to their
`HAlign`/`VAlign`, and that `Arrangement: "Vertical"` is what a window built out
of boxes rather than coordinates uses instead.

## Known limitations

- `set_size_request` fixes the **minimum** size, not the exact one. A control whose
  natural size exceeds the request (a `Label` with long text) renders larger than
  the `.form` says. That is GTK's model and not a bug to fix — forcing an exact
  allocation would clip text instead — so the designer reports it rather than
  fighting it.
- `Form.Center()` is a no-op: on Wayland the compositor decides placement.
- `Message.*` does not block. GTK4's dialogs are asynchronous, so it does not
  behave like VB's `MsgBox`; a confirmation with an answer is a form
  (`ConfirmForm`), not a runtime primitive.
- `.js` load order matters when one class extends another of the same project.
  `sources` in `project.json` fixes it.
- The designer edits menus in a dialog rather than on the canvas — there is
  nothing to reorder, since a GTK4 menu is a model wired to actions and not a
  widget. The board **does** show the form's menu bar: a `Panel` and a `Label`
  per menu, dressed in the theme's own numbers and opening real menus through
  `Menu` and `PopupMenu`, the same bargain the title bar above it makes. Two
  things a stylesheet would close and the IDE will not grow one for: a previewed
  entry does not light up under the pointer the way `menubar > item` does, and it
  does not draw the 1px rule a real bar has inside its own height — which would
  have cost a 28th pixel, and the height is what the canvas depends on.
- An `Overlay`'s layers are shown and can be selected, but the designer has no
  gesture for stacking them: what it orders are the children of a box, a
  notebook's pages and a split's two halves.
- A `.form` always opens in the designer; there is no way to see it as text.
- The designer **offers** the project's style classes but does not wear them: a
  stylesheet belongs to a process, and the canvas is drawn in the IDE's. Loading
  the project's `app.css` would restyle the IDE itself — one `button { … }` in it
  reaches every button in that window — so what a class of the project's looks
  like is seen by running it. The theme's own classes do show.
- **A control has no mnemonic.** There is no `&Save` giving a button Alt+S, and no
  label that hands the focus to the field beside it. Menus do have them, and
  always have: `_File`, `F_orm`, with the underscore travelling in the msgid so
  the *translator* picks the letter — `_File` becomes `_Archivo`, F in one
  language and A in the other. What a control gets instead of a mnemonic is a menu
  item with a `shortcut`, which is a real accelerator and takes a list of them.

  This one is **decided rather than pending**, so the reasoning is worth keeping:

  - **The lineage dropped it.** Gambas has no marker on `Button.Text` and no
    `Buddy`-style property on `Label` — thirteen properties and not one links a
    label to a control. What it kept from VB is `Menu.Shortcut`. GNOME's own
    libadwaita-era dialogs largely do not set mnemonics either, macOS never had
    them, and the web's `accesskey` is dead in practice: it collides with the
    browser's shortcuts and with assistive technology.
  - **The cost lands on translators, and this project cares about that more than
    most.** The marker lives inside prose that goes through the catalogue, so the
    translator chooses the accelerator. Five curated menu titles is fine — it
    works today. Twelve controls on a dialog times every language is a collision
    waiting to happen, and *nothing would say so*: two controls claiming Alt+A
    render perfectly and one of them simply never answers.
  - **The half that would have been worth it is the label pointing at its
    field** (`Alt+N` focuses Name), and its real argument was never the Alt key
    but the accessibility relation it might carry — a screen reader announcing a
    field by its label. GTK does not document `gtk_label_set_mnemonic_widget` as
    setting `labelled-by`, and it was not verified, so that argument is not
    available. Without it the feature is nostalgia.

  If it is ever revisited, that label-to-field half is the piece to build, and
  verifying the accessibility relation is the thing to do first.

### Three things that were considered and are not coming

Written down so the argument is not had twice.

- **No `ToolBar` class.** GTK4 *removed* `GtkToolbar`; a toolbar there is a box
  wearing the theme's `toolbar` class, with `flat` buttons — which is exactly what
  the IDE's own already is, a `Panel` with `Arrangement: Horizontal` and
  `Style: "toolbar"`. A class would be a second name for a combination that has
  one, and this project already answered the same question about boxes: a `Panel`
  *is* the box. The one thing a class could add is **overflow** — collapsing what
  does not fit into a menu, which GTK4 gives no help with and nothing here needs
  while the IDE's own window has a 1100px floor.
- **No `ToolButton`.** `Button` already does all of it: set `Text` and `Icon`
  together and it builds the box itself, `Icon` alone gets the `image-button`
  treatment, and `Style = "flat"` is the rest. A second class with the same two
  properties, differing in nothing, is the `ListBox`/`ListView` confusion by
  another name.
- **No `MenuButton`.** A button that drops a menu is a `Button` with a `Menu` and
  one line: `Btn_Click() { this.Btn.PopupMenu(0, 0); }`. That is how the IDE's own
  tab-strip button works. A `GtkMenuButton` would add the drop-down arrow (an icon
  here), and announcing itself as a menu button to a screen reader — real, but
  unverified, and not worth a second way to attach a menu to a widget.
