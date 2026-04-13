const test = require('node:test')
const assert = require('node:assert/strict')

/**
 * End-to-end upload lifecycle: init → bytes → meta read-back.
 * Uses the shared mock R2 to prove the three-file dance
 * (pending.json → original + meta.json) works correctly.
 */

async function loadMockR2() {
  const { createMockR2 } = await import('./fixtures/mock-r2.mjs')
  return createMockR2()
}

function cfAccessRequest(url, options = {}) {
  const headers = {
    'Cf-Access-Authenticated-User-Email': 'leojkwan@gmail.com',
    'x-request-id': options.requestId || 'req-test',
    ...options.headers,
  }
  return new Request(url, { ...options, headers })
}

test('mock R2: put then get returns the same JSON', async () => {
  const r2 = await loadMockR2()
  const doc = { name: 'test', value: 42 }
  await r2.put('test/doc.json', JSON.stringify(doc), {
    httpMetadata: { contentType: 'application/json' },
  })

  const obj = await r2.get('test/doc.json')
  assert.ok(obj, 'get should return the object')
  assert.deepEqual(await obj.json(), doc)
  assert.equal(obj.httpMetadata.contentType, 'application/json')
})

test('mock R2: put then head returns metadata without body', async () => {
  const r2 = await loadMockR2()
  await r2.put('test/binary', new ArrayBuffer(128))

  const head = await r2.head('test/binary')
  assert.ok(head)
  assert.equal(head.size, 128)
  assert.equal(head.body, undefined)
})

test('mock R2: delete removes the key', async () => {
  const r2 = await loadMockR2()
  await r2.put('test/gone.json', '{}')
  assert.ok(await r2.get('test/gone.json'))

  await r2.delete('test/gone.json')
  assert.equal(await r2.get('test/gone.json'), null)
})

test('mock R2: batch delete removes multiple keys', async () => {
  const r2 = await loadMockR2()
  await r2.put('a/1', '1')
  await r2.put('a/2', '2')
  await r2.put('a/3', '3')

  await r2.delete(['a/1', 'a/2'])
  assert.equal(await r2.get('a/1'), null)
  assert.equal(await r2.get('a/2'), null)
  assert.ok(await r2.get('a/3'))
})

test('mock R2: list with delimiter returns delimitedPrefixes', async () => {
  const r2 = await loadMockR2()
  await r2.put('users/abc/photos/p1/original', 'img1')
  await r2.put('users/abc/photos/p1/meta.json', '{}')
  await r2.put('users/abc/photos/p2/original', 'img2')
  await r2.put('users/abc/photos/p2/meta.json', '{}')

  const result = await r2.list({ prefix: 'users/abc/photos/', delimiter: '/' })
  assert.deepEqual(
    result.delimitedPrefixes.sort(),
    ['users/abc/photos/p1/', 'users/abc/photos/p2/']
  )
  assert.equal(result.truncated, false)
})

test('mock R2: list pagination with limit', async () => {
  const r2 = await loadMockR2()
  await r2.put('p/a/original', '1')
  await r2.put('p/b/original', '2')
  await r2.put('p/c/original', '3')

  const page1 = await r2.list({ prefix: 'p/', delimiter: '/', limit: 2 })
  assert.equal(page1.delimitedPrefixes.length, 2)
  assert.equal(page1.truncated, true)
  assert.ok(page1.cursor)

  const page2 = await r2.list({ prefix: 'p/', delimiter: '/', limit: 2, cursor: page1.cursor })
  assert.equal(page2.delimitedPrefixes.length, 1)
  assert.equal(page2.truncated, false)
})

