# yoto-podcast

The home for Nick's [Yoto](https://yotoplay.com) work. Built for a single-user, single-Mac setup.

- **Albums:** turn audio from any source (CD rips, downloads) into a finished album in the Box Yoto library: named files, ID3 tags, cover, track guide. See [Albums](#albums).
- **Cards:** create and edit Make Your Own cards from the command line, including icons from Yoto, [Tinker](https://tinker.audio), yotoicons.com and Nick's own uploads. See [Make Your Own cards](#make-your-own-cards).

<a href="https://tinker.audio/?from=api&app=906462c4-6130-4378-9f24-ad9ca7ac4c88" target="_blank" rel="noopener" aria-label="Icons powered by Tinker" data-tinker-app="906462c4-6130-4378-9f24-ad9ca7ac4c88">
  <img src="https://cdn.tinker.audio/powered-by-tinker.svg" alt="Icons powered by Tinker" width="198" height="40" />
</a>
- **Podcasts:** watch RSS feeds, download new episodes, and push them to cards as new chapters, daily under launchd.

![Yoto Podcast icon](yoto-podcasts.png)

## Podcasts: what it does

- Polls each configured RSS feed for new episodes.
- Downloads new episodes to a local directory as `NN - Title.mp3` (zero-padded number, newest = highest).
- Uploads each new file to Yoto, transcodes via the Yoto API, and prepends a chapter to the configured card so the newest episode is at the top.
- Sends a macOS notification per new episode (via a small bundled `.app` so the notification gets a custom icon).
- The filesystem is the source of truth — there is no database or state file. New episodes are detected by comparing the latest local filename against the feed.

## Requirements

- macOS (notifications and launchd are macOS-specific).
- Node.js ≥ 24 (the project uses native `fetch`, `Readable.fromWeb`, and ES modules).
- A Yoto account with at least one card you control.

## Install

```bash
git clone <this repo> ~/Code/yoto-podcast
cd ~/Code/yoto-podcast
npm install
```

To run it as `yoto <command>` from anywhere, put a wrapper on your PATH (it runs on whatever `node` is on PATH; Node 26 needs the warning flag for tsx's ESM loader):

```bash
printf '#!/bin/sh\nNODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--disable-warning=DEP0205" exec %s/node_modules/.bin/tsx %s/src/cli.ts "$@"\n' "$PWD" "$PWD" \
  > ~/.local/bin/yoto && chmod +x ~/.local/bin/yoto
```

`yoto card show <id>` is then the same as `npx tsx src/cli.ts card show <id>` in this folder.

## Configure

Albums and card labels need to know where your Yoto library lives. Copy `.env.example` to `.env` and set `YOTO_LIBRARY` (a leading `~/` is expanded):

```bash
cp .env.example .env
```

To search Tinker Icons, also set `TINKER_API_KEY` to your app's key from [Tinker for developers](https://developers.tinker.audio), or to a 1Password reference such as `op://Private/Tinker API/key`, which is read with `op read` each time a search runs. If you're signed in to more than one 1Password account, set `OP_ACCOUNT` in `.env` to the one holding the key.

For podcasts, create `~/.config/yoto-podcast/config.json`:

```json
{
  "yoto": {
    "clientId": "<your Yoto OAuth client ID>"
  },
  "podcasts": [
    {
      "name": "Dino Dome",
      "feedUrl": "https://example.com/dino-dome.rss",
      "directory": "/Users/you/Podcasts/Dino Dome",
      "cardId": "eS2sa",
      "skipPatterns": ["(Replay)"]
    }
  ]
}
```

Fields:

- `name` — display name, used in logs and notifications.
- `feedUrl` — RSS feed URL.
- `directory` — where MP3s are saved. Created on first download.
- `cardId` — the short Yoto card ID (visible in the My-O web UI URL).
- `skipPatterns` — optional, case-insensitive substring matches. Episodes with a matching title are not downloaded.

## Authenticate

Yoto uses an OAuth device-code flow. Run once:

```bash
npx tsx src/cli.ts auth
```

Visit the URL it prints, enter the code, and approve. Tokens are saved to `~/.config/yoto-podcast/tokens.json`. The access token is refreshed automatically on each `check` run.

## Commands

```bash
# Check all feeds, download new episodes, upload to Yoto
npx tsx src/cli.ts check

# Download a podcast's full back-catalogue and (optionally) populate a card
npx tsx src/cli.ts backfill \
  --feed https://example.com/feed.rss \
  --dir "/Users/you/Podcasts/Show Name" \
  --name "Show Name" \
  --card abc12
```

`check` is idempotent — running it twice in a row will report "Up to date" the second time.

`backfill` downloads missing files only (re-runs are safe), then if `--card` is given, replaces the card's chapter list with the full catalogue (newest first). Use it for first-time setup.

## Make Your Own cards

Commands for any MYO card, not just podcasts. They use the same tokens as `check`. Chapters count from 1, as on the player.

```bash
# Read
npx tsx src/cli.ts card list
npx tsx src/cli.ts card show <cardId>
npx tsx src/cli.ts icons search moon
npx tsx src/cli.ts icons tinker "grey wolf" --sheet wolves.png   # Tinker Icons, plus a picture of the results
npx tsx src/cli.ts icons mine        # your own uploaded icons, as an HTML contact sheet

# Create: one chapter per "NN - Title.mp3", ordered by NN.
# Title defaults to the folder name; ID3 title is used if a file name has no title.
npx tsx src/cli.ts card create "/path/to/Album" --cover cover.jpg [--title "..."] [--icon <icon>]

# Card edits
npx tsx src/cli.ts card rename <cardId> "New title"
npx tsx src/cli.ts card cover <cardId> new-cover.jpg

# Chapter edits
npx tsx src/cli.ts chapter rename <cardId> 3 "Blast off"
npx tsx src/cli.ts chapter icon <cardId> 3 "Crescent moon"   # or a media ID, a 16x16 PNG, or yoto:#id
npx tsx src/cli.ts chapter icon <cardId> 3 https://yotoicons.com/static/uploads/1701.png   # or yotoicons:1701
npx tsx src/cli.ts chapter icon <cardId> 3 tinker:<id>   # or its cdn.tinker.audio URL
npx tsx src/cli.ts chapter audio <cardId> 3 "03 - Part 2.mp3"
npx tsx src/cli.ts chapter add <cardId> "16 - Bonus.mp3" [--at 2] [--title "..."] [--icon <icon>]
npx tsx src/cli.ts chapter remove <cardId> 16
npx tsx src/cli.ts chapter move <cardId> 16 1
```

Every edit fetches the card, changes only what was asked, prints the change, then saves. Add `--dry-run` to any create or edit to see the change without uploading or saving.

- `card create` refuses if a card with the same title exists (`--allow-duplicate` to override), and uploads every file before creating the card, so a failed upload leaves no half-made card. Uploads run three at a time and retry with back-off when Yoto refuses (429) or errors (5xx); any track that still fails is named, and a re-run only re-uploads what's missing.
- An icon name that matches several public icons lists them with their media IDs; pass the ID instead.
- yotoicons.com icons are paste-in only: find one on the site, then pass its image URL or `yotoicons:<id>`. The CLI downloads that PNG, bumps the site's download count for the artist, and uploads it as a custom icon. There's no yotoicons search, because their API needs a key.
- Tinker Icons can be searched by name, misspelling or meaning ("something for bedtime"). `icons tinker` lists `tinker:<id>` refs numbered in the same order as `--sheet`'s picture (left to right, ten to a row). Pass a ref anywhere an icon goes; the CLI downloads the PNG from Tinker's CDN and uploads it as a custom icon. Each app gets 500 searches a day.
- Chapter numbers on the player are renumbered after add/remove/move, unless the card uses custom labels.
- Uploading a PNG, yotoicons or Tinker icon first checks your icon library pixel by pixel and reuses a match instead of uploading a duplicate.
- `icons mine` writes a contact sheet of your uploaded icons (newest first, click to copy `yoto:#<id>`) and flags any picture uploaded twice.
- When the album folder has an `album.json` (see [Albums](#albums)), `card create` takes chapter titles and `yotoIcon`s from it, skips `leaveOff` tracks, and uses the cover from `Cover images/`.
- After creating a card, link it to a physical MYO card in the Yoto app.

## Albums

Library root: `YOTO_LIBRARY` from `.env`. A finished album is `<Stories|Songs|Non-fiction>/<Series> - <Title>/` holding `NN - Title.mp3` files with ID3v2.3 tags and embedded art, `track_guide.md` and `album.json`, plus its cover at `Cover images/<slug>.jpg`.

`album.json` describes the album: metadata, cover source, `stories` (one icon per multi-track story), and per track the source file, title, description, its story or its own icon (an emoji, or a `:label:` such as `:bingo:`), and optional `yotoIcon` and `leaveOff`. Fields are documented in `src/services/album-manifest.ts`.

```bash
npx tsx src/cli.ts prepare path/to/album.json --dry-run   # list what would change
npx tsx src/cli.ts prepare path/to/album.json             # write it
```

- Writes only what differs from the manifest: tags, embedded cover, audio, cover image, guide. A re-run with nothing changed writes nothing.
- Embeds `embedCover` if set, otherwise `cover`, shrunk to fit 800 px. `"embedCover": "keep"` keeps each file's existing art instead.
- Saves the cover full size, losslessly optimised and stripped of metadata other than its colour profile.
- A re-run that shifts tracks (inserting or removing one) copies any source it would overwrite aside first, so no track's audio is lost.
- A source outside the library (a rip, a download) is only read; the finished files are copies.
- A source already in the library (outside `_To delete/`) is renamed and retagged in place, never copied: its folder is renamed too when it holds only the album; otherwise the tracks move and the folder keeps its other files. The dry run shows each `would move … → …` and `would retag`.
- Nothing is deleted. Files the manifest doesn't produce are listed as "left alone".
- Online-only Box files can't be read; `prepare` stops and names the folder to make available offline.
- The saved `album.json` points at the finished files, so edit it in place and re-run. For a later disc, append its tracks with absolute paths to the new rip.
- Needs `ffmpeg`, `ffprobe` and `jpegtran` (Homebrew `jpeg-turbo`) on the PATH, plus macOS's `sips`.

## Card labels

A4 sheets of card labels go in `Yoto/Labels/`. `Yoto/Labels/catalogue.json` lists every MYO card, newest first, with its cover file in `Cover images/` and `printed`: the sheet its label is on, or `null`.

```bash
npx tsx src/cli.ts labels sync --dry-run                          # new cards, and covers that would be downloaded
npx tsx src/cli.ts labels sync                                    # add them to the catalogue
npx tsx src/cli.ts labels todo                                    # cards not printed yet, newest first
npx tsx src/cli.ts labels sheet --next --dry-run                  # a page of the 12 newest unprinted cards
npx tsx src/cli.ts labels sheet "nim sea" fOXxm --next            # these two, then fill the page
npx tsx src/cli.ts labels sheet --format 2025 kipper
```

- `sync` takes a new card's cover from the `Cover images/` file named after its title; otherwise it downloads the card's cover from Yoto (adding the card ID to the name if that name is taken).
- Cards are named by card ID or words from the title. An ambiguous name lists the matches.
- `--format 2026` (default): 4×3 portrait labels, 45×74 mm. `--format 2025`: 2×5 landscape labels, 72.6×41.6 mm, cover turned on its side, light cut lines.
- Writing the PDF marks its cards printed. Set `printed` back to `null` if a sheet doesn't get printed, or to any text (such as `"no label"`) to keep a card out of `todo`.
- Needs Google Chrome (renders the PDF) and ImageMagick.

## Scheduling (launchd)

The repo doesn't ship a plist — you create one for your machine. A working example lives at `~/Library/LaunchAgents/com.yoto-podcast.check.plist` and runs daily at 14:00:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.yoto-podcast.check</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/you/.nvm/versions/node/v24.14.0/bin/npx</string>
    <string>tsx</string>
    <string>src/cli.ts</string>
    <string>check</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/you/Code/yoto-podcast</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>14</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>/Users/you/Library/Logs/yoto-podcast/check.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/you/Library/Logs/yoto-podcast/check.log</string>
</dict>
</plist>
```

Note: the node path is hardcoded. If you upgrade Node via nvm, update the plist.

Useful commands:

```bash
launchctl load   ~/Library/LaunchAgents/com.yoto-podcast.check.plist
launchctl unload ~/Library/LaunchAgents/com.yoto-podcast.check.plist
launchctl list   com.yoto-podcast.check     # check LastExitStatus
launchctl start  com.yoto-podcast.check     # trigger a manual run
```

## Logs

```bash
tail -f ~/Library/Logs/yoto-podcast/check.log
```

Each run writes a header: `--- yoto-podcast check @ <date> ---`.

## Custom notification icon

`YotoPodcast.app` is a tiny AppleScript applet bundle whose only purpose is to give macOS notifications a custom icon (replace `Contents/Resources/applet.icns` with your own). `src/services/notify.ts` recompiles the bundled script on each notification and runs the applet — if anything goes wrong it falls back to a plain `osascript` notification.

## Project layout

```
src/
  cli.ts                  # commander entry point
  config.ts               # config, .env + token IO
  types.ts                # shared types
  commands/
    auth.ts               # OAuth device flow + token refresh
    check.ts              # poll feeds, download, push to Yoto
    backfill.ts           # full-catalogue download + card replace
    myo.ts                # MYO card/chapter/icon commands
    prepare.ts            # album.json -> finished album in the library
  services/
    album.ts              # scan "NN - Title.mp3" folders, ID3 title fallback
    album-manifest.ts     # album.json schema, names, tags, track guide
    card-edit.ts          # pure card edits + change diff
    icons.ts              # public icon search, yotoicons paste-in
    tinker.ts             # Tinker Icons search, download and results sheet
    icon-library.ts       # your uploaded icons: pixel matching, contact sheet
    feed.ts               # RSS parse + skip-pattern + title normalize
    download.ts           # filename math + atomic download via .tmp
    yoto.ts               # Yoto SDK wrapper (upload, transcode poll, card edit, cover/icon upload)
    notify.ts             # macOS notification via the bundled .app
tests/                    # vitest unit tests + RSS fixtures
YotoPodcast.app/          # AppleScript bundle for icon'd notifications
```

## Tests

```bash
npm test          # one-shot
npm run test:watch
```

## Troubleshooting

1. **Missed run?** `cat ~/Library/Logs/yoto-podcast/check.log` and `launchctl list com.yoto-podcast.check`.
2. **Tokens revoked?** Re-run `npx tsx src/cli.ts auth`. If the refresh token is dead, `check` will fail to upload but downloads still work.
3. **`EPERM: operation not permitted, scandir ...`?** The process running `check` isn't allowed to read the episode folder (common with Box/cloud-sync folders, which macOS gates per app). `check` stops rather than treating the folder as empty. Trigger manual runs with `launchctl start com.yoto-podcast.check` instead of from a terminal or editor that lacks access.
4. **Node moved?** nvm upgrades change the binary path — update the plist.

## Limitations

- macOS only.
- Single-machine: no shared state, no remote queue.
- One card per podcast.
- MP3 only (the Yoto API transcodes it on its side).
- No retry/backoff on transient feed or network errors — the next scheduled run picks them up.
