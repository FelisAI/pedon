# Security

PEDON runs on your own computer. Two servers start with `npm run dev`:

- **The viewer's dev server** (`localhost:5178`) listens on localhost only. It writes design files,
  runs the project's Python tools and queues renders, so every endpoint that takes a POST refuses a
  request that does not come from the viewer's own page (a page on another site, open in the same
  browser, cannot drive it), and every request body has a size limit
  (`pedon/viewer/server_http.js`, held by `pedon/tests/js/server_writes.test.mjs`).
- **The phone's door** (port 5179) listens on your local network so a phone can fetch the AR file.
  It is read-only and serves only the active site's `data/ar` folder. Anyone on the same network can
  read that folder while the viewer is running.

The design agent runs on a model CLI you are logged in to. PEDON stores no API keys, and its tools
must not require one.

## Reporting a problem

Please report a vulnerability privately — open a GitHub security advisory on this repository
rather than a public issue — with what you found and how to reproduce it.
