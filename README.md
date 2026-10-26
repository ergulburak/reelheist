# ReelHeist

[Türkçe README](README.tr.md)

**ReelHeist** is a local browser extension + Windows helper application for saving HLS, direct video streams, and YouTube videos/playlists as clean MP4 files with multi-language audio tracks and soft subtitles.

<p align="center">
  <img src="docs/media/season-queue.gif" width="400" alt="A season in the ReelHeist queue: every episode is a card with a five-step bar">
</p>

<table>
  <tr>
    <td align="center" width="50%"><img src="docs/media/page-overlay.png" alt="The Download button on a video player"><br><sub>The <b>Download</b> button on the player (you can turn it off)</sub></td>
    <td align="center" width="25%"><img src="docs/media/popup-page.png" alt="The popup with quality, audio and subtitle choices"><br><sub>Quality, audio and subtitles</sub></td>
    <td align="center" width="25%"><img src="docs/media/settings.png" alt="Settings, Appearance tab"><br><sub>15 themes, 12 languages</sub></td>
  </tr>
</table>

---

## What's new in 0.3.0

- **Subtitles inside the MP4:** the subtitles go into the MP4 as tracks you choose in the player menu. The first default subtitle language turns on by itself (in VLC, set the preferred subtitle language). Settings → Download → "Put subtitles inside the MP4".
- **A folder for every episode,** with the MP4 and an `srt` folder for its subtitle files.
- **"Keep the .srt files" setting:** turn it off to delete the `.srt` files once they are inside the MP4.
- The "done" notification no longer says the lengths do not match when the warning is about something else.

## What's new in 0.2.0

- **Season cards:** every episode of a season is a card at once, with a five-step bar. The cards stay when you close the popup or the browser.
- **Notifications:** Windows notifications when an episode or a season finishes, or when a download fails.
- **Subtitles only:** save only the `.srt` files of a video or of a whole season.
- **Forced subtitles** are saved as `.<lang>.forced.srt`, so `.tr.srt` is always the full subtitle.
- **"Button on the page" setting:** turn the player button off under Settings → Appearance.
- **Sticky "Downloads" bar** at the bottom of the popup and the panel.
- Many reliability fixes in the season search and the queue.

---

## Features

