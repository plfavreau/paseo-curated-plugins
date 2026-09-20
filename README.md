# Paseo curated plugins

Custom plugins for [Paseo](https://paseo.sh). Each directory is a standalone plugin.

| Plugin | What it does |
| --- | --- |
| [`image-preview`](./image-preview) | Renders inline thumbnails for image files the agent reads, instead of a plain text row. |

## Install

Plugins must be enabled once on the daemon. Add this to the top level of `~/.paseo/config.json`:

```json
{
  "version": 1,
  "pluginsEnabled": true
}
```

Then apply it without restarting the daemon:

```bash
paseo reload
```

Clone the repo and install the plugin you want:

```bash
git clone https://github.com/plfavreau/paseo-curated-plugins.git
cd paseo-curated-plugins/image-preview
npm install
paseo plugin install "$PWD"
paseo plugin ls
```

`paseo plugin ls` should show status `running`. Restart the Paseo app to pick up the plugin, because the client bundle is only fetched on a fresh connect.

After editing a plugin's source, run `paseo plugin reload <id>`. Never restart the daemon for this, it would kill running agents.

## image-preview

Any `Read` of a `.png`, `.jpg`, `.gif`, `.webp` and similar becomes a thumbnail in the timeline. Tap it to open a full size view with the file path and a download button.

The daemon downscales to 1024px wide and sends a JPEG data URI, so large screenshots stay cheap over the wire.

Requires `ffmpeg` and `ffprobe` on the daemon machine.

### Download button

The download button needs a helper that publishes a file at a URL your phone can reach, because the daemon is usually only reachable through the Paseo relay.

Point the plugin at your own helper:

```bash
PASEO_IMAGE_PREVIEW_SHARE_COMMAND=/path/to/share-helper
```

Paseo runs it as:

```
<command> <file> <hours> --name <filename>
```

It must print an https URL on its first line. Anything else on stdout is ignored.

Without it the preview and the full size view still work, and the download button reports that downloads are not configured.

Note that sharing copies the original full resolution file to whatever your helper publishes. Use a helper with unguessable URLs and a short expiry.

## License

MIT
