/**
 * In-memory mock of a Cloudflare R2 bucket binding.
 *
 * Implements: put, get, head, delete, list — enough to exercise
 * all sideload route handlers without hitting real R2.
 */

export function createMockR2() {
  const store = new Map()

  return {
    /** Expose internals for test assertions. */
    _store: store,

    async put(key, value, options = {}) {
      const buffer =
        value instanceof ArrayBuffer
          ? value
          : typeof value === 'string'
            ? new TextEncoder().encode(value).buffer
            : value
      store.set(key, {
        body: buffer,
        httpMetadata: options.httpMetadata || {},
        customMetadata: options.customMetadata || {},
        size: buffer.byteLength,
      })
      const etag = `mock-etag-${key.split('/').pop()}`
      return { etag, key }
    },

    async get(key) {
      const entry = store.get(key)
      if (!entry) return null
      const { body, httpMetadata, customMetadata, size } = entry
      return {
        key,
        size,
        httpMetadata,
        customMetadata,
        etag: `mock-etag-${key.split('/').pop()}`,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(body))
            controller.close()
          },
        }),
        async json() {
          return JSON.parse(new TextDecoder().decode(body))
        },
        async text() {
          return new TextDecoder().decode(body)
        },
        async arrayBuffer() {
          return body
        },
      }
    },

    async head(key) {
      const entry = store.get(key)
      if (!entry) return null
      return {
        key,
        size: entry.size,
        httpMetadata: entry.httpMetadata,
        customMetadata: entry.customMetadata,
        etag: `mock-etag-${key.split('/').pop()}`,
      }
    },

    async delete(keyOrKeys) {
      const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]
      for (const k of keys) {
        store.delete(k)
      }
    },

    async list({ prefix = '', delimiter, limit = 1000, cursor } = {}) {
      const allKeys = [...store.keys()].filter(k => k.startsWith(prefix))

      if (delimiter) {
        const prefixes = new Set()
        for (const k of allKeys) {
          const rest = k.slice(prefix.length)
          const idx = rest.indexOf(delimiter)
          if (idx >= 0) {
            prefixes.add(prefix + rest.slice(0, idx + 1))
          }
        }
        const sorted = [...prefixes].sort()
        const start = cursor ? sorted.indexOf(cursor) + 1 : 0
        const page = sorted.slice(start, start + limit)
        const truncated = start + limit < sorted.length
        return {
          delimitedPrefixes: page,
          objects: [],
          truncated,
          cursor: truncated ? page[page.length - 1] : undefined,
        }
      }

      const sorted = allKeys.sort()
      const start = cursor ? sorted.indexOf(cursor) + 1 : 0
      const page = sorted.slice(start, start + limit)
      const truncated = start + limit < sorted.length
      return {
        objects: page.map(k => ({
          key: k,
          size: store.get(k).size,
          etag: `mock-etag-${k.split('/').pop()}`,
        })),
        delimitedPrefixes: [],
        truncated,
        cursor: truncated ? page[page.length - 1] : undefined,
      }
    },
  }
}
