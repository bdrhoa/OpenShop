// Security headers middleware
import { IMAGE_PROXY_CSP } from '../config/index.js'
import { KOUNT_COLLECTOR_ORIGIN, isKountDdcHost } from '../config/kount.js'

const buildAppCsp = (hostname) => {
  const kount = isKountDdcHost(hostname) ? ` ${KOUNT_COLLECTOR_ORIGIN}` : ''
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com", // Stripe requires unsafe-inline
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: https: blob:",
    "font-src 'self' data: https://fonts.gstatic.com",
    `connect-src 'self' https://api.stripe.com https://*.stripe.com https://oauth2.googleapis.com https://www.googleapis.com${kount}`,
    `frame-src 'self' https://js.stripe.com https://hooks.stripe.com${kount}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests"
  ].join('; ')
}

/**
 * Adds security headers to responses
 * @param {Function} c - Hono context
 * @param {Function} next - Next middleware
 */
export async function securityHeadersMiddleware(c, next) {
  await next()

  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('X-XSS-Protection', '1; mode=block')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()')

  const url = new URL(c.req.url)
  const isImageProxy = url.pathname === '/api/image-proxy' || url.pathname.startsWith('/api/image-proxy/')
  c.header('Content-Security-Policy', isImageProxy ? IMAGE_PROXY_CSP : buildAppCsp(url.hostname))

  if (url.protocol === 'https:') {
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload')
  }
}

