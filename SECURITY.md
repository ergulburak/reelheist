# Security Policy

## Local Architecture & Boundaries

ReelHeist consists of a Manifest V3 browser extension and a local Node.js helper service running on Windows. To protect the user's machine from untrusted web pages:

1. **Loopback-Only Binding (`127.0.0.1`):**
   - Both the download daemon (`helper/daemon.js`) and the guided setup server (`helper/lib/guide-server.js`) bind strictly to `127.0.0.1` and are never exposed on LAN/WAN interfaces.
2. **Per-Session Random Token (`X-Token`):**
   - Each time `daemon.js` starts, it generates a 192-bit random token (`crypto.randomBytes(24).toString('hex')`) stored in `%LOCALAPPDATA%\ReelHeist\daemon.json`.
   - The browser extension obtains `{ port, token }` exclusively through Chrome Native Messaging (`com.reelheist.helper`), which is restricted via `allowed_origins` to the extension's ID.
   - Every `/api/*` request must include a matching `X-Token` header; otherwise the daemon rejects it with `401 Unauthorized`.
3. **Origin Verification:**
   - Any request to the daemon bearing an `Origin` header that does not match `^(chrome|moz)-extension://` is rejected with `403 Forbidden`.
4. **Path Traversal Protection:**
   - File existence checks (`/api/exists`) and file/folder open routes (`/api/open-file`, `/api/open-folder`) validate that the resolved path (including `fs.realpathSync` containment) stays strictly inside the configured download directory (`settings.outDir`).
5. **Read-Only Guided Setup Server (`127.0.0.1:47861`):**
   - The local setup guide server only accepts `GET` requests for `/` (the static guide page), `/status` (`{ extensionConnected, browsers, extDir }`), and its fixed static assets (`/guide.js`, `/i18n/*.json`, `/img/step[1-3].png`). It performs no state mutations or command execution.
6. **Signed Declarative Site Packs (v0.1):**
   - Site packs in v0.1 are purely declarative JSON files (capped at 64 KB) validated against a strict schema (`extension/lib/packs/schema.js`) with no executable code.
   - Repositories require explicit user trust after displaying the Ed25519 public key fingerprint, and every pack is verified against both its SHA-256 digest and its Ed25519 signature (`.sig`) before installation.

---

## Reporting a Vulnerability

If you discover a security vulnerability in ReelHeist, please report it privately via GitHub Security Advisories on the [repository](https://github.com/ergulburak/reelheist/security) rather than opening a public issue.
