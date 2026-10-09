'use client'

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { motion, MotionConfig, useInView, useReducedMotion } from 'motion/react'
import {
  ArrowDown,
  ArrowRight,
  Download,
  FileMusic,
  FileDown,
  Pause,
  Play,
  Smartphone,
  Check,
  Star,
  Users,
  Scale,
  Activity
} from 'lucide-react'
import lyrics from './demo-lyrics.json'
import projectStats from './project-stats.json'
import spicyScale from './spicy-scale.json'

const repo = 'https://github.com/Kineticron/KineSync'
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '/KineSync'
const spring = { type: 'spring' as const, damping: 18, stiffness: 240 }
const duration = 25000

function ProjectStats() {
  const deck = useRef<HTMLDivElement>(null)
  const visible = useInView(deck)
  const reduce = useReducedMotion()
  const snapshotDate = new Date(projectStats.updatedAt).toLocaleDateString(
    'en-US',
    {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC'
    }
  )
  const cards = [
    {
      key: 'stars',
      label: 'GitHub stars',
      value: String(projectStats.stars),
      icon: Star,
      href: `${repo}/stargazers`,
      detail: 'A little love for KineSync'
    },
    {
      key: 'contributors',
      label: 'Contributors',
      value: String(projectStats.contributors),
      icon: Users,
      href: `${repo}/graphs/contributors`,
      detail: 'You could be next'
    },
    {
      key: 'license',
      label: 'Open-source license',
      value: projectStats.license,
      icon: Scale,
      href: `${repo}/blob/main/LICENSE`,
      detail: 'Free to study. Free to build.'
    },
    {
      key: 'cadence',
      label: 'Always in motion',
      value: projectStats.cadence.days
        ? `~${projectStats.cadence.days} days`
        : 'Growing',
      icon: Activity,
      href: `${repo}/releases`,
      detail: projectStats.cadence.days
        ? `One update every ~${projectStats.cadence.days} days`
        : 'Follow the latest releases'
    }
  ]
  return (
    <div
      className="project-stats"
      ref={deck}
      aria-label="KineSync project statistics"
    >
      <div className="stats-light" aria-hidden="true" />
      {cards.map(({ key, label, value, icon: Icon, href, detail }, index) => (
        <motion.a
          className={`stat-window stat-${key} glass`}
          key={key}
          href={href}
          animate={{ y: visible && !reduce ? [0, -8, 0] : 0 }}
          transition={{
            y: {
              duration: 5 + index * 0.7,
              repeat: visible && !reduce ? Infinity : 0,
              ease: 'easeInOut'
            }
          }}
          whileHover={reduce ? undefined : { scale: 1.025, transition: spring }}
        >
          <div className="window-chrome" aria-hidden="true">
            <i />
            <i />
            <i />
            <Icon size={16} />
          </div>
          <div className="stat-content">
            <span className="stat-label">{label}</span>
            <strong>{value}</strong>
            <span className="stat-detail">{detail}</span>
            {key === 'cadence' && (
              <small>
                Average · {projectStats.cadence.releases} releases in the last{' '}
                {projectStats.cadence.windowDays} days
              </small>
            )}
          </div>
        </motion.a>
      ))}
      <a href={repo} className="stats-snapshot">
        GitHub snapshot · {snapshotDate} <ArrowRight size={13} />
      </a>
    </div>
  )
}

function GitHubIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.1c-3.13.68-3.79-1.33-3.79-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.02-.7.08-.68.08-.68 1.13.08 1.72 1.16 1.72 1.16 1 1.71 2.62 1.22 3.26.93.1-.72.4-1.22.71-1.5-2.5-.29-5.13-1.26-5.13-5.56 0-1.23.44-2.23 1.16-3.02-.12-.29-.5-1.43.11-2.98 0 0 .95-.3 3.1 1.15a10.76 10.76 0 0 1 5.63 0c2.15-1.45 3.1-1.15 3.1-1.15.61 1.55.23 2.69.11 2.98.72.79 1.16 1.79 1.16 3.02 0 4.31-2.63 5.27-5.14 5.55.41.35.76 1.03.76 2.08v3.1c0 .3.21.65.78.54A11.25 11.25 0 0 0 12 .75Z" />
    </svg>
  )
}

