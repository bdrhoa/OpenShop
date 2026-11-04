// Integration tests for the Worker catch-all that serves static assets and the SPA shell.
// Imports the real worker because createTestApp() does not register the catch-all.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import app from '../../src/worker.js'
import { createTestRequest, executeRequest } from '../utils/test-helpers.js'
import { createMockEnv } from '../setup.js'

const SPA_SHELL = '<!doctype html><html><body><div id="root"></div></body></html>'
const LOGO_BYTES = 'fake-png-bytes'

/**
 * Stand-in for the Workers Assets binding. Like a real Fetcher it parses its
 * input as a Request, so passing anything else (e.g. a HonoRequest) throws
 * "Invalid URL" rather than silently succeeding.
 */
function createMockAssets() {
  const files = {
    '/index.html': { body: SPA_SHELL, type: 'text/html; charset=utf-8' },
    '/logo.png': { body: LOGO_BYTES, type: 'image/png' }
  }

  return {
    fetch: vi.fn(async (input, init) => {
      const request = new Request(input, init)
      const file = files[new URL(request.url).pathname]
      if (!file) {
        return new Response('Not Found', { status: 404 })
      }
      if (request.headers.has('If-None-Match')) {
        return new Response(null, { status: 304 })
      }
      return new Response(file.body, { status: 200, headers: { 'Content-Type': file.type } })
    })
  }
}

describe('Static assets and SPA fallback', () => {
  let env

  beforeEach(() => {
    env = createMockEnv()
    env.ASSETS = createMockAssets()
  })

  const get = (path, headers) => executeRequest(app, createTestRequest(path, { headers }), env)

  async function expectSpaShell(response) {
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/html')
    expect(await response.text()).toBe(SPA_SHELL)
  }

  it.each(['/about', '/p/summer-sale', '/some/unknown/route'])(
    'serves the SPA shell for the deep link %s',
    async (path) => {
      await expectSpaShell(await get(path))
    }
  )

  it.each(['/', '/products/x', '/collections/x', '/success', '/admin'])(
    'serves the SPA shell for the known route %s',
    async (path) => {
      await expectSpaShell(await get(path))
    }
  )

  it('serves a real static file as itself', async () => {
    const response = await get('/logo.png')

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(await response.text()).toBe(LOGO_BYTES)
  })

  it('passes a 304 for a real static file through instead of replacing it with the shell', async () => {
    const response = await get('/logo.png', { 'If-None-Match': '"abc"' })

    expect(response.status).toBe(304)
  })

  it('serves the full SPA shell to a deep link revalidating with a stale ETag', async () => {
    await expectSpaShell(await get('/about', { 'If-None-Match': '"abc"' }))
  })

  it('does not fall back to the SPA shell for unknown API routes', async () => {
    const response = await get('/api/does-not-exist')

    expect(response.status).toBe(404)
    expect(env.ASSETS.fetch).not.toHaveBeenCalled()
  })

  it('returns the loading error page when index.html is unavailable', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    env.ASSETS.fetch = vi.fn(async () => new Response('Not Found', { status: 404 }))

    const response = await get('/about')

    expect(response.status).toBe(500)
    expect(await response.text()).toContain('Application loading error')
    consoleError.mockRestore()
  })
})
