# Discord Embedder

A VS Code extension for building and previewing Discord message/embed JSON side-by-side with the file you're editing — and editing directly in the preview, with changes written straight back into the JSON.

## Usage

1. Open a `.json` file containing either:
   - A full Discord message payload: `{ "content": "...", "username": "...", "avatar_url": "...", "embeds": [...] }`
   - A bare embed array: `[ { "title": "...", ... }, ... ]`
   - A single embed object: `{ "title": "...", "description": "...", ... }`
2. Open the **Discord Embedder** panel (bottom Panel area, next to Terminal/Output) or run **Discord Embedder: Show Preview** from the Command Palette.
3. The preview follows whichever JSON file you have focused, and updates live as you edit it.

## Editing in the preview

Text pieces (title, description, author name, footer text, message content/username, field name/value) are click-to-edit — click into one, type, and click away to commit. Edits are written back into the JSON file as pretty-printed, 2-space-indented JSON.

Fields get dedicated controls:

- `—`/`||` toggles a field between inline and full-width, `-` removes it.
- A small "+" glued to the right of each inline field adds another inline field beside it.
- A full-width "+ Add field" divider adds a full-width field; one also appears automatically after every 3rd inline field in a row.

Embeds have matching "+ Add embed" / "Remove embed" controls.

URLs (embed `url`, images, thumbnail, icons) and `color` are not editable from the preview in this version — edit those directly in the JSON.

## Notes

- Supports common Discord markdown: bold, italic, underline, strikethrough, spoilers, code spans/blocks, links, lists (`-`), subtext (`-#`), and mention/emoji placeholders.
- Headings (`#`, `##`, `###`) render in message content and embed descriptions, but — matching real Discord — are ignored (left literal) inside embed field names/values. Lists and subtext work everywhere.
- `color` is expected as a decimal integer (as Discord's API represents it), not a hex string.
- Invalid JSON shows an error banner without clearing the last valid preview.
