# KineSync website design direction

The website should feel like stepping into the mobile app. The product, rather than an invented illustration, carries the page. Use generous type and spacing, the onboarding palette, layered translucent controls, and the real lyric renderers. Provisional images are explicitly replaceable when the asset folder arrives.

## Research and design skill

Read and applied [Anthropic's frontend-design skill](https://github.com/anthropics/skills/blob/main/skills/frontend-design/SKILL.md), accessed 9 October 2026. Its useful constraints here: make the product the characteristic hero element; use plain language; remove decorative section numbers and unnecessary labels; avoid repeating identical feature cards; spend visual emphasis in one place. The requested glass and onboarding colors take precedence over generic advice against particular styles.

Reviewed [InterfaceKit's guide to AI-looking websites](https://blog.interfacekit.io/what-makes-a-website-look-ai-generated) and [Ciptaly's design guide](https://ciptaly.com/blog/avoid-generic-ai-website-design). Applied the shared principle: concrete product content and an intentional hierarchy matter more than substituting fashionable fonts or colors. Removed orbit decorations, invented album covers, vague feature marketing, and CSS imitations of the lyric engines.

## References for every major element

These are published, professionally designed website references. They inform hierarchy and behavior; their artwork, proprietary fonts, and source code are not copied.

| Element | Website inspiration | KineSync adaptation |
| --- | --- | --- |
| Navigation and GitHub action | [Apple iOS product page](https://www.apple.com/os/ios/) local navigation; [Raycast](https://www.raycast.com/) concise product navigation | Compact sticky frosted navigation, restrained link count, actual GitHub mark and explicit GitHub label. |
| Hero and headline | [Apple Music](https://www.apple.com/apple-music/) Listening Experience and Sing device presentations | Left-aligned three-line headline, actual app capture as the main visual, simple free/Premium message, one download action. No fictional player UI. |
| Screenshot composition | [Apple iOS](https://www.apple.com/os/ios/) device-led product storytelling | Slightly angled app capture with a quiet lavender/mint light field. Image is a real BlueStacks capture, provisionally awaiting curated assets. |
| Benefits row | [Raycast](https://www.raycast.com/) concise benefit hierarchy | Four plain statements: free, files, platforms, open source. No decorative statistics or repeated glass tiles. |
| Experience / renderer switch | [Apple Music Sing](https://www.apple.com/apple-music/) lyrics presentation; [Spicy Lyrics](https://spicylyrics.org/) product identity | An interactive stage running the exact mobile WebView HTML, JS and CSS. Segmented control, playback, seek and tap-a-line interactions. |
| Vault section | [Apple iOS](https://www.apple.com/os/ios/) app feature presentations | Alternating image/copy layout, individual song TTML files and export as the concrete benefit. The placeholder shows Blinding Lights, Sloppy Joe and GERONIMO!. Current vault illustration is a labeled layout placeholder. |
| Open-source section | [Raycast](https://www.raycast.com/) community and extension ecosystem presentation | Short invitation and four floating frosted app windows for stars, contributors, GPL license and recent release rhythm. Raycast supplies the floating-window composition; GitHub supplies the actual figures. Direct repository/contribution/issue links. |
| Downloads | [Apple Music](https://www.apple.com/apple-music/) platform and acquisition sections | Two equally visible download choices, iOS and Android only. Installation conditions and guide links sit with each download. |
| FAQ and footer | [Apple Music](https://www.apple.com/apple-music/) question section and [Apple iOS](https://www.apple.com/os/ios/) quiet footer hierarchy | Native disclosures, concise concrete answers, low-emphasis support/navigation. |
| Glass materials | [Apple iOS](https://www.apple.com/os/ios/) glass navigation; [Apple materials guidance](https://developer.apple.com/design/human-interface-guidelines/materials) | Blur, saturation, translucent tint, thin highlight edge, readable text. Solid fallback and increased-contrast alternative. |
| Motion | [Apple iOS](https://www.apple.com/os/ios/) staged product presentation, [Apple motion guidance](https://developer.apple.com/design/human-interface-guidelines/motion), native onboarding | Masked line-by-line hero reveal; springy button press and renderer selection; smooth anchor scrolling. Reuse native damping 18/stiffness 240. Spicy and AMLL retain their actual word fill, blur and spring scrolling. |

## Palette and tokens

The online palette is [itmeo WebGradients](https://webgradients.com/), already used by `ExpoLyrics/components/onboarding/setup-motion.tsx`. Reusing it standardizes the web and onboarding experience instead of introducing another unrelated scheme.

| Token | Value | Source / use |
| --- | --- | --- |
| Background | `#090A11` | Native onboarding screen background |
| Text | `#F8F8FE` | Native onboarding labels |
| Lavender | `#A7A6CB` / `#8989BA` | Polite Rumors, onboarding setup |
| Ice blue | `#A1C4FD` / `#C2E9FB` | Winter Neva, onboarding modern gradient, primary actions |
| Mint / rose | `#A8EDEA` / `#FED6E3` | Rare Wind, onboarding beautiful gradient |
| Success | `#8FF0C4` | Native onboarding connected state |

Type: platform system sans first, matching the app's SF Pro/system stack, with locally hosted DM Sans fallback. Large tightly spaced headings, readable body copy, no all-caps decorative labels. Layout: left-aligned app-led hero; wide interactive experience; alternating vault and community sections; centered two-platform download. Glass is used for controls and preview surfaces, not every paragraph.

## Provisional assets and replacement plan

| Slot | Current source | Intended replacement |
| --- | --- | --- |
| `public/previews/player.webp` | `design/emulator-reference.png`, captured from the active BlueStacks app on 9 October 2026 | Curated portrait player capture, ideally showing translated and timed lyrics. Keep real renderer/UI intact. |
| `public/previews/artwork.webp` | Album view cropped from `Previews/KineSyncPortraits.png` | Clean artwork/player screenshot or short actual app video. |
| Vault panel | Explicitly labeled HTML layout placeholder | Real vault capture demonstrating local files and export. |
| App identity | `ExpoLyrics/assets/images/R.png`, as configured in `app.json` | Keep the actual icon, never the earlier invented orange K. |

Run `npm run sync:previews` from `website/` after updating app renderer bundles or source captures. The generated HTML hosts are checked in so Pages builds require only website dependencies. The frames are loaded on entering the viewport and suspend when hidden/offscreen. Preview playback starts only on request; reduced motion uses the engines' native static lyrics presentation and disables playback/scrubbing while preserving style controls and scrolling. There is no demo audio.

The host adds a dark color-scheme declaration so transparent WebViews composite correctly in the browser. A small standard message adapter connects the native WebView callbacks to the parent; the parent checks both origin and frame identity. The website copies the native renderer bundles without modifying them. Spicy now paints text only at animated word/letter leaves: parent text-clipped backgrounds and group shadows previously left duplicate outlines during word transforms. Static lines retain their original paint.

Validation: production export, TypeScript, formatting and ten export/demo/statistics tests pass. Browser review at 390px, 768px and 1280px found no horizontal page overflow. Both engines render; play/pause, keyboard scrub, Spicy/AMLL word taps, style switching, mobile installation links and FAQ disclosure were checked. Desktop and mobile review captures are saved alongside this document. The reduced-motion branch uses native static rendering; OS preference emulation was not available in the browser tool.

## Review checklist

- Validate at narrow phone, tablet and desktop widths; no horizontal page overflow.
- Inspect both native engines; play/pause, seek, tap-to-seek, and switch styles during playback.
- Check reduced motion, visible keyboard focus, FAQ disclosure and both platform links.
- Verify the static Pages export and all subpath assets.
- Replace provisional imagery after the asset folder arrives; retain this source map.

The onboarding preview and website share the exact original demo lyrics from `ExpoLyrics/lib/onboarding-demo-lyrics.ts`, including timing, French translations, background vocals and opposite alignment. `sync:previews` also generates `app/demo-lyrics.json`; regenerate it when the shared demo changes.


## Glass backgrounds and project statistics

Background fields use the exact original CSS of WebGradients [010 Winter Neva](https://webgradients.com/), [023 Rare Wind](https://webgradients.com/) and [060 Polite Rumors](https://webgradients.com/), verified against [itmeo's published stylesheet](https://github.com/itmeo/webgradients/blob/master/webgradients.css). No additional accent colors are introduced. Original gradient direction, stop values and stop positions are kept in CSS custom properties; masking, blur and low opacity soften their presentation. The gradients sit **behind** the navigation, renderer, vault, download surfaces and floating project windows. Opaque panel fills have been removed. Thin specular edges and standard/Safari backdrop blur supply the frosting; high-contrast and unsupported-browser fallbacks remain solid.

The production CSS optimizer dropped the standard backdrop-filter when the WebKit declaration followed it. Prefix-first declaration order preserves both exported properties. A production-export regression check covers this, and the browser computed style was verified as blur(32px) saturate(1.6).

Project statistics are sourced from the public [GitHub repository API](https://api.github.com/repos/Kineticron/KineSync), [contributors API](https://api.github.com/repos/Kineticron/KineSync/contributors) and [releases API](https://api.github.com/repos/Kineticron/KineSync/releases). The build refreshes a checked-in dated snapshot and retains that snapshot when offline. Contributors exclude bots and support pagination. Release rhythm is the rounded mean elapsed time between stable, published releases within the previous 90 days, including hotfixes; it describes past releases, not a promised schedule. Insufficient history shows a neutral follow-releases message. Each window links to its source, and the snapshot date is visible. Floating motion stops when offscreen and follows reduced-motion preference.