function Brand() {
  return (
    <a href="#main" className="brand">
      <img src={`${basePath}/app-icon.png`} width="34" height="34" alt="" />
      KineSync
    </a>
  )
}

const heroHeadline = 'Lyrics Synced to Your Spotify. All Your Devices.'
const heroIntro = 'The Free Lyrics Companion App for iOS and Android'
const heroSubtitles = [
  'Beautiful, word-by-word Spotify lyrics.',
  '100% free. No Spotify Premium needed.'
]
const heroFocusDelay = 0.1
const heroFocusDuration = 0.65
const heroLeadIn = heroFocusDelay + heroFocusDuration
const heroSecondsPerCharacter = 0.028
const heroWordOverlap = 0.12
const heroSubtitleDuration = 0.55
const spicyWordStep = 0.18
const spicyWordOverlap = 0.035
const spicyLineDuration = (text: string) =>
  text.split(' ').length * spicyWordStep + spicyWordOverlap

function LyricText({
  children,
  delay,
  renderer = 'amll',
  duration = (children.length + 1) * heroSecondsPerCharacter + heroWordOverlap
}: {
  children: string
  delay: number
  duration?: number
  renderer?: 'amll' | 'spicy'
}) {
  const line = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    // Spicy uses explicit word beats, rather than AMLL's shared line sweep.
    if (renderer === 'spicy') return
    const element = line.current
    if (!element) return
    const words = Array.from(
      element.querySelectorAll<HTMLElement>('.hero-lyric-word')
    )
    const measure = () => {
      // Layout dimensions stay stable while the title scales into focus.
      const widths = words.map((word) => word.offsetWidth)
      const totalWidth = widths.reduce((sum, width) => sum + width, 0)
      if (!totalWidth) return
      // Match AMLL's height-based feather and shared travel across words.
      const fadeWidth = words[0].offsetHeight * 0.56
      const speed = (totalWidth + fadeWidth) / duration
      let distance = 0
      words.forEach((word, index) => {
        word.style.setProperty('--lyric-feather', `${fadeWidth}px`)
        word.style.setProperty('--lyric-delay', `${delay + distance / speed}s`)
        word.style.setProperty(
          '--lyric-duration',
          `${(widths[index] + fadeWidth) / speed}s`
        )
        distance += widths[index]
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    words.forEach((word) => observer.observe(word))
    return () => observer.disconnect()
  }, [children, delay, duration, renderer])
  let elapsed = delay
  return (
    <span className={`hero-lyric-line hero-lyric-${renderer}`} ref={line}>
      {children.split(' ').map((word, index) => {
        const wordStep =
          renderer === 'spicy'
            ? spicyWordStep
            : ((word.length + 1) / (children.length + 1)) *
              (duration - heroWordOverlap)
        const wordDuration =
          wordStep + (renderer === 'spicy' ? spicyWordOverlap : heroWordOverlap)
        const wordDelay = elapsed
        elapsed += wordStep
        return (
          <span key={`${index}-${word}`}>
            {index > 0 ? ' ' : null}
            <span
              className="hero-lyric-word"
              style={
                {
                  '--lyric-delay': `${wordDelay}s`,
                  '--lyric-duration': `${wordDuration}s`
                } as CSSProperties
              }
            >
              <span className="hero-lyric-rest">{word}</span>
              <span className="hero-lyric-fill" aria-hidden="true">
                {word}
              </span>
            </span>
          </span>
        )
      })}
    </span>
  )
}

type NativeWindow = Window & {
  KineSyncLyrics?: { receive: (message: Record<string, unknown>) => void }
}

function LyricsDemo() {
  const [engine, setEngine] = useState<'spicy' | 'amll'>('spicy')
  const [playing, setPlaying] = useState(false)
  const [ready, setReady] = useState(false)
  const [visible, setVisible] = useState(true)
  const [position, setPosition] = useState(0)
  const positionRef = useRef(0)
  const frame = useRef<HTMLIFrameElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const inView = useInView(stage, { margin: '100px' })
  const hasEntered = useInView(stage, { margin: '100px', once: true })
  const reduced = useReducedMotion()
  const running = playing && visible && inView && !reduced
  const send = (message: Record<string, unknown>) =>
    (
      frame.current?.contentWindow as NativeWindow | null
    )?.KineSyncLyrics?.receive(message)
  const options = () => ({
    type: 'options',
    tapToSeekEnabled: true,
    fontScale: 0.85,
    showTranslatedText: true,
    autoFollowEnabled: true
  })
  function seek(value: number) {
    positionRef.current = Math.max(0, Math.min(duration - 1, value))
    setPosition(positionRef.current)
    send({ ...options(), resumeAutoFollowSignal: Date.now() })
    send({
      type: 'sync',
      positionMs: positionRef.current,
      isPlaying: running,
      force: true,
      durationMs: duration
    })
  }
  function initialize() {
    const child = frame.current?.contentWindow as NativeWindow | null
    if (!child?.KineSyncLyrics) return
    send(options())
    send({
      type: 'setLyrics',
      lines: lyrics,
      timingMode: reduced ? 'static' : 'karaoke',
      positionMs: positionRef.current,
      durationMs: duration,
      isPlaying: false,
      tapToSeekEnabled: true,
      fontScale: 0.85,
      showTranslatedText: true
    })
    send({ type: 'visibility', active: inView && visible })
    send({
      type: 'sync',
      positionMs: positionRef.current,
      isPlaying: running,
      durationMs: duration
    })
    setReady(true)
  }
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== frame.current?.contentWindow ||
        event.data?.kind !== 'kinesync-preview'
      )
        return
      const message = event.data.payload
      if (
        message?.type === 'linePress' &&
        Number.isInteger(message.index) &&
        lyrics[message.index]
      )
        seek(lyrics[message.index].lineStartTime)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
    // Refresh the seek callback when playback/visibility changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running])
  useEffect(() => {
    if (frame.current && ready) initialize()
    // Recreate the native presentation when the OS motion preference changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduced])
  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    onVisibility()
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])
  useEffect(() => {
    const child = frame.current?.contentWindow as NativeWindow | null
    child?.KineSyncLyrics?.receive({
      type: 'visibility',
      active: inView && visible
    })
    child?.KineSyncLyrics?.receive({
      type: 'sync',
      positionMs: positionRef.current,
      isPlaying: running,
      durationMs: duration
    })
    if (!running || !ready) return
    let last = performance.now()
    const timer = window.setInterval(() => {
      const now = performance.now()
      positionRef.current = (positionRef.current + now - last) % duration
      last = now
      setPosition(positionRef.current)
      child?.KineSyncLyrics?.receive({
        type: 'sync',
        positionMs: positionRef.current,
        isPlaying: true,
        durationMs: duration
      })
    }, 200)
    return () => window.clearInterval(timer)
  }, [running, ready, inView, visible, engine])
  return (
    <div className="renderer-demo glass" ref={stage}>
      <div className="demo-toolbar">
        <span>Make it your own</span>
        <div className="segmented" aria-label="Lyrics renderer">
          {(['spicy', 'amll'] as const).map((item) => (
            <button
              key={item}
              aria-pressed={engine === item}
              onClick={() => {
                if (engine !== item) {
                  setReady(false)
                  setEngine(item)
                }
              }}
            >
              {engine === item && (
                <motion.span
                  className="selection"
                  layoutId="renderer-selection"
                  transition={spring}
                />
              )}
              <span>{item === 'spicy' ? 'Spicy' : 'AMLL'}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="demo-player">
        <div className="demo-artwork">
          <img
            src={`${basePath}/previews/artwork.webp`}
            alt="Provisional capture of KineSync’s album artwork view"
            loading="lazy"
            width="480"
            height="1000"
          />
          <span className="asset-caption">Captured in KineSync</span>
        </div>
        <div className="renderer-pane">
          {hasEntered && (
            <iframe
              key={engine}
              ref={frame}
              title={`${engine === 'spicy' ? 'Spicy' : 'AMLL'} interactive lyrics preview`}
              src={`${basePath}/previews/${engine}.html`}
              onLoad={initialize}
            />
          )}
          <noscript>
            <p>{lyrics[0].syllables.map((word) => word.text).join('')}</p>
          </noscript>
        </div>
      </div>
      <div className="demo-controls">
        <button
          className="round-button"
          aria-label={running ? 'Pause lyrics preview' : 'Play lyrics preview'}
          onClick={() => setPlaying(!playing)}
          disabled={!!reduced}
        >
          {running ? <Pause size={19} /> : <Play size={19} />}
        </button>
        <label className="scrubber">
          <span className="sr-only">Preview position</span>
          <input
            type="range"
            min="0"
            max={duration - 1}
            value={position}
            disabled={!!reduced}
            onChange={(event) => seek(Number(event.target.value))}
          />
        </label>
        <span className="demo-time">
          0:{String(Math.floor(position / 1000)).padStart(2, '0')}
        </span>
        <span className="sample-note">Onboarding demo · No audio</span>
      </div>
      {reduced && (
        <p className="reduced-note">
          Animations are paused to match your preference. Switch styles or
          scroll through the lyrics.
        </p>
      )}
    </div>
  )
}

const downloads = [
  {
    name: 'iOS',
    file: 'KineSync-iOS-unsigned.ipa',
    guide: 'IOS_INSTALL.md',
    detail: 'Unsigned IPA. Sign and sideload on your iPhone or iPad.'
  },
  {
    name: 'Android',
    file: 'KineSync-Android.apk',
    guide: 'ANDROID_INSTALL.md',
    detail: 'Download the APK and install on your Android device.'
  }
]

export default function Landing() {
  const hero = useRef<HTMLDivElement>(null)
  const heroVisible = useInView(hero, { once: true })
  const subtitleStart =
    heroLeadIn +
    (heroHeadline.length + 1) * heroSecondsPerCharacter +
    heroWordOverlap
  return (
    <MotionConfig reducedMotion="user" transition={spring}>
      <div className="page-atmosphere" aria-hidden="true">
        <i className="wash-lavender" />
        <i className="wash-ice" />
        <i className="wash-rose" />
        <i className="wash-bottom" />
      </div>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="header glass">
        <Brand />
        <nav aria-label="Main navigation">
          <a href="#experience">Experience</a>
          <a href="#your-files">Your lyrics</a>
          <a href="#download">Download</a>
        </nav>
        <a href={repo} className="github-button">
          <GitHubIcon size={18} />
          <span>GitHub</span>
        </a>
      </header>
      <main id="main">
        <section className="hero">
          <div
            className="hero-copy"
            ref={hero}
            data-lyric-playing={heroVisible}
            style={
              {
                '--hero-focus-delay': `${heroFocusDelay}s`,
                '--hero-focus-duration': `${heroFocusDuration}s`,
                '--hero-spicy-scale-duration': `${spicyScale.duration}s`,
                '--hero-spicy-scale-easing': spicyScale.easing
              } as CSSProperties
            }
          >
            <p className="intro hero-backing-lyric">
              <LyricText delay={subtitleStart} duration={heroSubtitleDuration}>
                {heroIntro}
              </LyricText>
            </p>
            <h1 aria-label={heroHeadline}>
              <LyricText delay={heroLeadIn}>{heroHeadline}</LyricText>
            </h1>
            <p className="hero-description hero-backing-lyric">
              <LyricText delay={subtitleStart} renderer="spicy">
                {heroSubtitles[0]}
              </LyricText>
              <br />
              <LyricText
                delay={subtitleStart + spicyLineDuration(heroSubtitles[0])}
                renderer="spicy"
              >
                {heroSubtitles[1]}
              </LyricText>
            </p>
            <div className="hero-actions">
              <motion.a
                whileHover={{ scale: 1.035 }}
                whileTap={{ scale: 0.96 }}
                className="button primary"
                href="#download"
              >
                Get KineSync <ArrowDown size={18} />
              </motion.a>
              <a className="quiet-link" href="#experience">
                Try the experience <Play size={15} />
              </a>
            </div>
            <p className="platform-note">
              <Smartphone size={15} /> Made for iOS and Android
            </p>
          </div>
          <div className="hero-stage">
            <div className="stage-light" />
            <figure className="phone-capture">
              <img
                src={`${basePath}/previews/player.webp`}
                alt="Actual KineSync lyrics player captured from the app running in BlueStacks"
                width="720"
                height="1280"
                fetchPriority="high"
              />
              <figcaption>From the app. Every word in motion.</figcaption>
            </figure>
            <div className="floating-note glass">
              <Check size={17} />
              <div>
                Keep the words you love.
                <small>Save. Export. Make them yours.</small>
              </div>
            </div>
          </div>
        </section>
        <div className="benefits" aria-label="Why KineSync">
          <div>
            <strong>100% free</strong>
            <span>No Spotify Premium required</span>
          </div>
          <div>
            <strong>Your files, in your hands</strong>
            <span>Save and export your lyrics</span>
          </div>
          <div>
            <strong>iOS + Android</strong>
            <span>The same experience on both</span>
          </div>
          <div>
            <strong>Fully open source</strong>
            <span>Explore every line of code</span>
          </div>
        </div>
        <section id="experience" className="experience section">
          <div className="section-copy">
            <h2>
              Lyrics with a<br />
              life of their own.
            </h2>
            <p>
              The glow of a word. The lift of a chorus. Choose Spicy or AMLL and
              watch the lyrics move with the music.
            </p>
          </div>
          <LyricsDemo />
          <p className="section-footnote">
            The same lyric engines that run inside KineSync. Tap a line, press
            play, or switch your style.
          </p>
        </section>
        <section id="your-files" className="ownership section">
          <div className="vault-preview glass">
            <div className="vault-header">
              <img
                src={`${basePath}/app-icon.png`}
                width="28"
                height="28"
                alt=""
              />
              <span>Your lyrics vault</span>
              <FileDown size={22} />
            </div>
            <div className="vault-files">
              {[
                { title: 'Blinding Lights', artist: 'The Weeknd' },
                { title: 'Sloppy Joe', artist: 'slayr' },
                { title: 'GERONIMO!', artist: 'DPR Live' }
              ].map(({ title, artist }, i) => (
                <div className="vault-file" key={title}>
                  <span className={`file-cover cover-${i}`} aria-hidden="true">
                    <FileMusic size={23} />
                  </span>
                  <span>
                    <strong>{title}</strong>
                    <small>
                      {artist} · {title}.ttml
                    </small>
                  </span>
                  <Check size={17} />
                </div>
              ))}
            </div>
            <div className="vault-bottom">
              <span>Saved by you. Kept by you.</span>
              <span className="export-pill">
                Export .ttml <ArrowRight size={14} />
              </span>
            </div>
            <p className="placeholder-label">
              Vault layout preview · App capture coming soon
            </p>
          </div>
          <div className="ownership-copy">
            <h2>
              Your favorite words.
              <br />
              Your own files.
            </h2>
            <p>
              Build a lyrics collection you can actually keep. Save songs to
              your local vault, bring your own TTML files, and export them
              whenever you want.
            </p>
            <p className="ownership-detail">
              Your lyrics files stay in your hands. Ready to back up, move, and
              use again.
            </p>
            <a href={`${repo}#readme`} className="quiet-link">
              Explore the lyrics vault <ArrowRight size={17} />
            </a>
          </div>
        </section>
        <section className="open-section section">
          <div className="open-copy">
            <GitHubIcon size={36} />
            <h2>
              Made for music.
              <br />
              Open to everyone.
            </h2>
            <p>
              100% free and fully open source. Read the code, suggest a feature,
              or help make KineSync better for the next person who presses play.
            </p>
            <a href={repo} className="button secondary">
              <GitHubIcon size={19} /> Explore on GitHub
            </a>
            <div className="open-links">
              <a href={`${repo}/blob/main/CONTRIBUTING.md`}>Contribute</a>
              <a href={`${repo}/issues`}>Share an idea</a>
              <a href={`${repo}/blob/main/LICENSE`}>Read the license</a>
            </div>
          </div>
          <ProjectStats />
        </section>
        <section id="download" className="download-section section">
          <div className="download-heading">
            <h2>
              Bring your lyrics
              <br />
              along for the ride.
            </h2>
            <p>One app. Both platforms. All yours.</p>
          </div>
          <div className="download-options">
            {downloads.map((item) => (
              <article className="download-card glass" key={item.name}>
                <Smartphone size={30} strokeWidth={1.4} />
                <h3>KineSync for {item.name}</h3>
                <p>{item.detail}</p>
                <motion.a
                  whileHover={{ y: -3 }}
                  whileTap={{ scale: 0.97 }}
                  href={`${repo}/releases/latest/download/${item.file}`}
                  className="button primary"
                >
                  <Download size={18} /> Download for {item.name}
                </motion.a>
                <a
                  className="quiet-link"
                  href={`${repo}/blob/main/${item.guide}`}
                >
                  Installation guide <ArrowRight size={14} />
                </a>
              </article>
            ))}
          </div>
          <p className="download-note">
            100% free. No Spotify Premium needed.{' '}
            <a href={`${repo}/releases/latest`}>Release notes</a>
          </p>
        </section>
        <section className="faq-section section">
          <h2>
            A few things
            <br />
            before you listen.
          </h2>
          <div className="faq-list">
            {[
              [
                'Is KineSync really free?',
                'Yes. KineSync is 100% free and fully open source. Optional external services, such as AI translation providers, may have their own usage limits.'
              ],
              [
                'Do I need Spotify Premium?',
                'No. KineSync works without Spotify Premium. Available playback controls depend on your Spotify account and connection method.'
              ],
              [
                'Can I keep my lyrics files?',
                'Yes. Keep local TTML copies, back them up, export them, and bring your own files into the vault.'
              ],
              [
                'How do I install it?',
                'Download the Android APK or the iOS IPA from GitHub Releases. iOS builds must be signed and sideloaded. The installation guides walk you through the steps.'
              ],
              [
                'Is KineSync affiliated with Spotify?',
                'KineSync is an independent community project and is not affiliated with or endorsed by Spotify.'
              ]
            ].map(([question, answer]) => (
              <details key={question}>
                <summary>
                  {question}
                  <span aria-hidden="true">+</span>
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>
      </main>
      <footer className="footer">
        <div className="footer-top">
          <Brand />
          <p>All Lyrics, All Devices, Always</p>
          <a href={repo}>
            <GitHubIcon size={18} /> GitHub
          </a>
        </div>
        <div className="footer-bottom">
          <span>Free. Open source. Yours to keep.</span>
          <a href={`${repo}#readme`}>Documentation</a>
          <a href={`${basePath}/licenses/third-party.txt`}>
            Third-party notices
          </a>
          <a href="#main">Back to top ↑</a>
        </div>
      </footer>
    </MotionConfig>
  )
}
