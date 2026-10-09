'use client'

import { useEffect, useRef, useState } from 'react'
import { motion, MotionConfig, useInView, useReducedMotion } from 'motion/react'
import {
  ArrowDown,
  ArrowRight,
  Check,
  ChevronRight,
  Download,
  CodeXml as Github,
  Layers,
  Library,
  Monitor,
  Pause,
  Play,
  Radio,
  Smartphone,
  Sparkles,
  Wifi
} from 'lucide-react'

const repo = 'https://github.com/Kineticron/KineSync'
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '/KineSync'
const lines = [
  'Let the city fade away',
  'Find a rhythm of your own',
  'Every word, a little closer',
  'Every beat feels like home'
]
const platforms = {
  Android: {
    file: 'KineSync-Android.apk',
    detail: 'Install the APK on your Android device.',
    guide: 'ANDROID_INSTALL.md',
    label: 'Download for Android'
  },
  iOS: {
    file: 'KineSync-iOS-unsigned.ipa',
    detail: 'An unsigned IPA for sideloading. Signing is required.',
    guide: 'IOS_INSTALL.md',
    label: 'Download for iOS'
  },
  Windows: {
    file: 'KineSync-Desktop-Windows-Setup.exe',
    detail: 'The optional Desktop Bridge for playback detection.',
    guide: 'SETUP.md',
    label: 'Download Desktop Bridge'
  }
}

function Reveal({
  children,
  className = ''
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <motion.div
      className={className}
      initial={false}
      whileInView={{ opacity: 1, y: [-10, 0] }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.6 }}
    >
      {children}
    </motion.div>
  )
}

