# Flight Deck — Job Search Operating System

Responsive tracker (mobile + desktop) with funnel logging, emotion protocol,
runway gauge, and a Claude Sonnet coach. Data syncs through Supabase using a
private sync code (tap ⇅ in the app).

## Already set up for you
- Supabase table + secure RPC functions (project `ywzvhloswottkasvhzfv`) — live, nothing to do
- Netlify site created: **flight-deck-job-search** → https://flight-deck-job-search.netlify.app

## Deploy (one time, ~3 minutes)
1. Push to GitHub:
   ```
   git init && git add -A && git commit -m "Flight Deck v1"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/flight-deck.git
   git push -u origin main
   ```
2. In Netlify (app.netlify.com → flight-deck-job-search):
   - Site configuration → Build & deploy → Link repository → pick your GitHub repo.
     (netlify.toml already tells it how to build.)
   - Site configuration → Environment variables → Add:
     `ANTHROPIC_API_KEY` = your key from console.anthropic.com
     (this powers the daily briefing + weekly review; keep it secret)
3. Netlify auto-builds. Open https://flight-deck-job-search.netlify.app

   Alternative without GitHub: `npm i -g netlify-cli && netlify login &&
   netlify link --id b5408b33-ad97-4400-bcaf-0dab6a2d557b && netlify deploy --prod`

## Cross-device sync
Open the app → tap **⇅** → copy the sync code → enter it on your other device.
Treat the code like a password; it is the only key to your data.

## Local development
```
npm install
npm run dev   # requires netlify-cli for the /api/coach function
```
