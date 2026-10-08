# macOS 26.1002.52244 review

Reviewed on 8 October 2026 for the `stuckinowhere/codex-usage-bar` fork.
Target: Apple Silicon macOS, `/Applications/ChatGPT.app`, desktop
`26.1002.52244`. This updates macOS support; the separate Windows package
pin and adapter remain unchanged.

## Inspected source

The complete vendor archive SHA-256 is
`40efd7acdf03a24817fcd7f35684fc2173b154df06774243cb4ab227e36fa915`.
The installer requires this archive, or an exact recorded candidate/recovery
archive, as well as the pinned application version. It rejects unreviewed
updates instead of learning new hooks at installation time.

| Role | Inspected asset |
| --- | --- |
| Composer and state bridge | `app-primary-15d1279f1ff0.js` |
| Notification lifecycle and React | `app-shared-6c00c2afcf84.js` |
| Native diff and plan composition | `local-conversation-turn-310d2b91b0d8.js` |
| Native utility layout | `app-initial-61c077dcc1af.js` |

These macOS paths differ from the Windows renderer with the same version.
The source hooks were inspected in the local archive and must occur exactly
once. The React, JSX, DOM and portal bootstrap exports were also checked.
The speed/diff bridge uses the composer's execution host; quota remains the
existing account state and context remains the selected conversation state.

## Signing fixes

The upstream entitlement reader used the deprecated `codesign --entitlements
:-` format. The inspected vendor executable has valid DER entitlements, but
that legacy reader reports an invalid blob and returns empty output.
`codesign --entitlements - --xml` decodes the actual capabilities, allowing
the candidate to preserve supported permissions and remove vendor claims
deliberately. A decoding warning fails verification instead of becoming an
empty permission list.

Copied package directories can acquire `com.apple.FinderInfo` metadata,
which strict local-signature verification rejects. Signing removes only
FinderInfo and ResourceFork from bundle copies inside the local checkout;
signing itself is limited to the canonical `New Build/ChatGPT.app` candidate.
Source bundles, quarantine, unrelated attributes and system security settings
are outside this operation. Cleanup does not follow symlinks.

The original Documents checkout was managed by File Provider, which re-added
FinderInfo after copy cleanup. Build preparation therefore uses the local
`~/Library/Application Support/CodexUsageBar/source` location. This avoids
concurrent package metadata changes without altering File Provider or system
security settings.

Current codesign also omits process entitlements from framework libraries.
The local signing policy therefore preserves supported capabilities on the
main/helper `.app` executable hosts and supplies no process claims for the
framework. Hardened Runtime remains enabled on all signing targets.

Native ASAR digest synchronization, integrity fuses, scoped loader permissions,
Hardened Runtime, source-signature validation, recovery and atomic installation
continue to use the existing guards.

## Verification

The installed vendor source remained untouched during preparation. Verified:

- Compatibility preflight for the installed version and complete archive hash.
- A complete build from the vendor source to a locally signed candidate.
- All 11 modified/new JavaScript modules pass Node's syntax checks.
- Native digest matches the actual ASAR dictionary; integrity fuses are
  unchanged; deep/strict signatures and expected local entitlements pass.
- Unrelated original archive contents remain byte-for-byte identical.
- 19 JavaScript tests and 10 macOS/shared Python suites pass, including
  55 unittest cases and the standalone atomic-install scenarios.
- The isolated fixture uses this version's actual React/DOM bootstrap and
  passes 35 width/font layouts, 60 zoom/reference layouts, four inherited-font
  regressions, eight UI states, diff click/keyboard actions and idle-refit checks.
  It uses fictional metric values and has no React page errors.

The renderer fixture now waits for stable geometry across animation frames,
rather than assuming React and ResizeObserver have committed within 80 ms.

Installation and live acceptance remain pending: the row must render in the
installed app, real quota/context/diff state must match, and a normal
quit/reopen must work. The Windows adapter has shared synthetic coverage here;
this review does not add Windows installed-app acceptance.

No app binaries, vendor assets, profiles, credentials, local logs or machine
receipts are published in this fork.
