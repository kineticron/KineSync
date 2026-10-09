import sharp from 'sharp'

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><defs><radialGradient id="glow"><stop stop-color="#a7a6cb" stop-opacity=".2"/><stop offset="1" stop-color="#090a11" stop-opacity="0"/></radialGradient></defs><rect width="1200" height="630" fill="#090a11"/><ellipse cx="960" cy="315" rx="380" ry="350" fill="url(#glow)"/><text x="135" y="98" fill="#f8f8fe" font-size="30" font-family="Arial" font-weight="bold">KineSync</text><g fill="#f8f8fe" font-size="76" font-family="Arial" font-weight="bold" letter-spacing="-3"><text x="70" y="235">All Lyrics,</text><text x="70" y="326">All Devices,</text><text x="70" y="417">Always</text></g><text x="70" y="506" fill="#c2e9fb" font-size="23" font-family="Arial">100% free. No Spotify Premium needed.</text><text x="70" y="548" fill="#b9b9c9" font-size="20" font-family="Arial">iOS + Android. Fully open source.</text></svg>`
const icon = await sharp('public/app-icon.png').resize(45, 45).toBuffer()
const player = await sharp('public/previews/player.webp')
  .resize(280, 498)
  .toBuffer()
await sharp(Buffer.from(svg))
  .composite([
    { input: icon, left: 70, top: 63 },
    { input: player, left: 835, top: 66 }
  ])
  .png()
  .toFile('public/social-card.png')
