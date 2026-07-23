# Ignored Zones

Cards inside certain markdown blocks should not be parsed.

| Header | Table |
|---|---|
| Card inside table :: SHOULD BE SKIPPED | ignore |

```rust
Card inside code block :: SHOULD BE SKIPPED
```

$$
Card inside math block :: SHOULD BE SKIPPED
$$

    This is an indented code block, it's NOT skipped because Obsidian users use indent for styling.
    Indented card :: SHOULD BE PARSED
