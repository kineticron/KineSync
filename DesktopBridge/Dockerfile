# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS node-runtime

WORKDIR /opt/kinesync
COPY docker/runtime/package.json docker/runtime/package-lock.json ./
RUN --mount=type=secret,id=build_ca \
    if [ -f /run/secrets/build_ca ]; then \
      export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; \
    fi && \
    npm ci && npm cache clean --force

FROM ghcr.io/linuxserver/baseimage-kasmvnc:ubuntunoble

ARG TARGETARCH
ARG SPOTIFY_VERSION=1.2.95.453.g0eeebbed
ARG SPICETIFY_VERSION=2.44.0
ARG ADBLOCKIFY_COMMIT=64cb2b8c235b13cf943e4c265c19199f69e5d170
ARG SPICETIFY_MARKETPLACE_VERSION=1.0.9
ARG SPICETIFY_MARKETPLACE_COMMIT=332cdeb2c82285be333fc6b203955fd38a912886
ENV CUSTOM_PORT=3000 \
    CUSTOM_HTTPS_PORT=3443 \
    TITLE="KineSync + Spotify" \
    FM_HOME=/config \
    START_DOCKER=false \
    NO_FULL=true \
    MEDIA_SESSION_PROVIDER=mpris \
    SPICETIFY_VERSION=${SPICETIFY_VERSION} \
    ADBLOCKIFY_COMMIT=${ADBLOCKIFY_COMMIT} \
    SPICETIFY_MARKETPLACE_VERSION=${SPICETIFY_MARKETPLACE_VERSION} \
    SPICETIFY_MARKETPLACE_COMMIT=${SPICETIFY_MARKETPLACE_COMMIT}

ADD --checksum=sha256:256e2eb1ec96fbc0c51afab247298e4e6eabfabbafafd4617584f44cca2fb31f \
    https://repository.spotify.com/pool/non-free/s/spotify-client/spotify-client_${SPOTIFY_VERSION}_amd64.deb \
    /tmp/spotify-client.deb

ADD --checksum=sha256:115045610a609a2084af389e65aa4f60351a4b8ef1497ce98bdbdf379544ef9b \
    https://github.com/spicetify/cli/releases/download/v${SPICETIFY_VERSION}/spicetify-${SPICETIFY_VERSION}-linux-amd64.tar.gz \
    /tmp/spicetify.tar.gz

ADD --checksum=sha256:b607243a02a799bba8e40289ff1e5d8b632b885ddfee951aaaf1c3d733e8001b \
    https://raw.githubusercontent.com/rxri/spicetify-extensions/${ADBLOCKIFY_COMMIT}/adblock/adblock.js \
    /opt/kinesync-assets/adblock.js

ADD --checksum=sha256:2713054703c2365e391658a58c782dd2ebdd8d573f2015b5a2bab58b7eee8685 \
    https://github.com/spicetify/marketplace/releases/download/v${SPICETIFY_MARKETPLACE_VERSION}/marketplace.zip \
    /tmp/spicetify-marketplace.zip

ADD --checksum=sha256:802c83f4f822eb254f60ef34ea8c53ea9d97889b9e886ac532e42953b9548fb2 \
    https://raw.githubusercontent.com/spicetify/marketplace/${SPICETIFY_MARKETPLACE_COMMIT}/resources/color.ini \
    /opt/kinesync-assets/marketplace-color.ini

RUN test "${TARGETARCH:-amd64}" = "amd64" && \
    apt-get update && \
    apt-get install -y --no-install-recommends dbus-x11 libnss3-tools playerctl unzip /tmp/spotify-client.deb && \
    mkdir -p /opt/spicetify \
      /opt/kinesync-spicetify-home/.config/spicetify/Extensions \
      /opt/kinesync-spicetify-home/.config/spicetify/CustomApps \
      /opt/kinesync-spicetify-home/.config/spicetify/Themes/marketplace && \
    tar -xzf /tmp/spicetify.tar.gz -C /opt/spicetify && \
    chmod 0755 /opt/spicetify/spicetify && \
    ln -s /opt/spicetify/spicetify /usr/local/bin/spicetify && \
    cp /opt/kinesync-assets/adblock.js /opt/kinesync-spicetify-home/.config/spicetify/Extensions/adblock.js && \
    unzip -q /tmp/spicetify-marketplace.zip -d /tmp/spicetify-marketplace && \
    mv /tmp/spicetify-marketplace/marketplace-dist \
      /opt/kinesync-spicetify-home/.config/spicetify/CustomApps/marketplace && \
    cp /opt/kinesync-assets/marketplace-color.ini \
      /opt/kinesync-spicetify-home/.config/spicetify/Themes/marketplace/color.ini && \
    printf 'app.last-launched-version="%s"\n' "$SPOTIFY_VERSION" > /opt/kinesync-spicetify-home/spotify-prefs && \
    HOME=/opt/kinesync-spicetify-home XDG_CONFIG_HOME=/opt/kinesync-spicetify-home/.config \
      spicetify --bypass-admin config spotify_path /usr/share/spotify \
        prefs_path /opt/kinesync-spicetify-home/spotify-prefs \
        check_spicetify_update 0 extensions adblock.js custom_apps marketplace \
        inject_css 1 replace_colors 1 current_theme marketplace && \
    HOME=/opt/kinesync-spicetify-home XDG_CONFIG_HOME=/opt/kinesync-spicetify-home/.config \
      spicetify --bypass-admin backup apply && \
    chmod -R a+rX /usr/share/spotify && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/* /tmp/spotify-client.deb /tmp/spicetify.tar.gz \
      /tmp/spicetify-marketplace.zip /tmp/spicetify-marketplace

WORKDIR /opt/kinesync
COPY --from=node-runtime /opt/kinesync/node_modules ./node_modules
COPY . .
COPY docker/root /

RUN chmod +x \
      /defaults/autostart \
      /usr/local/bin/start-kinesync \
      /usr/local/bin/start-kinesync-bridge \
      /usr/local/bin/kinesync-open-url && \
    chown -R abc:abc /opt/kinesync

EXPOSE 3000 3001 3443
VOLUME ["/config"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 \
  CMD ["node", "/opt/kinesync/scripts/container-healthcheck.js"]
