# Malformed and Edge Cases

A file with no frontmatter deck. Should fall back to default deck.

Q1 :: A1

%% card start %%
Malformed block with no end marker

---

Wait, this block never ends! So this and the rest of the file should be skipped.

Orphan :: line inside malformed block