test('full upload lifecycle: init → bytes → meta read-back', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const r2 = await loadMockR2()
  const env = { SIDELOAD_R2: r2 }

  const photoBody = new TextEncoder().encode('fake-jpeg-content')
  const hashBuffer = await crypto.subtle.digest('SHA-256', photoBody)
  const sha256 = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  // Step 1: POST /sideload/photos/upload
  const initResp = await handleRequest(
    cfAccessRequest('https://example.workers.dev/sideload/photos/upload', {
      method: 'POST',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'leojkwan@gmail.com',
        'content-type': 'application/json',
        'x-request-id': 'req-lifecycle-init',
      },
      body: JSON.stringify({
        contentType: 'image/jpeg',
        size: photoBody.byteLength,
        sha256,
        capturedAt: '2026-04-12T12:00:00Z',
        originalFilename: 'lifecycle-test.jpg',
      }),
    }),
    env,
  )

  assert.equal(initResp.status, 200)
  const initBody = await initResp.json()
  assert.ok(initBody.photoId)
  assert.ok(initBody.uploadUrl)
  const { photoId, uploadUrl } = initBody

  // Step 2: POST /sideload/photos/:id/_bytes
  const bytesResp = await handleRequest(
    cfAccessRequest(`https://example.workers.dev${uploadUrl}`, {
      method: 'POST',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'leojkwan@gmail.com',
        'content-type': 'application/octet-stream',
        'x-request-id': 'req-lifecycle-bytes',
      },
      body: photoBody.buffer,
    }),
    env,
  )

  assert.equal(bytesResp.status, 200)
  const bytesBody = await bytesResp.json()
  assert.equal(bytesBody.photoId, photoId)
  assert.equal(bytesBody.size, photoBody.byteLength)
  assert.ok(bytesBody.etag)

  // Step 3: GET /sideload/photos/:id (meta mode)
  const metaResp = await handleRequest(
    cfAccessRequest(`https://example.workers.dev/sideload/photos/${photoId}`, {
      requestId: 'req-lifecycle-meta',
    }),
    env,
  )

  assert.equal(metaResp.status, 200)
  const meta = await metaResp.json()
  assert.equal(meta.photoId, photoId)
  assert.equal(meta.contentType, 'image/jpeg')
  assert.equal(meta.size, photoBody.byteLength)
  assert.equal(meta.sha256, sha256)
  assert.equal(meta.capturedAt, '2026-04-12T12:00:00Z')
  assert.equal(meta.originalFilename, 'lifecycle-test.jpg')
  assert.ok(meta.uploadedAt)
  assert.equal(meta.version, 1)

  // Step 4: GET /sideload/photos (list should include the photo)
  const listResp = await handleRequest(
    cfAccessRequest('https://example.workers.dev/sideload/photos', {
      requestId: 'req-lifecycle-list',
    }),
    env,
  )

  assert.equal(listResp.status, 200)
  const listBody = await listResp.json()
  assert.equal(listBody.photos.length, 1)
  assert.equal(listBody.photos[0].photoId, photoId)

  // Step 5: pending.json should be cleaned up
  const pendingKeys = [...r2._store.keys()].filter(k => k.includes('pending'))
  assert.equal(pendingKeys.length, 0, 'pending.json should be deleted after upload')
})

test('upload bytes with size mismatch returns 400 SIZE_MISMATCH', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const r2 = await loadMockR2()
  const env = { SIDELOAD_R2: r2 }

  const sha256 = 'a'.repeat(64)

  // Init with size=1024
  const initResp = await handleRequest(
    cfAccessRequest('https://example.workers.dev/sideload/photos/upload', {
      method: 'POST',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'leojkwan@gmail.com',
        'content-type': 'application/json',
        'x-request-id': 'req-mismatch-init',
      },
      body: JSON.stringify({
        contentType: 'image/jpeg',
        size: 1024,
        sha256,
      }),
    }),
    env,
  )

  const { uploadUrl } = await initResp.json()

  // Upload only 10 bytes
  const bytesResp = await handleRequest(
    cfAccessRequest(`https://example.workers.dev${uploadUrl}`, {
      method: 'POST',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'leojkwan@gmail.com',
        'content-type': 'application/octet-stream',
        'x-request-id': 'req-mismatch-bytes',
      },
      body: new ArrayBuffer(10),
    }),
    env,
  )

  assert.equal(bytesResp.status, 400)
  const body = await bytesResp.json()
  assert.equal(body.error, 'SIZE_MISMATCH')
})

