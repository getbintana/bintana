# LinkButton

An address, handed to the desktop.

The one control that opens something outside the application: a home page, a
licence, a bug tracker, a folder in the file manager. It looks like a link and
behaves like one, and the desktop decides what opens.

It is a `Widget` and a control like any other, so everything on
[Widget](Widget.md) is on it too; what follows is what is its own.

## Every member

| | | |
|---|---|---|
| `Text` | what it reads. **Translated** | [the words and the address](#the-words-and-the-address) |
| `Uri` | the address, handed to the desktop on click | [the words and the address](#the-words-and-the-address) |
| **event** `Click()` | it was pressed | [the words and the address](#the-words-and-the-address) |

## The words and the address

| | |
|---|---|
| `Text` | what the user reads. **Translated**. With no `Text` the address itself is shown, which is right for a home page and wrong for everything else |
| `Uri` | `https://…`, `mailto:…`, `file:///…` — whatever the desktop knows how to open |
| **event** `Click()` | it was pressed. The address is handed over **as well**: this event is for the application that wants to know, not for one that wants to decide |

**This is the only way the runtime hands a URI to the desktop.**
[`File.Open`](../../llm/library.md#file) opens a *file* by path; a web address is
this control's job, which is worth knowing when something else in a program — a
link in a document, a row in a list — needs to open one.

## What goes wrong

- **It shows the address instead of the words.** No `Text` was given.
- **Nothing opened.** The desktop has nothing registered for that scheme, or the
  address is malformed. There is no error to catch here; the desktop is the one
  that decides.
- **It needed to open a local file.** `file:///` works, and so does
  [`File.Open`](../../llm/library.md#file), which is the plainer road for a path
  you already have.

## What it does not do

- **No navigation, no browser.** It hands the address over and stops there.
- **No `Icon`.** A [`Button`](Button.md) with `Style: "flat"` and an icon is the
  control for a link that should look like a toolbar item.

## See also

[`Button`](Button.md) · [`Label`](Label.md) ·
[`File.Open`](../../llm/library.md#file)
