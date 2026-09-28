/**
 * Import a fixture over HTTP and PROVE it is the file and not the SPA
 * fallback. `vite preview` answers every unknown path with index.html and a
 * 200, so a fixture that is missing from dist/ imports as "an image" that
 * decodes to nothing: the viewer stays black and every grade assertion
 * trivially passes. Checking the content type before import turns that class
 * of false green into a hard failure.
 */
export async function fetchFixture(page, url, expect) {
  const info = await page.eval(`
    const res = await fetch(${JSON.stringify(url)});
    const buf = new Uint8Array(await res.arrayBuffer());
    let head = '';
    for (let i = 0; i < Math.min(8, buf.length); i++) head += String.fromCharCode(buf[i]);
    let hex = '';
    for (let i = 0; i < Math.min(8, buf.length); i++) hex += buf[i].toString(16).padStart(2, '0');
    return { status: res.status, type: res.headers.get('content-type') || '', size: buf.length, head, headBytes: hex };
  `);
  const problems = [];
  if (info.status !== 200) problems.push(`status ${info.status}`);
  if (info.size < 256) problems.push(`${info.size} bytes is too small to be a fixture`);
  if (info.type.includes('text/html')) problems.push('served as text/html — that is the SPA fallback, not the file');
  // Magic is compared as hex bytes, never as a JS string literal: a PNG
  // signature starts with 0x89, which is not representable as printable text
  // and gets mangled by escaping on the way through a template literal.
  if (expect?.magicHex) {
    const want = Buffer.from(expect.magicHex, 'hex');
    const got = Buffer.from(info.headBytes ?? [], 'hex');
    if (got.length < want.length || !want.equals(got.subarray(0, want.length))) {
      problems.push(`first bytes are ${info.headBytes}, expected ${expect.magicHex}`);
    }
  }
  // An MP4/QuickTime file starts with a 4-byte box size and the ASCII type
  // "ftyp" at offset 4, so the file magic is not at offset 0 the way a PNG's
  // signature is. Checking offset 0 for the file type rejects every valid MP4.
  if (expect?.ftypAt4 && info.head.slice(4, 8) !== 'ftyp') {
    problems.push(`bytes 4..8 are ${JSON.stringify(info.head.slice(4, 8))}, not "ftyp" — not an MP4`);
  }
  if (problems.length) {
    throw new Error(
      `fixture ${url} is not usable: ${problems.join('; ')}. `
      + 'The fixtures must exist under public/ so vite build copies them into dist/.',
    );
  }
  return info;
}
