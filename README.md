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

Any `Read` of a `.png`, `.jpg`, `.gif`, `.webp` and similar becomes a thumbnail in the timeline. Tap it to open a full size view with the file path and a download button. The viewer includes previous/next buttons to browse completed image reads in conversation order; on the web and desktop, the left/right arrow keys also navigate, and Escape closes the viewer. Repeated reads of the same file remain separate slides.

The daemon downscales to 1024px wide and sends a JPEG data URI, so large screenshots stay cheap over the wire.

Requires `ffmpeg` and `ffprobe` on the daemon machine.

### Download button

Downloads need no setup. The daemon streams the original file to the app in 384 KB chunks over the connection you already have, and the app saves it. The file never leaves your daemon and your device, and nothing is uploaded anywhere.

The thumbnail is a downscaled JPEG, but the download is the untouched original file.

This works in the Paseo web app, which includes the mobile app. On a build with no browser file APIs the button says so instead of failing silently. Files above 64 MB are refused.

## License

MIT
