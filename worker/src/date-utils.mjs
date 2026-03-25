/**
 * @param {string} value
 * @returns {boolean}
 */
function isValidISODate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }

  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/**
 * @param {string} value
 * @param {string} [label]
 * @returns {string}
 */
export function normalizeISODate(value, label = 'date') {
  if (!isValidISODate(value)) {
    throw new Error(`Invalid ${label}: ${value}`)
  }

  return value
}

/**
 * @param {string} dateString
 * @param {number} days
 * @returns {string}
 */
export function dateDaysBefore(dateString, days) {
  const date = new Date(`${normalizeISODate(dateString)}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

/**
 * @param {Date} [today]
 * @returns {string}
 */
export function todayDateString(today = new Date()) {
  return today.toISOString().slice(0, 10)
}
