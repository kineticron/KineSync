# Contributing to KineSync

Thanks for your interest in contributing! This project is a two-component system (Electron desktop bridge + Expo mobile app) for real-time synced Spotify karaoke lyrics on mobile.

Although Expo allows the frontend to run on web, the app is **not** designed for web and will have weird formatting issues, especially with the text reveal. It is recommended to test changes on both iOS (through Expo Go or native gh actions builds) and an Android emulator. Launching the Expo development server via `npx expo start -c --tunnel` will allow you to access the app through either of those options in a user-friendly way while opening the dev server over an ngrok tunnel for access off of local networks.

If possible, do try to test with ngrok relay **ON**.

## Getting Started

1. Fork and clone the repository
2. Follow [SETUP.md](SETUP.md) for development environment setup
3. Make changes on a feature branch

## Development Workflow

### Desktop Bridge

- The main process is in `DesktopBridge/src/index.js`
- The renderer UI is `DesktopBridge/src/index.html`
- Lyrics service logic lives in `DesktopBridge/src/lyrics/parts/`
- Run `node --check` on changed files before committing

#### Playback API

This project assumes that users do not have access to Spotify Web API as it requires a Premium subscription. Additionally, it also assumes you are using Spotify on all devices with an active internet connection.

To avoid using the Web API, a native media session watcher is used. This makes it so that the desktop bridge can only be installed on Windows or Windows server. Native extrapolation on top of GSMTC makes it so that timing is super accurate.

There is a bug in Spotify in which when you go to the next song it pushes the playback clock about a second forward as part of a failure to adjust for Bluetooth and audio device delays. This cannot be fixed other than by pausing and unpausing to resync Spotify's clock. As such, holding the pause button in Expo quickly sends an pause/unpause request for your convenience.

#### Adding a source / testing coverage

