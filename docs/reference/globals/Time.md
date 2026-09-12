# Time

The clock half of [`Day`](Day.md), and the same bargain.

**A time of day is the text `"HH:MM"`** — or `"HH:MM:SS"` — and nothing else. It
sorts as a string, survives JSON as itself, and carries no day to be wrong about.

## Every member

| | | |
|---|---|---|
| `Add(time, minutes)` | → the time `minutes` later; **wraps at midnight** | [arithmetic](#arithmetic) |
| `Between(from, to)` | → whole minutes, signed | [arithmetic](#arithmetic) |
| `Now` | the time of day now, with seconds | [now](#now) |
| `Seconds(time)` | → seconds since midnight | [arithmetic](#arithmetic) |

## Now

| | |
|---|---|
| `Now` | the time of day now, with seconds — `"21:03:58"` |

## Arithmetic

| | |
|---|---|
| `Add(time, minutes)` | `minutes` may be negative, and it **wraps at midnight**, because a time of day has no day to fall off |
| `Between(from, to)` | whole minutes from one to the other, signed |
| `Seconds(time)` | seconds since midnight — the exact number, for anything finer than a minute |

```js
Time.Add("08:30", 40)              // "09:10"
Time.Add("23:50", 30)              // "00:20"
Time.Between("08:30", "19:00")     // 630
"09:30" < "17:00"                  // true, already
```

## Why not a `Date`

**It is not a `Date` with the date thrown away.** An instant carries a day and a
zone, and *half past eight* has neither: an opening time, a shift, a class in a
timetable are true every day and in every country. The text says exactly that and
nothing more.

For how long something *took* — which is a different question again — the answer
is [`Stopwatch`](Stopwatch.md), never two clock readings subtracted.

## What goes wrong

- **Adding minutes went past midnight and produced nonsense.** It wraps; check
  whether the day matters to what you are doing.
- **A duration came out negative.** `Between` is signed, and a time of day has no
  ordering across midnight to lean on.
- **Seconds were needed and the text had none.** `"HH:MM"` and `"HH:MM:SS"` are
  both times; `Seconds` answers about whichever it is given.

## See also

[`Day`](Day.md) · [`Locale`](Locale.md) · [`Stopwatch`](Stopwatch.md)
