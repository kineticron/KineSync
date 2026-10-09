import { createServer } from 'node:http'
import { readFileSync, statSync } from 'node:fs'
import { resolve, extname, sep } from 'node:path'

const root = resolve('out')
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '/KineSync'
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain', '.xml': 'application/xml' }
createServer((request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
    if (pathname === basePath) { response.writeHead(302, { Location: `${basePath}/` }).end(); return }
    if (!pathname.startsWith(`${basePath}/`)) throw new Error('Outside base path')
    let file = resolve(root, `.${pathname.slice(basePath.length)}`)
    if (!file.startsWith(`${root}${sep}`) && file !== root) throw new Error('Outside root')
    if (statSync(file).isDirectory()) file = resolve(file, 'index.html')
    response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file))
  } catch { response.writeHead(404).end('Not found') }
}).listen(3100, '127.0.0.1', () => console.log(`Production export: http://127.0.0.1:3100${basePath}/`))
