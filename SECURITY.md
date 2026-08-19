# Security Policy

## Supported versions

Security fixes are released against the latest version on the default branch
and the latest tagged release. Please upgrade before reporting a problem; old
tags may contain known vulnerable dependencies or stale native binaries.

## Installation and provenance

- Use the source repository or a tagged GitHub release. Do not download native
  binaries from a third-party mirror.
- Windows native release assets are checked against GitHub's SHA-256 metadata
  and the versioned `native-assets-v<version>.json` manifest before an install.
  A missing or mismatched digest intentionally falls back to the documented
  source build instead of installing an unverified file.
- Docker base images and downloaded build inputs must be reviewed and pinned by
  digest before publishing an image. See [DOCKER.md](DOCKER.md).
- Keep `BRIDGE_KEY`, web credentials, Spotify cookies, and `/config` private.
  Do not paste them into issues, logs, or support requests.

## Reporting a vulnerability

Please email `kineticrondev@gmail.com` with the subject:

`SECURITY TICKET KineSync -- <short description>`

Do not create a public GitHub issue for an unpatched or credential-related
vulnerability. Include the affected version/commit, deployment mode (desktop
or Docker), operating system, and safe reproduction steps. Redact secrets and
personal data; attach logs or media only after removing credentials, tokens,
cookies, and private URLs.

You should receive an acknowledgement within 3 business days. We will
coordinate a fix, release, and disclosure timeline with the reporter.

For ordinary setup or support questions, use a normal GitHub issue and include
the sanitized diagnostics requested in the issue template.
