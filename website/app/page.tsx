import Landing from './landing'

export default function Home() {
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: 'KineSync',
    applicationCategory: 'MultimediaApplication',
    operatingSystem: 'Android, iOS',
    description:
      'Open source synchronized Spotify lyrics with Spicy and AMLL rendering styles and a local TTML vault.',
    url: 'https://kineticron.github.io/KineSync/',
    downloadUrl: 'https://github.com/Kineticron/KineSync/releases/latest',
    codeRepository: 'https://github.com/Kineticron/KineSync',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' }
  }
  return (
    <>
      <noscript>
        <style>{'.text-mask > span { transform: none !important; }'}</style>
      </noscript>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</g, '\\u003c')
        }}
      />
      <Landing />
    </>
  )
}
