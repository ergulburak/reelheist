# Site packs

ReelHeist core is site-neutral. Site-specific rules come as JSON "site packs" from repositories that the user adds.
A pack is pure data. The extension never runs downloaded code.
The validator is `validatePack(obj)` in `extension/lib/packs/schema.js`. It returns `{ ok, errors, pack? }`.

## Pack format

A pack is one JSON file of at most 64 KB. Unknown fields are errors.
Regex strings are compiled with the `i` flag.

| Field | Type | Notes |
| --- | --- | --- |
| `schema` | number | Must be `1`. |
| `id` | string | Matches `^[a-z0-9-]{2,40}$`. |
| `name` | string | Display name. |
| `version` | string | `x.y.z`. |
| `lang` | string, optional | Content language, for example `en`. |
| `hosts` | string[] | Lowercase hostname patterns. `*` is allowed only inside the hostname, for example `a*.com` or `*.a.com`. No scheme, path, port or spaces. |
| `title.strip` | string[], optional | Regexes. Matches are removed from the page title. |
| `title.episodeUrl` | string[], optional | Regexes with named groups `(?<season>)` and `(?<episode>)`. |
| `title.slugUrl` | string, optional | Regex with named group `(?<slug>)`. |
| `title.yearUrl` | string, optional | Regex. The first capture is the year. |
| `episodes.linkUrl` | string[], optional | Regexes with groups `(?<season>)` and `(?<episode>)` for episode links. |
| `player.lazySrcAttrs` | string[], optional | Attribute names that hold lazy-loaded sources. |
| `player.playSelectors` | string[], optional | CSS selectors of play buttons. |
| `player.frameFetch` | boolean, optional | Fetch frame pages directly. |
| `block` | object[], optional | At most 20 rules `{ "urlFilter": string, "action": "stub" \| "block" }`. |

Example: `packs/example.json`.

## Repository format

A repository is a static folder that any web host can serve.

- `repo.json`: `{ "schema": 1, "name": "...", "website": "...", "publicKey": "<base64 raw 32-byte Ed25519 public key>" }`
- `index.json`: `{ "schema": 1, "packs": [{ "id", "name", "version", "lang", "hosts", "file": "packs/<id>.json", "sha256": "<hex>" }] }`
- `packs/<id>.json` and `packs/<id>.json.sig`. The `.sig` file holds a base64 Ed25519 signature over the raw bytes of the pack file.

The extension rejects a pack when the hash or the signature does not match. An installed pack stays in place when an update fails.

## Signing commands

Task 4 builds `tools/pack-sign.js`.

```
node tools/pack-sign.js keygen <dir>
node tools/pack-sign.js build <repoDir>
```

- `keygen` creates an Ed25519 key pair in `<dir>`. Keep the private key secret.
- `build` validates each pack, then writes `index.json` and the `.sig` files in `<repoDir>`.
