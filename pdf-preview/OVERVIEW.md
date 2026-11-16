Shows the PDFs your agent reads as page thumbnails in the conversation, so you see the same document it does.

A PDF shows up when the agent reads it with its Read tool (Claude Code, OpenCode) or names it in a shell command, such as `pdftotext report.pdf` (what Codex does). The command row stays visible above the thumbnail, and its output opens with a tap.

Tap a thumbnail to page through the document. On desktop and web the arrow keys turn pages and Escape closes the viewer. From the viewer you can open the full PDF in a browser tab, download it, or copy its path. The file travels over your existing Paseo connection and is never uploaded anywhere.

Pages are rendered on the daemon machine, so it needs poppler (`pdfinfo` and `pdftoppm`, `brew install poppler` on macOS). A path in a shell command that is not a real file gets a short "no preview" line.
