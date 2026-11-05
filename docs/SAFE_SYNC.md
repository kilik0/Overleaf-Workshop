# Safe Sync fork (kilik0)

This fork defaults Local Replica to **local-first, verified uploads**. It is intended for editing in VS Code / WSL and using Overleaf as a published copy.

## Guarantees and deliberate behavior changes

- An existing local source file is never automatically rewritten or deleted by this replica provider. Restart, reconnect, missing history, remote edits and server errors do not change this rule.
- Local saves and external file changes are coalesced (600 ms), serialized, uploaded and verified using a fresh server `joinDoc` response (or HTTP file download for binary files). The optimistic VFS cache is not upload confirmation.
- Source revisions and the sync baseline/intent journal live in `.overleaf/safe-sync/`. Journal writes are atomic; SHA-256 revisions are checked. Keep this folder private and backed up: revisions contain document content. No automatic pruning in this first release.
- Unsent local files are rediscovered on startup. Failed intents retry every 20 seconds; divergent files stay blocked until reviewed. A live process lock prevents two fork windows from syncing the same replica concurrently.
- A cloud version that differs from the last verified baseline blocks upload. Both available revisions are retained; nothing silently merges into local source.
- `Tmp/` at every depth and `.overleaf/` are always ignored before disk/network processing, even when an old custom ignore list is present.
- No automatic deletion, in either direction. Local deletion is flagged for review. Rename therefore uploads the new path but leaves the old cloud path for manual cleanup.
- Invisible Mode is unsupported for verified sync: its buffered acknowledgements do not prove server persistence.

## 0.15.1003 fixes

File creation now sends multipart bytes with the matching Content-Type boundary to undici. The previous form-data stream was rejected by Overleaf with HTTP 400 `invalid_upload_request`. Upload failures retain the actual server error. Regression coverage checks multipart bytes and headers; live tests create a Chinese .bib document and verify a fresh server readback.

## 0.15.1002 fixes

- Restore the current local replica from its `.overleaf/settings.json` when re-login removed the project SCM registry; never re-enable an explicitly disabled record.
- Create the Safe Sync output channel at extension activation, including when replica startup fails.
- Accept remote workspace URI schemes for metadata discovery.
- Exact OT writes use the fresh server version (`v`/`lastV`) rather than the legacy periodic hash field. Actual server tests now pass for ASCII, Chinese, Greek symbols and multi-line LaTeX.
- The legacy transport corrupts non-BMP Unicode (for example emoji); these files are rejected before sending instead of silently damaging cloud content. Ordinary Chinese/BMP symbols remain supported.

## First migration

Back up the local project and reload **all** VS Code windows using the old extension after installing. The old live provider must not continue running alongside this fork.

On first startup matching files establish a verified baseline. Differing files are blocked; this is intentional because the fork cannot know which version is correct. Use **Overleaf Safe Sync: Review unverified files**, compare the cloud snapshot with the unchanged local file, then **Publish selected local version...** if local is correct. That action backs up the cloud bytes and requests confirmation before one overwrite. Never delete the journal to clear a conflict.

A new Local Replica created through the extension may download remote files once, exclusively to absent paths (`wx`). Existing files remain untouched. An existing replica never automatically pulls cloud changes. A remote-only file notification is flagged; copy content manually after review if needed. Full folder refresh is not a two-way mirror.

## Commands and status

- **Retry and verify local files**: scan local files and retry; does not authorize overwriting a divergent cloud version.
- **Review unverified files**: open **Overleaf Safe Sync** output and a cloud-snapshot/local diff.
- **Publish selected local version...**: explicitly approve local content for a selected divergent file.

The warning icon wins over uploading icons when any file needs attention. A pending/uploading icon is not success. The normal cloud icon is shown only after the current checks have no pending files or known errors. See the output channel for `[verified]`, `[error]`, `[conflict]` and SHA-256 readback records.

## Limits

This is a local-first publishing workflow, **not simultaneous collaborative editing**. Cloud changes never automatically replace existing local files. Keep source control backups as well; snapshots are not a substitute for independent backups.

Overleaf OT document writes include the freshly read document version and reject a detected baseline change. Overleaf's file upload HTTP API does not provide an atomic compare-and-swap for binary files; the preflight check cannot eliminate a concurrent binary overwrite race. Avoid editing the same binary file from two clients.

A timed-out request may still execute at the server. Retry first rereads server content, and only marks success when it equals the target. This cannot provide a distributed transaction or cancel a server request already received.

Automatic retries do not bypass login failures. Reauthenticate when the server rejects an expired session. Network checks require the actual environment where the extension runs.

## Development / release

The extension ID is deliberately retained (`iamhyc.overleaf-workshop`) so existing login and replica associations survive local VSIX installation. The display name identifies this fork. It is not published as an official marketplace release. Versions `0.15.1001` and `0.15.1002` distinguishes the local build from upstream `0.15.10`; explicitly installing upstream replaces these protections.

- `npm ci --ignore-scripts`
- `npx patch-package`
- Provision PDF.js and latex-basics vendor assets via the upstream download scripts (or copy the verified installed upstream assets).
- `npm --prefix views/chat-view ci`
- `npm run test:safe-sync` (deterministic engine, disk store, VFS adapter tests)
- `npm run lint -- --quiet`
- `npm exec --package=@vscode/vsce -- vsce package`

`tests/live-smoke.cjs` is an explicit opt-in server smoke test. It accepts `{url, identity}` on stdin; never commit or print credentials. It creates a separate scratch project, tests actual server readback/UTF-8 and stale-baseline rejection, and leaves the scratch project for inspection. Offline tests are not evidence of a successful live server run.

Rollback: install the backed-up upstream VSIX/extracted extension and reload, understanding that upstream restores its automatic cloud-to-local overwrite behavior. Prefer keeping this fork disabled over re-enabling upstream on unbacked-up work.
