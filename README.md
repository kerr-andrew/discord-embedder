# Discord Embed Previewer

Live, side-by-side preview of Discord message/embed JSON while you edit it.

## Usage

1. Open a `.json` file containing either:
   - A full Discord message payload: `{ "content": "...", "username": "...", "avatar_url": "...", "embeds": [...] }`
   - A bare embed array: `[ { "title": "...", ... }, ... ]`
   - A single embed object: `{ "title": "...", "description": "...", ... }`
2. Run **Discord Embed Previewer: Show Preview** from the Command Palette (or the preview icon in the editor title bar).
3. Edit the JSON — the preview updates live in the panel beside it.

## Notes

- Supports common Discord markdown: bold, italic, underline, strikethrough, spoilers, code spans/blocks, links, lists (`-`), subtext (`-#`), and mention/emoji placeholders.
- Headings (`#`, `##`, `###`) render in message content and embed descriptions, but — matching real Discord — are ignored (left literal) inside embed field names/values. Lists and subtext work everywhere.
- `color` is expected as a decimal integer (as Discord's API represents it), not a hex string.
- Invalid JSON shows an error banner without clearing the last valid preview.