- The Desktop Bridge UI contains access to coverage candidate testing using the API keys + Spotify OAuth you have entered into the app and is the recommended method for testing lyrics coverage.
- You can export TTML lyrics through the bridge to check parsing and true timing data. It is recommended to use the local TTML options available in Spicy Lyrics to check a preview.
- For editing TTML lyrics yourself, please check [this guide](https://lyrprep.spicylyrics.org/guide) provided by Spicy Lyrics.

#### Sources Available

Listed in order of priority. You can manually select any source you want.

**Karaoke**

All karaoke sources are preferred over any line source.

1. Local Vault (local-vault-karaoke)
   > The local vault stores files in JSON and compressed TTML. Everything is indexed, easily searchable, and lyrics returns are near-instant.
2. Spicy Lyrics Syllable (spicy-lyrics-syllable)
   > The client is officially built to handle all lyrics-renderable elements of Spicy Lyrics since it is the most featured of the lyrics sources. Natively contains background lyrics, indepdendent and concurrent lyric streams, and all Apple Music TTML/Karaoke features. It is recommended that you test for this first. Lookup is via Spotify ID, which is obtained via Spotify partner search API. Reliably syllable synced. Requires Spotify OAuth to obtain Bearer token -- without the bearer token, all lyrics will be static. Lyrics return in 1-2s.
3. Kugou KRC (kugou-krc)
   > The official lyrics source for Kugou music. It uses a proprietary format that is easier to parse and gets most of its lyrics from qq-musicu-qrc, but is generally more reliable and more centered around east Asian music. Supports only one concurrent lyrics stream but is generally reliable and pleasant to use and can present a few extra options as compared to QQ Music. Heavily censored as it is a Chinese API. Can return syllable, but mostly returns word-synced. Lyrics return in 2-3s.
4. QQ Music QRC (qq-musicu-qrc)
   > Very reliable and the broadest karaoke source, but can lack certain lyrics nuances (e.g. will not have adlibs in parenthesis most of the time and will default to just having adlibs as separate lines, lacks punctuation in certain scenarios). Heavily censored as it is a Chinese API. Can return syllable, but mostly returns word-synced. Lyrics return in 3-8s, depending on coverage scenario.
5. Netease YRC (netease-yrc)
   > Can have certain niche tracks that qq-musicu-qrc doesn't. Very hard format to parse as censorship markers and punctuation interfere with spacing. Can sometimes be more inaccurate, but lyrics themselves are typically higher quality (have punctuation and proper adlib support). Can return syllable, but mostly returns word-synced. Lyrics return in 3-4s.
6. Musixmatch RichSync (musixmatch-richsync)
   > Contains user-generated lyrics and an extremely broad catalogue that covers mostly niche western and popular artists. Requires an user token. Desktop keys tend to be more reliable than mobile user keys for this service. Often gets rate-limited under regular use (despite protections and caching), so client will disable the source for 20 minutes if the client is rate-limited. Because lyrics are user-generated, word durations and sync is often the most inaccurate. Lyrics return near-instant.

**Line**

All line lyrics are interpolated by the Expo frontend to render as word-synced lyrics, which works most of the time for a wide variety of songs, especially when a high priority line source is selected.

Word synced lyrics split across spaces, which will break for some foreign languages without native support. Please see Localization.

1. Local Vault (local-vault-line)
   > The local vault can be used to store line lyrics, although this is not super recommended. Might be useful if you wanted to save a translation, but fairly impractical.
2. Spicy Lyrics Line (spicy-lyrics-line)
   > Supports all Apple Music TTML features. Can support overlapping lyrics lines due to having explicit line end times. See spicy-lyrics-syllable. Sometimes has a visually better interpolated sync than Musixmatch RichSync and Netease YRC.
3. Musixmatch
4. Netease
5. QQ Music Direct (disabled in most contexts)
6. Lrclib (lrclib-fallback)

### Expo App

- Routes are in `ExpoLyrics/app/`
- Components in `ExpoLyrics/components/`
- Run `npx tsc --noEmit` before committing
- Enable the status bar by holding the eye icon in the playback controls. Disabled by default.

### Before Submitting

- Verify no personal references or secrets in the code
- Check that all file sizes are reasonable (<2000 lines unless justified)
- Run syntax/type checks on changed components
- Test with actual Spotify playback if making lyrics service changes

## Code Guidelines

- Keep files focused and under 2000 lines where possible
- The Desktop Bridge lyrics service uses a shared VM context — top-level declarations become global
- Prefer small, surgical changes over large refactors
- Document non-obvious behavior with comments

## Localization

Thank you for choosing to contribute with your language skills. It is greatly appreciated. Please include localization changes in the form of a pull request.

Some assumptions are made in the frontend AND backend code which break consistently across different languages. It is highly recomnended you understand the parsing code for the backend AND the frontend rendering logic for all syllable in order to ensure a proper and fair localization experience.

**It is politely requested that you do not use AI when localizing for a language since it is a complex task due to the rendering demands of the app.**

### Supported Languages

The UI for both the expo app and the desktop bridge are built entirely for English.

Documentation is built natively for English.

The expo frontend is built and tested to handle Latin and Korean (Hangul) characters and formatting.

Translation on the backend works by prompting an LLM. This prompt includes instructions to translate in English exclusively.

### Things to know before Localization

As an example of a language/script which is not yet supported, this section will focus on Thai. A wide variety of Thai synced lyrics can be found in both spicy-lyrics-syllable and qq-musicu-qrc.

Note: Keep in mind that as I am writing this section, I do not know Thai and will therefore be using AI and translation tools to generate examples. I apologize in advance for any misinterpretations / mistranslations. Contributors may also want to consider localizing this guide.

**1. Words from line sources are extracted via spaces.**
This seems intuitive for latin and hangul script, but it doesn't work for languages whose writing systems do not separate words with spaces. Thai script specifically doesn't work because they don't include spaces within clauses.
_Ex: ฉันรักภาษาไทย --> I love the Thai language | The sentence has 4 Thai words but doesn't have any spaces_
This can make super long "words" (which are really advanced clauses) which causes issues with the emphasized word rendering system as it's built to handle shorter words. It also usually breaks text wrapping.
For proper localization, word-segmentation needs to be language and context-aware. Since lyrics often have multiple languages and scripts mixed together, it also needs to distinguish fairly between them.

**2. Text animations assume every visible character is an independent glyph.**
The emphasis animation frequently scales or otherwise transforms individual characters over time. This generally works for Latin alphabets but breaks for scripts where multiple Unicode code points combine into a single displayed character.
Thai has lots of tone markers, vowel signs, and additional diacritics on top of a base consonant and those are not meant to be rendered independently. Especially during size changes, the diacritics will separate from their main character.

**3. Backend parsing is optimized for English and doesn't look for extra information.**
Since the backend parsing is optimized for English, the backend may automatically drop provider boundary information which could be crucial to language parsing.
Thai, depending on the provider, may have different indicated syllable bounds. A robust system would ideally segment it itself if the language's boundaries are not based on whitespace.

## Questions?

Open an issue on GitHub for bugs & feature requests.
Email: kineticrondev@gmail.com
Twitter/X: @kineticron

## Special Thanks

Example:

```
@kineticron [GitHub](https://github.com/...) [Twitter](https://x.com/...)
- Coded the first version of the lyrics app
- Localized for English & Korean
```

For any developers / localization contributors who:

1. Implement a major feature
2. Contribute support for an entire language/script

Please modify this file in your PR if you feel you meet these requirements.
