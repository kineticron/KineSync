FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS node-runtime

WORKDIR /opt/kinesync
COPY docker/runtime/package.json docker/runtime/package-lock.json ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then \
      export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; \
    fi && \
    npm ci && npm cache clean --force

FROM ubuntu:24.04@sha256:1e0a86e57d247923571b75e0aaf48a1449cf8c543d51fb3e07a4a7d7bfa79316

ARG TARGETARCH
ARG VCS_REF=unknown
ARG XPRA_VERSION=6.5.3-r0-1
ARG SPICETIFY_VERSION=2.46.7
ARG ADBLOCKIFY_COMMIT=64cb2b8c235b13cf943e4c265c19199f69e5d170
ARG SPICETIFY_MARKETPLACE_VERSION=1.0.9
ARG SPICETIFY_MARKETPLACE_COMMIT=332cdeb2c82285be333fc6b203955fd38a912886
ENV HOME=/config \
    XDG_CONFIG_HOME=/config/.config \
    KINESYNC_CONTAINER=true \
    MEDIA_SESSION_PROVIDER=mpris \
    SPICETIFY_VERSION=${SPICETIFY_VERSION} \
    ADBLOCKIFY_COMMIT=${ADBLOCKIFY_COMMIT} \
    SPICETIFY_MARKETPLACE_VERSION=${SPICETIFY_MARKETPLACE_VERSION} \
    SPICETIFY_MARKETPLACE_COMMIT=${SPICETIFY_MARKETPLACE_COMMIT}

LABEL org.opencontainers.image.title="KineSync Desktop Bridge" \
      org.opencontainers.image.description="Self-contained KineSync Desktop Bridge with Spotify and seamless native windows" \
      org.opencontainers.image.source="https://github.com/Kineticron/KineSync" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="GPL-3.0-only"

ADD --checksum=sha256:be73b8c82c445f0d5425ef6044d5d46330fb7a3413d81031225c71bba55bb3e2 \
    https://github.com/spicetify/cli/releases/download/v${SPICETIFY_VERSION}/spicetify-${SPICETIFY_VERSION}-linux-amd64.tar.gz \
    /tmp/spicetify.tar.gz

ADD --checksum=sha256:b607243a02a799bba8e40289ff1e5d8b632b885ddfee951aaaf1c3d733e8001b \
    https://raw.githubusercontent.com/rxri/spicetify-extensions/${ADBLOCKIFY_COMMIT}/adblock/adblock.js \
    /opt/kinesync-assets/adblock.js

ADD --checksum=sha256:749fd8894f53a403e2a06ae8793a4318131443c7ca14f3656d841b7613c1cef3 \
    https://raw.githubusercontent.com/rxri/spicetify-extensions/${ADBLOCKIFY_COMMIT}/LICENSE \
    /opt/kinesync-assets/LICENSE-adblockify

ADD --checksum=sha256:2713054703c2365e391658a58c782dd2ebdd8d573f2015b5a2bab58b7eee8685 \
    https://github.com/spicetify/marketplace/releases/download/v${SPICETIFY_MARKETPLACE_VERSION}/marketplace.zip \
    /tmp/spicetify-marketplace.zip

ADD --checksum=sha256:802c83f4f822eb254f60ef34ea8c53ea9d97889b9e886ac532e42953b9548fb2 \
    https://raw.githubusercontent.com/spicetify/marketplace/${SPICETIFY_MARKETPLACE_COMMIT}/resources/color.ini \
    /opt/kinesync-assets/marketplace-color.ini

