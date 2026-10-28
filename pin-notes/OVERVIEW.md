Pin notes lets you pin a note or a link to a conversation and jump back to it from a pill above the composer.

Open the Command Center (Ctrl+K, or ⌘K on macOS) and run **Pin note** or **Manage pins**. Both open one dialog: type a note or paste a link at the top, press Pin, and your pins are listed below with a ✕ to unpin.

Each pin becomes a pill above the composer, labeled with its title. A link pill opens the page and shows the site's favicon. A note pill opens a small popover with the text.

## Links

When the description contains a URL, the daemon fetches that page once to fill in the title (`og:title`, else `<title>`) and the favicon. A title you type yourself always wins, and a page that can't be reached still pins, using its hostname as the title.

## Where pins are stored

On the daemon machine, in `~/.paseo/plugin-data/pin-notes/pins.json`. Pins belong to one conversation and nothing is sent anywhere except the page fetch above.

## Note

The Command Center action opens its dialog through a sidebar footer item (`Pin note dialog`), which Paseo requires to host a dialog. Keep it enabled under Settings → Sidebar.
