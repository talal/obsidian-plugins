---
title: "Project Alpha"
next: "[[Project Beta]]"
tags: ["rust","cli","markdown"]
aliases:
  - Alpha
  - ProjAlpha
previous: "[[Project Zero]]"
start: 2026-01-01
end: 2026-12-31
zzz: Last alphabetical
created: 2026-01-04
---

# Project Alpha

This is the _main_ project note for **Project Alpha**. It links to [[Design Doc]] and embeds a diagram: ![[architecture.png]]

We also reference a specific block: ![[Design Doc#^abc123]]

See the footnote[^1] for more context, and another one[^note2].

## Overview

Project Alpha is a _cli tool_ written in **Rust**. It aims to be ~~slow~~ fast.

Here is some `inline code`, an image ![diagram](diagram.png), and an autolink <https://example.com>.

Escaped emphasis: \*not italic\*

This line ends with a hard break\
and continues here.

### Goals

- Be fast
- Be minimal
- Be opinionated
- nested goal one
- nested goal two

1. First goal
2. Second goal
3. Third goal

## Tasks

- [ ] write parser
- [x] write formatter
- [ ] write tests
- [ ] sub-task under tests
- [x] another sub-task

## Notes

%% this is an internal comment, should not render %%

Here's a ==highlighted== reminder and a block with an id ^block-1

> [!NOTE] Remember
> This callout has extra spaces and inconsistent casing.
> It also spans multiple lines.

> [!warning]
> Watch out for edge cases.
>
>> Nested quote inside the callout.

> Just a plain blockquote, no callout type.
> Second line of the quote.

## Code

```Rust
fn main() {
    println!("hello");
}
```

    indented code block using four spaces
    second line of indented block

## Table

| Col1         | Col2 | Col3 |
| ------------ | :--: | ---: |
| a            |  b   |    c |
| longer value |  x   |    1 |

## Links

[External link](https://example.com "title")
[[Link With Spaces]]
[[Link|Alias Text]]
[[ Link With Extra Spaces | Alias ]]
[[Design Doc#Heading Name]]

---

---

---

[^1]: This is a footnote definition.

[^note2]: A second footnote, defined out of order.

## Edge Cases

%%
This is a multi-line
hidden comment
%%

Here is inline code that shouldn't be altered: `[[Wikilink]]` and `> [!warning]`.

```bash
# This bash script contains syntax that looks like Obsidian syntax
if [[  $foo == "bar"  ]]; then
   echo "> [!NOTE]"
fi
```

Some math blocks:

$$
  x = y^2 + 2
$$

Inline math: $x = y^2$.
