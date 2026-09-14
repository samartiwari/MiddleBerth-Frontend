# MiddleBerth web

A single-page demo for [MiddleBerth](https://github.com/samartiwari/MiddleBerth), a tatkal
train-booking backend. Sign up, pick a train, book a berth, pay with a Razorpay test card,
and watch every API call the page makes.

Plain HTML, CSS and JavaScript: no framework, no build step, nothing to install.

## Run it locally

```bash
python3 -m http.server 5173
```

Then open http://localhost:5173. It talks to the live API at
`https://api.middleberth.samartiwari.me`. To use a MiddleBerth running on this machine instead:

    http://localhost:5173/?api=http://localhost:8089

Only `localhost` addresses are accepted there, so a link can never point the page at
somebody else's server. Either way, the API must allow this page's address in its
`CORS_ALLOWED_ORIGINS`.

## Deploy

Cloudflare Pages, connected to this repository:

- Framework preset: none
- Build command: none
- Build output directory: `/`

`_headers` adds basic security headers. The page's address then goes into the API
server's `CORS_ALLOWED_ORIGINS`.
