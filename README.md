# ReelHeist

[Türkçe README](README.tr.md)

**ReelHeist** is a local browser extension + Windows helper application for saving HLS, direct video streams, and YouTube videos/playlists as clean MP4 files with multi-language audio tracks and soft subtitles.

---

## Features

- **Automatic stream & subtitle detection:** Captures HLS (`.m3u8`), direct media files (`.mp4`, `.webm`, `.mkv`), and WebVTT/SRT subtitles directly from the active tab, plus YouTube videos and playlists via `yt-dlp`.
- **Clean MP4 output:** Remuxes video, multiple audio tracks (tagged by language with the original track marked default), and subtitles into a single standard `.mp4` file using `ffmpeg` without re-encoding.
- **Pause & resume downloads:** Segment-level progress is kept on disk so interrupted or paused downloads resume where they left off.
- **Animated preview & selection chips:** Shows a 2-second muted preview loop, quality chip (`1080p`, `720p`, `480p`), audio track chip, and subtitle chip with per-site memory.
- **3 themes & 12 languages:** Red, Black/Beige, and Beige/Black themes; full localization in 12 languages (`tr`, `en`, `es`, `pt_BR`, `fr`, `de`, `ru`, `ar` with RTL, `zh_CN`, `id`, `ja`, `hi`).
- **Signed site-pack repositories:** Optional Ed25519-signed declarative JSON packs for custom title parsing, episode discovery, and player triggers.

---

## Installation (Windows)

1. Download **`ReelHeist-Setup-0.1.0.exe`** from the [GitHub Releases](https://github.com/ergulburak/reelheist/releases) page and run it.
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
