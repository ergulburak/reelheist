# Release Checklist

Follow these steps before publishing a new ReelHeist release:

1. **Version & Metadata Check**
   ```powershell
   node tools/check-release.js
   ```
   Confirms `helper/release.json` (`repo`), `extension/lib/links.js` (`SUPPORT_URL`, `REPO_URL`), and version numbers across `extension/manifest.json`, `helper/package.json`, and `installer/reelheist.iss` match.

2. **Neutrality & Localization Checks**
   ```powershell
   node tools/check-neutral.js
   node tools/check-i18n.js
   ```
   Both commands must exit `0`.

3. **Unit Tests**
   ```powershell
   cd helper && node --test test/*.test.js
   cd ../extension && node --test test/*.test.mjs
   ```
   All helper and extension unit tests must pass with `0` failures.

4. **Build Portable Dist & Installer**
   ```powershell
   node tools/build-installer.js
   ```
   Produces `installer/Output/ReelHeist-Setup-<version>.exe` and verifies portable `node.exe` SHA-256 against `SHASUMS256.txt`.

5. **Visual & End-to-End Verification**
   - Run `tools/e2e-shots.js` across `tr,de,ru,ar` × all fifteen themes (`red,black-beige,beige-black,midnight,emerald,amethyst,amber,snow,rose,velvet,neon,sunset,arctic,graphite,lavender`) and verify `0` horizontal overflows.
   - Verify silent install (`ReelHeist-Setup-<version>.exe /VERYSILENT`), guided setup page (`http://127.0.0.1:47861/`), HLS download + pause/resume, and YouTube download (`tools/e2e-youtube.js`).

6. **Publish on GitHub**
   - Create tag `v<version>` and upload `installer/Output/ReelHeist-Setup-<version>.exe` as a release asset so the in-app updater (`GET /api/update`) can discover it.
