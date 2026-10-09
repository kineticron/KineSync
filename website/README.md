# KineSync website

A static Next.js landing page for GitHub Pages. Built with React, Motion, and Lucide icons.

## Develop

Use Node 22 or newer.

```sh
npm ci
npm run dev
```

Open http://localhost:3000/KineSync/.

## Validate and export

```sh
npm run build
npm run typecheck
npm test
npm run format:check
```

The exported site is in `out/`. The default base path is `/KineSync`. Set `NEXT_PUBLIC_BASE_PATH` to an empty string when hosting at a domain root. The canonical URL, sitemap, and structured data should also be updated for a different host.

Run `npm run preview` to serve the production export at http://127.0.0.1:3100/KineSync/. Use this build for performance inspection rather than the development server.

## Deployment

The GitHub Pages workflow builds and checks the static export before deploying. Pull requests only build. Repository administrators must enable GitHub Pages with GitHub Actions as the source.

## Design and accessibility

The website uses the native onboarding palette and frosted glass surfaces. [Design references](design/REFERENCES.md) document inspiration from Apple Music, Apple iOS, Raycast, the frontend-design skill, and guides to avoiding generic AI design for every major element and motion treatment. The hero is a provisional capture from the running BlueStacks app; the artwork view comes from the repository's app previews. The vault has a labeled layout placeholder pending curated assets.

The interactive preview runs the actual Spicy and AMLL WebView HTML, JavaScript and CSS from the mobile app. Run `npm run sync:previews` after changing the native bundles or source captures. Generated preview assets are checked in, so the Pages build does not need to install the mobile dependencies.

Run `npm run check:previews` in the app checkout to verify that the saved demo and both renderer bundles match the mobile sources. Syncing also records snapshot hashes in `public/previews/manifest.json`; Pages tests verify those hashes, JavaScript syntax, and exact exported assets without depending on unmerged mobile app changes.

Animations respect reduced motion, and the lyric timer stops when the preview leaves the viewport or the tab is hidden. Interactive controls have accessible names, keyboard focus indicators, and explicit pressed states. FAQ answers use native disclosures. Core content and download links are rendered into the HTML for search engines and browsers without JavaScript.

Fonts are served locally. No analytics, tracking scripts, or external font requests are included.

Social metadata, a canonical URL, robots rules, a sitemap, and SoftwareApplication structured data are included. Do not add fabricated ratings or unverified performance claims.
