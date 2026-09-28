import { defineConfig } from 'vite';

/**
 * host MUST be the 127.0.0.1 LITERAL, not "localhost".
 *
 * WebCodecs (VideoEncoder/VideoDecoder) is gated on
 * window.isSecureContext, and on this machine `http://localhost:PORT` reports
 * isSecureContext === false while `http://127.0.0.1:PORT` reports true. A
 * localhost binding would leave the whole encode path silently missing.
 *
 * https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts
 */
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5178,
    strictPort: true,
    // The agent bridge connects back to the local server over plain HTTP.
    cors: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4178,
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // The E2E tests import media over HTTP from this origin, so the fixtures
    // have to be part of the served output. Without this, vite's SPA fallback
    // answers /test/fixtures/cast.png with index.html and a 200: every test
    // silently imported an HTML document as a picture, decoded nothing, and
    // asserted against a black frame. publicDir is the mechanism; the fixture
    // script writes there as well as into test/fixtures.
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  publicDir: 'public',
  worker: {
    format: 'es',
  },
});
