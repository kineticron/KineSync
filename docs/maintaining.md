# GitHub and project maintenance

## Repository configuration

The repository description should mention Android/iOS, synchronized Spotify lyrics, and the optional bridge. Use the README install section as the homepage until a dedicated project site exists. Relevant topics include Android, iOS, Expo, React Native, lyrics, karaoke, TTML, Spotify, Electron, and self-hosting.

The public issue tracker is the support channel. Issue forms collect reproducible reports. The PR template asks for behavior, validation, and limitations. CODEOWNERS names the existing repository maintainer, not an invented team. Do not add badges for coverage, security, or performance results that the project does not publish.

## Pull-request checks and protection

The `CI` workflow runs on pull requests, pushes to `main`, and manual dispatch. Its job names are **Repository**, **Desktop**, and **Mobile**. It uses read-only permissions, pinned actions, no release secrets, and no privileged `pull_request_target` execution. Release packaging remains in separate platform workflows.

After the new CI workflow has landed and completed once, configure a `main` ruleset to require these actual check names. Restrict force pushes and deletion, require review for outside contributors, dismiss stale approvals when appropriate, and allow a documented maintainer emergency bypass. Requiring unknown checks before the workflow exists can prevent all merges. Branch/ruleset settings are not enabled by adding a workflow file. Verify them in GitHub Settings.

The audit found `main` unprotected. Basic protection now disallows force pushes
and branch deletion, with the existing administrator bypass retained. Required
checks and review requirements remain unset until the new CI checks exist
remotely. Existing version tags are not changed. The revised publisher refuses
to move them.

## Dependencies and workflow maintenance

Dependabot proposes updates for GitHub Actions, npm packages, and the Docker base image. Mobile runtime packages are grouped because Expo, React Native, and their native modules need compatibility review together. Do not automatically merge runtime upgrades solely because JavaScript tests pass: verify native builds and device behavior. Security updates may require a coordinated SDK upgrade.

Actions use full commit SHAs. Workflow validation uses actionlint 1.7.12 with a verified archive checksum. `.github/actionlint.yaml` recognizes the current Xcode preview runner. Read syntax errors and expression errors as failures. External shell lint tools are not required by this check. Upgrade the validator and its checksum together.

Repository checks validate local Markdown targets and heading anchors, required community files, action pinning, default workflow permissions, and accidentally tracked environment/signing files. They do not scan secret contents, check every external website, or replace GitHub secret scanning and a security review.

## Security reporting

Private vulnerability reporting, dependency alerts, and automated security-fix proposals were enabled during the repository audit. These are live GitHub settings, separate from the files in the checkout. [SECURITY.md](../SECURITY.md) provides the maintainer's email fallback. Verify alert handling and private reporting periodically. Enabled controls do not imply that all vulnerabilities are resolved.

## Documentation and licensing

The [project website](https://kineticron.github.io/KineSync/) is a static Next.js
export in [website](../website/README.md). Its separate Website workflow builds
pull requests and deploys trusted pushes through GitHub Pages. Run the export
tests after a production build to check metadata, asset paths, and size budgets.
Keep the live download names aligned with release assets. Preserve reduced
motion support and pause preview animations while hidden or offscreen.

Use the [documentation index](README.md) as the entry point. Keep installation guides about supported current behavior. Label investigation notes as historical. Do not imply that Expo Go covers native widgets, that debug performance represents release performance, or that provider terms permit every implemented export feature.

Documentation avoids em dashes and semicolons. Repository checks enforce this
for Markdown, including release notes. Use GitHub callouts for practical tips,
collapsible sections for secondary detail, and descriptive links for navigation.
Decorative badges should state verifiable capabilities rather than unmeasured
quality claims.

The root license covers GPL Desktop Bridge code. The mobile app already declares AGPL and includes an AGPL license file. Preserve component boundaries and upstream notices. Adding a dependency or copying source requires license compatibility and attribution review. The source declaration is not a substitute for reviewing notices in packaged distributions.

Release notes belong in `RELEASE_NOTES/v<version>.md`. Use the process in [RELEASES.md](../RELEASES.md). Document unresolved limitations explicitly instead of inventing guarantees, a roadmap, or a history of releases.