- **Automatic stream & subtitle detection:** Captures HLS (`.m3u8`), direct media files (`.mp4`, `.webm`, `.mkv`), and WebVTT/SRT subtitles directly from the active tab, plus YouTube videos and playlists via `yt-dlp`.
- **Clean MP4 output:** Remuxes video and multiple audio tracks (tagged by language with the original track marked default) into a single standard `.mp4` file using `ffmpeg` without re-encoding.
- **Subtitles inside the MP4:** Settings → Download → "Put subtitles inside the MP4" (on by default) also adds the subtitles to the MP4 as tracks you choose in the player menu. The first default subtitle language turns on by itself in players that use the MP4 default flag; in VLC, set Tools → Preferences → Subtitles/OSD → Preferred subtitle language.
- **A folder for every episode:** each episode gets its own folder inside the series folder (`Show\Show.S01E02\`). The `.srt` files go into an `srt` folder inside it; turn off Settings → Download → "Keep the .srt files" to delete them once they are inside the MP4.
- **Pause & resume downloads:** Segment-level progress is kept on disk so interrupted or paused downloads resume where they left off.
- **Animated preview & selection chips:** Shows a 2-second muted preview loop, quality chip (`1080p`, `720p`, `480p`), audio track chip, and subtitle chip with per-site memory.
- **Season cards:** Queue a season and every episode appears as a card at once, with a step bar (Page, Video, Download, MP4, Done), so you can see where each one is and retry a failed one.
- **Subtitles only:** turn on the "Subtitles only" chip to save just the `.srt` files (also for a whole season) without downloading the video.
- **Download notifications:** Windows toasts when a download finishes or fails; choose all, errors only, or off under Settings → Download → Notifications.
- **Forced subtitles kept apart:** a signs-only track is saved as `.<lang>.forced.srt`, so players open the full subtitle by default.
- **Download button on the player:** appears on the page's video player; turn it off under Settings → Appearance → Button on the page.
- **15 themes & 12 languages:** Red, Black/Beige, Midnight, Emerald and eleven more; full localization in 12 languages (`tr`, `en`, `es`, `pt_BR`, `fr`, `de`, `ru`, `ar` with RTL, `zh_CN`, `id`, `ja`, `hi`).
- **Signed site-pack repositories:** Optional Ed25519-signed declarative JSON packs for custom title parsing, episode discovery, and player triggers.

---

## Installation (Windows)

1. Download **`ReelHeist-Setup-0.3.0.exe`** from the [GitHub Releases](https://github.com/ergulburak/reelheist/releases) page and run it.
   - **Windows SmartScreen notice:** Because the installer is not signed with a commercial code-signing certificate yet, Windows may display *"Windows protected your PC"*. Click **More info** → **Run anyway**.
2. Choose your language and complete the setup wizard. No administrator privileges are required (installs under `%LOCALAPPDATA%\ReelHeist`).
3. At the end of setup, the **Guided Extension Setup** page opens automatically in your browser:
   - **Step 1:** Copy `brave://extensions` (or `chrome://extensions` / `edge://extensions`) into the address bar and press Enter.
     ![Step 1 — Open Extensions](helper/guide/img/step1.png)
   - **Step 2:** Turn on **Developer mode** in the top-right corner.
     ![Step 2 — Enable Developer mode](helper/guide/img/step2.png)
   - **Step 3:** Click **Load unpacked** and paste the extension folder path (`%LOCALAPPDATA%\ReelHeist\app\extension`).
     ![Step 3 — Load unpacked](helper/guide/img/step3.png)
   - Once loaded, the setup guide automatically detects the extension and shows **Ready ✓**.
   - **Note on Developer mode:** Browsers may occasionally display a reminder banner about extensions running in Developer mode. This is normal for unpacked extensions.

---

## Adding Site Pack Repositories

ReelHeist works out of the box on generic HTML5/HLS players and YouTube. For sites with custom URL structures or title suffixes, you can add a signed **Site Pack Repository**:

1. Open the ReelHeist popup and click **⚙ Settings**.
2. Scroll to **Site repositories**, paste the repository URL (e.g. `https://example.com/repo`), and click **Add**.
3. Verify the repository's Ed25519 key fingerprint and click **Trust**.
4. Install the desired packs from the list. Installed packs are verified against their SHA-256 hash and Ed25519 signature and checked for updates daily.

See [docs/site-packs.md](docs/site-packs.md) for the declarative pack specification and signing workflow.

---

## Responsible Use & Supporter Note

- **Rights & personal use:** ReelHeist is a general-purpose media tool intended only for content you own, have permission to download, or are legally permitted to save for personal offline viewing. It does **not** bypass DRM or decrypt protected streams.
- **Supporter features (v0.2+ roadmap):** Any future supporter unlock is a voluntary patronage incentive to fund development—not DRM. The core source code remains open under the MIT license.

---

## Third-Party Components

ReelHeist uses or downloads the following open-source components during setup:

- **[Node.js](https://nodejs.org/)** (`v22.14.0` portable runtime) — MIT License
- **[FFmpeg](https://ffmpeg.org/)** (downloaded from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds)) — GPLv3 License
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — The Unlicense

---

## Development

```powershell
# Register the local repository helper for native messaging
powershell -ExecutionPolicy Bypass -File tools\dev-register.ps1

# Run unit tests
cd helper && node --test test/*.test.js
cd ../extension && node --test test/*.test.mjs

# Run checks
node tools/check-neutral.js
node tools/check-i18n.js
node tools/check-release.js
```

## License

MIT — see [LICENSE](LICENSE).
