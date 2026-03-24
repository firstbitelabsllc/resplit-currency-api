module.exports = {
  entry: [
    'currscript.js',
    'scripts/**/*.js',
    'worker/src/index.mjs',
  ],
  project: [
    'currscript.js',
    'scripts/**/*.js',
    'worker/src/**/*.mjs',
    'tests/**/*.js',
  ],
  ignoreDependencies: [
    '@sentry/node',
    'fs-extra',
  ],
  ignoreIssues: {
    'worker/src/fx-canary.mjs': ['exports'],
  },
}
