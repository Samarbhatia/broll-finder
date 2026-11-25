# B-Roll Finder

Paste a narration script. It is split into scenes, then archive photos (Wikimedia Commons,
Library of Congress) and optional stock images (Pexels, Pixabay) are gathered for each scene.
One button downloads everything as a ZIP with `credits.txt`, `script.txt`, `manifest.json`
and `not-downloaded.txt` (videos are listed as links, not bundled).

## Deploy on Netlify
1. Put this folder in a GitHub repo (or drag the folder onto app.netlify.com/drop).
2. New site from Git. Publish directory `public`, functions `netlify/functions` (already in `netlify.toml`).
3. Done. No environment variables are required.

Optional environment variables:
- `APP_PASSCODE`: if set, visitors must type it under "Passcode" on the page. Use this if you
  do not want strangers using your Netlify function quota.
- `GROQ_MODEL`: override the default `openai/gpt-oss-120b`.
- `GROQ_API_KEY` / `PEXELS_API_KEY` / `PIXABAY_API_KEY`: fallback keys used only when a visitor
  sends none. Leave unset for a pure bring-your-own-key site.

## Bring your own keys
Each visitor pastes their own keys into the "Your API keys" box (each has a "Get a key" button):
- Groq (required): https://console.groq.com/keys
- Pexels (optional): https://www.pexels.com/api/
- Pixabay (optional): https://pixabay.com/api/docs/

Keys travel only in request headers over HTTPS, are never put in URLs, and are not stored or
logged by the functions. They stay in the visitor's browser: per tab by default, or on that
device if "Remember on this device" is ticked. No key ever appears in the page source.

## Important
- Licence labels come from each source's own data. They are a convenience, not legal advice.
  Items marked "verify" (ShareAlike/GFDL, Commons "Restrictions", Library of Congress items
  without a clear rights statement) need a look at the source page. Pexels/Pixabay images are
  generic stock, not records of a real event.
- The AI only splits your script and suggests search terms. It never writes narration.
  Write and fact-check that yourself.
- Tests: `npm test` (stubbed network; run it before deploying changes).
