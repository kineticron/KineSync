import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'export',
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? '/KineSync',
  trailingSlash: true,
  images: { unoptimized: true },
  poweredByHeader: false
}

export default nextConfig