test('upload bytes with hash mismatch returns 409 HASH_MISMATCH and cleans up', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const r2 = await loadMockR2()
  const env = { SIDELOAD_R2: r2 }

  const content = new TextEncoder().encode('some content')

  // Init with a wrong hash
  const initResp = await handleRequest(
    cfAccessRequest('https://example.workers.dev/sideload/photos/upload', {
      method: 'POST',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'leojkwan@gmail.com',
        'content-type': 'application/json',
        'x-request-id': 'req-hash-init',
      },
      body: JSON.stringify({
        contentType: 'image/jpeg',
        size: content.byteLength,
        sha256: 'b'.repeat(64),
      }),
    }),
    env,
  )

  const { photoId, uploadUrl } = await initResp.json()

  const bytesResp = await handleRequest(
    cfAccessRequest(`https://example.workers.dev${uploadUrl}`, {
      method: 'POST',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'leojkwan@gmail.com',
        'content-type': 'application/octet-stream',
        'x-request-id': 'req-hash-bytes',
      },
      body: content.buffer,
    }),
    env,
  )

  assert.equal(bytesResp.status, 409)
  const body = await bytesResp.json()
  assert.equal(body.error, 'HASH_MISMATCH')

  // pending.json should be cleaned up on mismatch
  const pendingKeys = [...r2._store.keys()].filter(k => k.includes(photoId))
  assert.equal(pendingKeys.length, 0, 'pending.json should be deleted on hash mismatch')
})

test('labels round-trip: set then get', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const r2 = await loadMockR2()
  const env = { SIDELOAD_R2: r2 }

  // Seed a photo (head check needs the original to exist)
  const { derivePrefix } = await import('../worker/src/sideload/auth.mjs')
  const prefix = await derivePrefix('leojkwan@gmail.com')
  await r2.put(`${prefix}/test-photo/original`, new ArrayBuffer(10))

  // Set labels
  const setResp = await handleRequest(
    cfAccessRequest('https://example.workers.dev/sideload/photos/test-photo/labels', {
      method: 'POST',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'leojkwan@gmail.com',
        'content-type': 'application/json',
        'x-request-id': 'req-labels-set',
      },
      body: JSON.stringify({
        labels: { merchant: 'Target', total: '45.99', currency: 'USD' },
      }),
    }),
    env,
  )

  assert.equal(setResp.status, 200)
  const setBody = await setResp.json()
  assert.deepEqual(setBody.labels, { merchant: 'Target', total: '45.99', currency: 'USD' })

  // Get labels
  const getResp = await handleRequest(
    cfAccessRequest('https://example.workers.dev/sideload/photos/test-photo/labels', {
      requestId: 'req-labels-get',
    }),
    env,
  )

  assert.equal(getResp.status, 200)
  const getBody = await getResp.json()
  assert.deepEqual(getBody.labels, { merchant: 'Target', total: '45.99', currency: 'USD' })
  assert.ok(getBody.updatedAt)
})

test('delete removes all files for a photo', async () => {
  const { handleRequest } = await import('../worker/src/index.mjs')
  const r2 = await loadMockR2()
  const env = { SIDELOAD_R2: r2 }

  const { derivePrefix } = await import('../worker/src/sideload/auth.mjs')
  const prefix = await derivePrefix('leojkwan@gmail.com')

  // Seed the four files that can exist for a photo
  await r2.put(`${prefix}/del-photo/original`, new ArrayBuffer(5))
  await r2.put(`${prefix}/del-photo/meta.json`, '{}')
  await r2.put(`${prefix}/del-photo/labels.json`, '{}')
  await r2.put(`${prefix}/del-photo/pending.json`, '{}')

  assert.equal(r2._store.size, 4)

  const resp = await handleRequest(
    cfAccessRequest('https://example.workers.dev/sideload/photos/del-photo', {
      method: 'DELETE',
      requestId: 'req-delete-all',
    }),
    env,
  )

  assert.equal(resp.status, 204)
  assert.equal(r2._store.size, 0)
})