function LyricsDemo() {
  const [style, setStyle] = useState<'Spicy' | 'AMLL'>('Spicy')
  const [playing, setPlaying] = useState(true)
  const [line, setLine] = useState(1)
  const [visible, setVisible] = useState(true)
  const reducedMotion = useReducedMotion()
  const stage = useRef<HTMLDivElement>(null)
  const inView = useInView(stage)
  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden)
    onVisibility()
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])
  useEffect(() => {
    if (!playing || !visible || !inView || reducedMotion) return
    const timer = window.setInterval(
      () => setLine((current) => (current + 1) % lines.length),
      3200
    )
    return () => window.clearInterval(timer)
  }, [playing, visible, inView, reducedMotion])
  const animating = playing && visible && inView && !reducedMotion
  return (
    <div
      className={`demo ${style.toLowerCase()} ${animating ? 'animating' : ''}`}
      ref={stage}
    >
      <div className="demo-top">
        <span>
          <span className="status-dot" /> LIVE PREVIEW
        </span>
        <div className="style-switch" aria-label="Lyrics style">
          {(['Spicy', 'AMLL'] as const).map((item) => (
            <button
              key={item}
              aria-pressed={style === item}
              onClick={() => setStyle(item)}
            >
              {item}
            </button>
          ))}
        </div>
      </div>
      <div className="demo-content">
        <div className="record">
          <div className="record-art">
            <div className="art-orbit" />
            <span>
              AFTER
              <br />
              HOURS
            </span>
            <small>THE KINESYNC SESSIONS</small>
          </div>
          <div className="track">
            <strong>A rhythm of your own</strong>
            <span>KineSync demo · Original sample</span>
          </div>
        </div>
        <div className="lyric-lines" aria-label="Interactive sample lyrics">
          {lines.map((text, index) => (
            <button
              key={text}
              onClick={() => setLine(index)}
              className={index === line ? 'active' : ''}
              aria-pressed={index === line}
            >
              <span>{text}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="demo-bottom">
        <button
          className="play-toggle"
          onClick={() => setPlaying((value) => !value)}
          aria-label={
            playing ? 'Pause lyric animation' : 'Play lyric animation'
          }
        >
          {playing ? <Pause size={17} /> : <Play size={17} />}
        </button>
        <div className="timeline">
          <span style={{ width: `${25 + line * 18}%` }} />
        </div>
        <span className="time">
          0:{String(24 + line * 12).padStart(2, '0')}
        </span>
        <span className="demo-caption">A taste of the experience</span>
      </div>
    </div>
  )
}

export default function Landing() {
  const [platform, setPlatform] = useState<keyof typeof platforms>('Android')
  const selected = platforms[platform]
  return (
    <MotionConfig reducedMotion="user">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="header">
        <a href="#" className="brand" aria-label="KineSync home">
          <img src={`${basePath}/icon.svg`} alt="" width="31" height="31" />
          KineSync
        </a>
        <nav aria-label="Main navigation">
          <a href="#experience">Experience</a>
          <a href="#features">Features</a>
          <a href={`${repo}#readme`}>
            Docs <ArrowRight size={12} />
          </a>
        </nav>
        <a href={repo} className="source-link">
          <Github size={17} />
          <span>View source</span>
          <ArrowUpRight />
        </a>
      </header>
      <main id="main">
        <section className="hero">
          <div className="hero-glow" />
          <div className="hero-copy">
            <span className="eyebrow">
              <span className="status-dot" /> OPEN SOURCE. IN SYNC. IN YOUR
              HANDS.
            </span>
            <h1>
              Your music.
              <br />
              Every word.
              <br />
              <span>A little closer.</span>
            </h1>
            <p>
              Turn listening into something you can feel.
              <br className="desktop-break" /> Beautiful, synchronized Spotify
              lyrics that move with your music.
            </p>
            <div className="hero-actions">
              <a href="#download" className="button primary">
                Get KineSync <ArrowDown size={18} />
              </a>
              <a href="#experience" className="button text-button">
                Meet your next verse <ArrowRight size={17} />
              </a>
            </div>
            <div className="hero-meta">
              <Smartphone size={14} /> Android & iOS <span /> Free & open source{' '}
              <span /> Made for music
            </div>
          </div>
          <div className="hero-visual" aria-hidden="true">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <div className="orbital-label label-one">
              <Radio size={13} /> WORDS IN MOTION
            </div>
            <div className="phone">
              <div className="phone-island" />
              <div className="phone-screen">
                <div className="phone-header">
                  9:41 <span>● ▰</span>
                </div>
                <div className="phone-cover">
                  <span>
                    feel
                    <br />
                    <i>everything.</i>
                  </span>
                  <div className="cover-sun" />
                </div>
                <div className="phone-song">
                  A rhythm of your own<small>KineSync sessions</small>
                </div>
                <div className="phone-lyrics">
                  <span>Let the city fade away</span>
                  <strong>
                    Find a rhythm
                    <br />
                    of your own
                  </strong>
                  <span>Every word, a little closer</span>
                </div>
                <div className="phone-progress" />
                <div className="phone-controls">
                  ↶ <span>Ⅱ</span> ↷
                </div>
              </div>
            </div>
            <div className="orbital-label label-two">
              <Sparkles size={13} /> ALL THE FEELING
            </div>
            <div className="visual-caption">
              THE SOUNDTRACK IS YOURS.
              <br />
              <span>SO IS THE EXPERIENCE.</span>
            </div>
          </div>
        </section>
        <div className="manifesto-strip">
          <span>BUILT AROUND THE WAY YOU LISTEN</span>
          <span>
            <Radio size={16} /> Synchronized lyrics
          </span>
          <span>
            <Layers size={16} /> Two visual styles
          </span>
          <span>
            <Library size={16} /> Your own library
          </span>
          <span>
            <Github size={16} /> Open by design
          </span>
        </div>
        <section id="experience" className="section experience">
          <Reveal className="section-heading">
            <div>
              <span className="eyebrow">01 / THE EXPERIENCE</span>
              <h2>
                Don’t just hear it.
                <br />
                <span>Follow the feeling.</span>
              </h2>
            </div>
            <p>
              From the quietest verse to the biggest chorus, keep every word in
              view. Try the preview, switch styles, or tap a line.
            </p>
          </Reveal>
          <Reveal>
            <LyricsDemo />
          </Reveal>
          <p className="preview-note">
            Illustrative web preview with original sample lyrics. Mobile
            rendering uses dedicated Spicy and AMLL engines.
          </p>
        </section>
        <section id="features" className="section">
          <Reveal className="section-heading">
            <div>
              <span className="eyebrow">02 / YOUR LISTENING SPACE</span>
              <h2>
                A little more music.
                <br />
                <span>A lot more you.</span>
              </h2>
            </div>
            <p>
              Keep the words you love close. Choose your look, explore
              translations, and make room for your own lyrics.
            </p>
          </Reveal>
          <div className="feature-grid">
            <Reveal className="feature-card large">
              <div className="card-label">
                <Layers size={19} /> FIND YOUR LOOK
              </div>
              <h3>
                Two styles.
                <br />
                One uninterrupted feeling.
              </h3>
              <p>
                Choose Spicy’s expressive lyric presentation or AMLL’s flowing,
                word by word experience.
              </p>
              <div className="style-art">
                <div className="style-spicy">
                  Stay in
                  <br />
                  <span>the moment.</span>
                  <small>SPICY</small>
                </div>
                <div className="style-amll">
                  Let it
                  <br />
                  <span>all flow.</span>
                  <small>AMLL</small>
                </div>
              </div>
            </Reveal>
            <Reveal className="feature-card">
              <div className="card-label">
                <Library size={19} /> A LIBRARY THAT’S YOURS
              </div>
              <div className="vault-art">
                <div>
                  <span className="file-icon">♪</span>
                  <span>
                    Late night favorites<small>TTML lyrics collection</small>
                  </span>
                  <Check size={16} />
                </div>
                <div>
                  <span className="file-icon">♪</span>
                  <span>
                    That one perfect chorus<small>Imported lyrics</small>
                  </span>
                  <Check size={16} />
                </div>
              </div>
              <h3>
                Save the words.
                <br />
                Keep the feeling.
              </h3>
              <p>
                Import and export TTML lyrics with a local vault. Bring your own
                files and curate your collection.
              </p>
            </Reveal>
            <Reveal className="feature-card">
              <div className="card-label">
                <Sparkles size={19} /> GO BEYOND THE WORDS
              </div>
              <div className="translation-art">
                <span>音楽を感じて</span>
                <span>
                  Feel the music <ArrowRight size={20} />
                </span>
              </div>
              <h3>Cross the language barrier.</h3>
              <p>
                Explore lyric translations with an optional Gemini API key.
                Availability and provider usage limits apply.
              </p>
            </Reveal>
            <Reveal className="feature-card wide">
              <div>
                <div className="card-label">
                  <Wifi size={19} /> STAY CONNECTED
                </div>
                <h3>
                  Your phone. Your desktop.
                  <br />
                  The same song.
                </h3>
                <p>
                  Use the mobile Spotify browser, or connect an optional
                  self-hosted Desktop Bridge for playback detection.
                </p>
                <a href={`${repo}/blob/main/SETUP.md`} className="inline-link">
                  Explore the setup <ArrowRight size={16} />
                </a>
              </div>
              <div className="connection-art" aria-hidden="true">
                <Monitor size={66} strokeWidth={1} />
                <div className="connection-dots">••••••</div>
                <Smartphone size={56} strokeWidth={1} />
              </div>
            </Reveal>
          </div>
        </section>
        <section className="open-section">
          <div className="open-inner">
            <Reveal>
              <span className="eyebrow">03 / OPEN BY DESIGN</span>
              <h2>
                Good music brings us together.
                <br />
                <span>Good software should too.</span>
              </h2>
              <p>
                KineSync is built in the open. Explore the code, share an idea,
                or help shape what comes next. There’s a place for every kind of
                contributor.
              </p>
              <a className="button secondary" href={repo}>
                <Github size={18} /> Find us on GitHub <ArrowRight size={18} />
              </a>
              <div className="open-links">
                <a href={`${repo}/blob/main/CONTRIBUTING.md`}>
                  Contribute <ChevronRight size={14} />
                </a>
                <a href={`${repo}/issues`}>
                  Share an idea <ChevronRight size={14} />
                </a>
                <a href={`${repo}/blob/main/LICENSE`}>
                  Read the license <ChevronRight size={14} />
                </a>
              </div>
            </Reveal>
            <div className="open-symbol" aria-hidden="true">
              &lt;<span>♪</span>&gt;
            </div>
          </div>
        </section>
        <section id="download" className="section download-section">
          <Reveal>
            <span className="eyebrow">04 / PRESS PLAY</span>
            <h2>
              Your next favorite song.
              <br />
              <span>A whole new feeling.</span>
            </h2>
            <p>Start with your device. We’ll meet you at the chorus.</p>
            <div className="platforms" aria-label="Download platform">
              {(Object.keys(platforms) as (keyof typeof platforms)[]).map(
                (item) => (
                  <button
                    key={item}
                    onClick={() => setPlatform(item)}
                    aria-pressed={platform === item}
                  >
                    {item === 'Windows' ? (
                      <Monitor size={16} />
                    ) : (
                      <Smartphone size={16} />
                    )}
                    {item}
                  </button>
                )
              )}
            </div>
            <a
              href={`${repo}/releases/latest/download/${selected.file}`}
              className="button primary"
            >
              <Download size={18} /> {selected.label} <ArrowRight size={18} />
            </a>
            <p className="install-detail">
              {selected.detail}{' '}
              <a href={`${repo}/blob/main/${selected.guide}`}>
                Installation guide <ArrowRight size={12} />
              </a>
            </p>
            <a href={`${repo}/releases/latest`} className="all-releases">
              All releases and release notes <ArrowRight size={14} />
            </a>
          </Reveal>
        </section>
        <section className="section faq-section">
          <div>
            <span className="eyebrow">A FEW GOOD QUESTIONS</span>
            <h2>
              Before you
              <br />
              <span>press play.</span>
            </h2>
          </div>
          <div className="faq-list">
            {[
              [
                'Is KineSync free?',
                'Yes. KineSync is free and open source. Optional external services, including AI translation providers, have their own terms and usage limits.'
              ],
              [
                'Do I need Spotify Premium?',
                'KineSync follows Spotify playback. Playback access and available controls depend on your Spotify account and how you connect. See the setup guide for connection requirements.'
              ],
              [
                'Can I install it from the App Store?',
                'Current mobile builds are distributed through GitHub Releases. Android uses an APK. iOS uses an unsigned IPA that you must sign and sideload.'
              ],
              [
                'Where do the lyrics come from?',
                'KineSync supports lyric providers and your own TTML files. Availability varies by track and provider. Some providers require configured keys. Attribution and provider terms are documented in the repository.'
              ],
              [
                'Is this an official Spotify app?',
                'KineSync is an independent community project and is not affiliated with or endorsed by Spotify.'
              ]
            ].map(([question, answer]) => (
              <details key={question}>
                <summary>
                  {question}
                  <span>+</span>
                </summary>
                <p>{answer}</p>
              </details>
            ))}
          </div>
        </section>
      </main>
      <footer>
        <div className="footer-top">
          <a href="#" className="brand">
            <img src={`${basePath}/icon.svg`} alt="" width="28" height="28" />
            KineSync
          </a>
          <span>For the love of every word.</span>
          <div>
            <a href={`${repo}#readme`}>Documentation</a>
            <a href={`${repo}/issues`}>Support</a>
            <a href={repo}>
              GitHub <ArrowUpRight />
            </a>
          </div>
        </div>
        <div className="footer-bottom">
          <span>Free software. Shared possibilities.</span>
          <span>Independent project. Not affiliated with Spotify.</span>
          <a href={`${basePath}/licenses/third-party.txt`}>
            Third-party notices
          </a>
          <a href="#main">Back to top ↑</a>
        </div>
      </footer>
    </MotionConfig>
  )
}

function ArrowUpRight() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path d="M4 12 12 4M4 4h8v8" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}
