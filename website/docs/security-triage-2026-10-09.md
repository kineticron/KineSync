# Website security triage — October 9, 2026

Reviewed website commit `4d0391cd20b065abc461a53512c551cf12ba3b85` and the native renderer sources. These decisions apply to the static website demo; they are not a general approval of the mobile dependency tree.

## Alert 19: false positive

The bundled `url@0.11.4` formatter encodes the complete auth string with `encodeURIComponent`, then deliberately restores the first colon as the username/password separator. Later colons remain encoded. For `user:pass:extra`, output is `user:pass%3Aextra@host`. Replacing every encoded colon would change the formatter's intended semantics. This is delimiter restoration, not incomplete input sanitization.

## Alert 20: accepted dependency correctness issue

The same formatter escapes only the first literal `#` in a manually supplied `search` string. A constructed search containing multiple hashes can therefore move part of the query into the fragment. This issue is real; it is not classified as a false positive. Dismissed as “won't fix” for this saved demo snapshot: the website supplies checked-in lyric JSON, fixed preview URLs and local artwork; it does not supply auth strings, search strings or arbitrary resource URLs to the formatter. Query objects are encoded by `qs`. Revisit before adding URL input or user-selected resources. Any remediation should update the native renderer dependency/build and regenerate the verified snapshots together.

## Alert 21: accepted dependency correctness issue

Pixi's `SVGResource` uses `SVG_XML` to detect an SVG resource type. Its negated comment character class includes an accidental punctuation range and may reject valid comments. This is a format-sniffing heuristic, not an SVG sanitizer, allowlist or trust boundary. The site offers no SVG upload or user-provided artwork; its fixed artwork is WebP. Dismissed as “won't fix” for the saved demo snapshot. Revisit and use explicit resource type/updated dependency if arbitrary SVG input is introduced.

## Scope and evidence

- `website/app/landing.tsx` sends fixed `setLyrics`, `options`, `sync` and `visibility` messages. Incoming preview events are checked against the iframe window and same origin, then used only for validated lyric-line seek indices.
- The native AMLL entry does not instantiate a Pixi background/asset loader. Static lyric and attribution labels use `textContent`; the website demo provides no attribution avatars.
- Snapshot manifests and export tests retain exact bundle parity. No generated bundle was hand-patched and no CodeQL rule was disabled.
- Website format, production export, TypeScript and all 10 existing tests passed on the reviewed commit. A URL probe confirms intentional auth delimiter restoration and reproduces the multi-hash query issue.

These scoped dismissals clear the reviewed alerts; they do not claim that the repository's existing dependency vulnerabilities are fixed.
