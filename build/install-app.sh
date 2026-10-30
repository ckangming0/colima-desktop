#!/bin/sh
# Copy the freshly built app into /Applications, replacing any previous install.
set -e
cd "$(dirname "$0")/.."
src=$(ls -d dist/mac*/"Colima Desktop.app" | head -1)
dest="/Applications/Colima Desktop.app"
osascript -e 'quit app "Colima Desktop"' 2>/dev/null || true
rm -rf "$dest"
ditto "$src" "$dest"
echo "Installed $dest"
