# Appa Music

A free music player in the browser. Search and play almost any song, with liked songs,
playlists and a queue. Music comes from YouTube through the official YouTube Data API and
the embedded YouTube player. You don't need an account or a subscription.

**Live:** https://sinan-1284.github.io/appa-music/ (on first visit, paste your own free YouTube API key; see Setup).

## Setup (once, about 2 minutes)
1. Open https://console.cloud.google.com/apis/library/youtube.googleapis.com, create a
   project if asked, and click **Enable**.
2. Go to **Credentials** → **Create credentials** → **API key**.
3. Recommended: restrict the key to **Websites** → `http://127.0.0.1:8888/*` and to the
   YouTube Data API v3.
4. Create `config.local.js` next to `index.html`:
   ```js
   export const YOUTUBE_API_KEY = 'your-key';
   ```
   This file is git-ignored, so your key is never committed. If you skip this step, the
   app asks for a key on first launch and saves it in your browser.

## Run
```bash
./serve.sh
```
Then open http://127.0.0.1:8888/.

## Features
- Home with trending music for your country and recently played songs
- Search for songs; artist pages show the channel's uploads
- Liked Songs; create, rename and delete playlists; add or remove songs through the ••• menu
- Import any public YouTube or YouTube Music playlist by pasting its link (Your Library)
- Player with play/pause, next/previous, seek, shuffle, repeat (all/one), volume and a queue
- Space bar toggles playback; the layout adapts to phones
- Blocked videos: when a video's owner only allows playback on youtube.com, the app plays
  another version of the song (usually the official "Artist - Topic" audio) and remembers it

## Good to know
- **Search quota:** a free key gets 10,000 units a day. A search costs about 100, so you
  get roughly 100 new searches a day. Repeat searches are cached and cost nothing. The
  quota resets at midnight Pacific time.
- **The video stays visible.** YouTube's rules require the player to be visible
  (at least 200×200 px), so it's shown in the "Now playing" panel.
- **Your library is stored in this browser** (localStorage).
- YouTube may show ads in the player, as on youtube.com.

## Files
- `js/yt.js`: YouTube Data API (search, videos, channels, playlists) and caching
- `js/player.js`: YouTube IFrame player, the queue, and blocked-video fallback
- `js/store.js`: liked songs, playlists and history in localStorage
- `js/app.js`: pages, routing, menus, player bar
- `style.css`, `index.html`, `config.js`, `serve.sh`
