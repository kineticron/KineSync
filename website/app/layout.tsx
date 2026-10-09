import type { Metadata, Viewport } from 'next'
import '@fontsource/dm-sans/latin-400.css'
import '@fontsource/dm-sans/latin-500.css'
import '@fontsource/dm-sans/latin-600.css'
import '@fontsource/dm-sans/latin-700.css'
import '@fontsource/manrope/latin-500.css'
import '@fontsource/manrope/latin-700.css'
import './globals.css'

const origin = 'https://kineticron.github.io'
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '/KineSync'
const title = 'KineSync | Give your music the words it deserves'
const description = 'Open source Spotify lyrics for Android and iOS. Follow synchronized lyrics, explore Spicy and AMLL styles, and build your own TTML lyrics library.'

export const metadata: Metadata = {
  metadataBase: new URL(origin),
  title,
  description,
  alternates: { canonical: `${origin}${basePath}/` },
  applicationName: 'KineSync',
  icons: { icon: `${basePath}/icon.svg` },
  openGraph: {
    type: 'website', locale: 'en_US', siteName: 'KineSync', title, description,
    url: `${origin}${basePath}/`,
    images: [{ url: `${basePath}/social-card.png`, width: 1200, height: 630, alt: 'KineSync synchronized lyrics for your music' }]
  },
  twitter: { card: 'summary_large_image', title, description, images: [`${basePath}/social-card.png`] },
  robots: { index: true, follow: true }
}

export const viewport: Viewport = { themeColor: '#11100f', colorScheme: 'dark' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>
}