RUN export DEBIAN_FRONTEND=noninteractive && \
    apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg && \
    rm -rf /var/lib/apt/lists/*

ADD --checksum=sha256:4df3209ea4b759f0b5838b60baedb6893ec62df7abad9046462176a6e6a7ed7d \
    https://xpra.org/xpra.asc /usr/share/keyrings/xpra.asc

ADD --checksum=sha256:43307ca6b67ebeeeafbb02f543643a4cfc94548da17e26b0ac07bfdd335e4158 \
    https://raw.githubusercontent.com/Xpra-org/xpra/44af22e9239985e4b41b4b315b76bd490f733808/packaging/repos/noble/xpra.sources \
    /etc/apt/sources.list.d/xpra.sources

RUN gpg --dearmor --yes --output /usr/share/keyrings/xpra.gpg /usr/share/keyrings/xpra.asc && \
    sed -i 's#xpra.asc#xpra.gpg#' /etc/apt/sources.list.d/xpra.sources

ADD --checksum=sha256:5fcf07069e1ab0c8e823dbdf6fa16d7bdbe0bc4f224af8a42a2d3ec02f092773 \
    https://download.spotify.com/debian/pubkey_5384CE82BA52C83A.asc \
    /usr/share/keyrings/spotify.asc

RUN chmod 0644 /usr/share/keyrings/spotify.asc && \
    printf '%s\n' 'deb [arch=amd64 signed-by=/usr/share/keyrings/spotify.asc] https://repository.spotify.com stable non-free' \
      > /etc/apt/sources.list.d/spotify.list

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY scripts/resolve-spotify-version.js /tmp/resolve-spotify-version.js
# CI supplies a new value per run to fetch a fresh APT index, then reuses it for export.
ARG SPOTIFY_REPOSITORY_REFRESH
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN test "${TARGETARCH:-amd64}" = "amd64" && \
    export DEBIAN_FRONTEND=noninteractive && \
    mkdir -p /opt/spicetify && \
    tar -xzf /tmp/spicetify.tar.gz -C /opt/spicetify && \
    chmod 0755 /opt/spicetify/spicetify && \
    ln -s /opt/spicetify/spicetify /usr/local/bin/spicetify && \
    installed_spicetify="$(spicetify --version 2>&1)" && \
    test "$installed_spicetify" = "$SPICETIFY_VERSION" && \
    curl --fail --silent --show-error --location --retry 3 \
      "https://api.github.com/repos/spicetify/cli/releases/tags/v${installed_spicetify}" \
      --output /tmp/spicetify-release.json && \
    apt-get update -o APT::Update::Error-Mode=any && \
    spotify_version="$(apt-cache madison spotify-client:amd64 | \
      node /tmp/resolve-spotify-version.js "$installed_spicetify" /tmp/spicetify-release.json)" && \
    printf 'Installing Spotify %s for Spicetify %s\n' "$spotify_version" "$installed_spicetify" && \
    apt-get install -y --no-install-recommends \
      ca-certificates dbus-x11 findutils fonts-liberation libasound2t64 \
      libatk-bridge2.0-0t64 libatspi2.0-0t64 libcups2t64 libdrm2 libgbm1 \
      libgtk-3-0t64 libnotify4 libnss3 libnss3-tools libxkbcommon0 libxss1 \
      libxtst6 playerctl procps tini unzip xauth xdg-utils xdotool \
      "xpra=${XPRA_VERSION}" "xpra-common=${XPRA_VERSION}" \
      "xpra-client=${XPRA_VERSION}" "xpra-client-gtk3=${XPRA_VERSION}" \
      "xpra-server=${XPRA_VERSION}" "xpra-codecs=${XPRA_VERSION}" \
      "xpra-x11=${XPRA_VERSION}" \
      "spotify-client:amd64=${spotify_version}" && \
    installed_spotify="$(dpkg-query -W -f='${Version}' spotify-client:amd64)" && \
    test "$installed_spotify" = "$spotify_version" && \
    groupadd --gid 568 abc && \
    useradd --uid 568 --gid 568 --create-home --home-dir /config --shell /bin/bash abc && \
    mkdir -p /opt/spicetify \
      /opt/kinesync-spicetify-home/.config/spicetify/Extensions \
      /opt/kinesync-spicetify-home/.config/spicetify/CustomApps \
      /opt/kinesync-spicetify-home/.config/spicetify/Themes/marketplace && \
    cp /opt/kinesync-assets/adblock.js /opt/kinesync-spicetify-home/.config/spicetify/Extensions/adblock.js && \
    unzip -q /tmp/spicetify-marketplace.zip -d /tmp/spicetify-marketplace && \
    mv /tmp/spicetify-marketplace/marketplace-dist \
      /opt/kinesync-spicetify-home/.config/spicetify/CustomApps/marketplace && \
    cp /opt/kinesync-assets/marketplace-color.ini \
      /opt/kinesync-spicetify-home/.config/spicetify/Themes/marketplace/color.ini && \
    printf 'app.last-launched-version="%s"\n' "${installed_spotify#*:}" > /opt/kinesync-spicetify-home/spotify-prefs && \
    HOME=/opt/kinesync-spicetify-home XDG_CONFIG_HOME=/opt/kinesync-spicetify-home/.config \
      spicetify --bypass-admin config spotify_path /usr/share/spotify \
        prefs_path /opt/kinesync-spicetify-home/spotify-prefs \
        check_spicetify_update 0 extensions adblock.js custom_apps marketplace \
        inject_css 1 replace_colors 1 current_theme marketplace && \
    HOME=/opt/kinesync-spicetify-home XDG_CONFIG_HOME=/opt/kinesync-spicetify-home/.config \
      spicetify --bypass-admin backup apply && \
    grep -Fq "src='extensions/adblock.js'" /usr/share/spotify/Apps/xpui/index.html && \
    cmp /opt/kinesync-assets/adblock.js /usr/share/spotify/Apps/xpui/extensions/adblock.js && \
    node --check /usr/share/spotify/Apps/xpui/extensions/adblock.js && \
    chmod -R a+rX /usr/share/spotify && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/spicetify.tar.gz /tmp/spicetify-release.json /tmp/resolve-spotify-version.js \
      /tmp/spicetify-marketplace.zip /tmp/spicetify-marketplace

WORKDIR /opt/kinesync
COPY --from=node-runtime /opt/kinesync/node_modules ./node_modules
COPY . .
COPY docker/root /

RUN sed -i 's/\r$//' \
      /usr/local/bin/kinesync-entrypoint \
      /usr/local/bin/start-kinesync \
      /usr/local/bin/start-kinesync-session \
      /usr/local/bin/start-kinesync-bridge \
      /usr/local/bin/kinesync-open-url && \
    chmod +x \
      /usr/local/bin/kinesync-entrypoint \
      /usr/local/bin/start-kinesync \
      /usr/local/bin/start-kinesync-session \
      /usr/local/bin/start-kinesync-bridge \
      /usr/local/bin/kinesync-open-url && \
    chown -R abc:abc /opt/kinesync

EXPOSE 3001 14500
VOLUME ["/config"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/kinesync-entrypoint"]
CMD ["/usr/local/bin/start-kinesync"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 \
  CMD ["node", "/opt/kinesync/scripts/container-healthcheck.js"]
