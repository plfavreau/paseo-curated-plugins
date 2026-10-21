System health adds a sidebar row with three pills for CPU, RAM and disk usage on the daemon machine. Each pill is green below 80%, orange from 80% to 95%, and red above 95%. The readings refresh every 15 seconds.

Clicking the row opens a popover with each reading, its detail (load average, used and total memory, free disk space) and a Clean button. Clean sends a message to a Paseo session you pick, with the current readings filled in, so an agent you keep open can run another cleanup round. The plugin itself never deletes anything.

## Setup

Pick the receiving session in the popover, or under Settings, Plugins, System health. The same screen lets you edit the message; `{stats}` is replaced with the current readings.

## How the readings are taken

- CPU: busy share across all cores between two samples.
- RAM: on macOS, `memory_pressure` free percentage, which ignores the file cache macOS reports as used. Other systems use free memory from Node.
- Disk: used share of the data volume (`/System/Volumes/Data` on macOS, `/` elsewhere), matching `df`.

Readings come from the daemon host, so a remote host shows that machine's usage.
