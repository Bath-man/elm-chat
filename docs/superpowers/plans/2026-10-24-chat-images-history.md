# Encrypted images, faithful archives and windowed history

**Goal:** Restore sender-relative ownership and likes from encrypted backups, confirm export passwords, send end-to-end encrypted images with an accessible zoom/pan viewer, and recycle offscreen message elements.

**Architecture:** Keep the current signed AES-GCM chat envelopes. Store a complete validated raster image as a versioned local text payload, but transmit it in bounded encrypted chunks under the existing server frame limit. Persist only complete received images. Archive all payloads inside the existing password-encrypted container. No dependencies or cloud image storage.

**Decisions:** PNG/JPEG/GIF/WebP, up to 4 MiB each; reject other formats and oversized/invalid payloads. Preserve original bytes, including animation. Imported messages stay read-only and cannot replay interactions. Legacy archives without ownership snapshots cannot reconstruct a lost exporting session. Viewer supports wheel/buttons/pinch zoom, pointer dragging, reset, Escape/close and focus restoration.

## Work and verification
- [x] Archive lane: regress sender snapshots, likes independent of pagination, import/re-export, malformed fields, legacy compatibility and password mismatch; implement `mine`/`likes` snapshots.
- [x] Virtual list lane: regress variable-height range selection, bounded DOM and slot reuse, bidirectional scrolling, search navigation, prepend anchor and resize; implement measured spacers and reusable row slots.
- [x] Image lane: regress codec validation, out-of-order/duplicate chunk assembly, sender separation and bounds, encryption/tamper/backup round-trip; implement codec and integrate durable send/receive.
- [x] UI integration: retain current DESIGN.md tokens, image picker and read-only imported image thumbnail, zoom/pan dialog, confirmation password and virtual search navigation.
- [x] Run targeted and full Vitest suites, workspace typecheck, protocol check, production build, browser regression fixtures, `git diff --check`; review security and integration edges independently.

**Stop condition:** All four requirements implemented and fresh validation passes, or remaining unavailable validation explicitly reported. No deployment or commits requested.

## Pause checkpoint (2026-10-24, user requested compact)
- Implementation of all four requested features is present; no commits, deployments, manifest/lock changes or new dependencies.
- Archive: `mine` and `likes` snapshots inside AES-GCM backup; import keeps read-only semantics; legacy likes now computed in isolated archive on import. Export requires matching second password. Original image bytes are encrypted inside archives.
- Virtualization: generic `VirtualMessageList`, measured heights and spacers, reusable slot wrappers with keyed message children; search uses imperative navigation.
- Images: PNG/JPEG/GIF/WebP <=4 MiB /32MP, header dimensions checked before decode; original EXIF orientation retained (last fix stores raw dimensions instead of browser-oriented dimensions). Versioned full plaintext payload persisted locally (IndexedDB remains plaintext as documented), bounded chunks sent through signed AES-GCM chat envelopes, every image retry uses fresh transport UUIDs and stable logical image ID; assembled images insert-only. Both proactive join-sync and requested sync use byte-bounded batches. CSP permits only local `blob:` images additionally.
- Preview: modal keyboard trap/restore, Escape/close, wheel/buttons/pinch zoom, drag/reset, object URLs revoked.
- Review findings fixed: proactive sync >256KiB; spoofed pixel dimensions; image chunk0 retry replay; blob CSP; EXIF JPEG orientation. No open reviewed security blocker.
- Verification already passed: full suite 183 tests before final incremental regressions; full workspace typecheck and production build; virtual browser fixture 2000 rows bounded/reused; preview desktop/touch; existing composer motion/focus fixture; real two/three-context production server script `scripts/check-chat-images-browser.mjs` verifies ~350KiB PNG exact bytes, import identity+likes+images, no imported replay, all frames <256KiB, partial third-part failure +121s expiry + actual outbox retry. Agent stopped isolated server and removed /tmp launcher/data.
- Latest full suite started BEFORE legacy-likes implementation: 187 passed/1 failed (expected legacy-like regression); its command used && so subsequent typecheck did NOT run. After fix targeted history+image suite PASSED 16/16. Therefore final FRESH full suite/typecheck/build still REQUIRED on resume.
- Final preview script now also reads PNG/JPEG/WebP and EXIF orientation6 JPEG in browser; original EXIF regression was observed red then fixed. A synthetic pinch assertion raced React commit, changed script to waitForFunction(200%); ensure final run output is checked. Add orientation8 case if useful.
- Known inherited limitation: refresh loses historical room epoch keys; an interrupted unsaved old-epoch transfer may need sender resend. Do not share historical keys with new members. Fully received images survive reload. No guaranteed receipt ACK (same existing text semantics).

### Resume commands
Use Node22: `export PATH=/home/dell/.cache/sitebase-tools/node-v22.23.3-linux-x64/bin:$PATH`.
Playwright: `export PLAYWRIGHT_MODULE=/home/dell/.npm/_npx/fd3bca3c548369c0/node_modules/playwright/index.mjs`.
1. `npm test && npm run typecheck && npm run build && git diff --check`.
2. `node scripts/check-virtual-messages-browser.mjs && node scripts/check-image-preview-browser.mjs && node scripts/check-composer-motion-browser.mjs`.
3. For fresh real e2e, `check-chat-images-browser.mjs` needs disposable loopback relay at5199 serving dist (see script; prior executor built temporary launcher using esbuild importing createChatServer and FileMetadataStore; MemoryMetadataStore also suitable). Do not use cloud/production credentials.
4. Check diff, mark plan checkboxes, report concise Chinese completion with image format/4MiB limit and old archive sender-identity limitation. No deploy/commit unless asked.

## Final verification after resume (2026-10-24)
- `npm test`: 24 test files, 188 tests passed, zero failures.
- `npm run typecheck`: shared, crypto, web and server all passed.
- `npm run build`: message protocol/localization checks and production web/server builds passed.
- `git diff --check`: passed.
- Browser fixtures: virtual list (2000 variable-height rows, bounded DOM, reusable slots, reverse scroll, find, prepend anchoring, resize, append); image preview (desktop and touch, EXIF JPEG compatibility); existing composer focus/motion regression all passed.
- Fresh production-build real relay E2E: 352922-byte PNG exact-byte delivery/reload/resync; expired partial-transfer outbox retry; zoom/pan/close; mismatched password rejection; encrypted archive and different-identity restore of ownership, likes and both images; no imported replay or leak to new room peer; all 45 wire frames confidential and below 256 KiB; zero browser page errors. Disposable loopback relay and its temporary files cleaned up.
- Independent final incremental review approved with no remaining findings; additionally checked real JPEG EXIF orientations 6 and 8 and 32 archive/history/image targeted tests.
- All requested local implementation and validation work is complete. No new dependencies, commits, deployments or production-service changes. Existing limits remain: browser-local IndexedDB stores plaintext; transmission and exported archives are encrypted; legacy archives without exporter-relative ownership cannot reconstruct that missing information; interrupted unsaved transfers may require resend after epoch keys are lost on refresh. Physical iOS/Android device and production deployment checks were not run.
