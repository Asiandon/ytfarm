# YT Farm — DailyFeedin Faceless News System

Automated faceless YouTube channel system with AI script generation, SEO optimization, and auto-publishing.

## Stack
- **Frontend:** Vanilla HTML/CSS/JS
- **Backend:** Netlify Serverless Functions
- **AI:** Claude API
- **Publishing:** YouTube Data API v3 OAuth 2.0

## Deploy to Netlify

1. Fork or clone this repo to GitHub
2. Go to netlify.com → Add new site → Import from GitHub
3. Select this repo → Deploy
4. Add environment variables in Netlify:
   - `YT_CLIENT_ID` — Google OAuth Client ID
   - `YT_CLIENT_SECRET` — Google OAuth Client Secret
5. Open your Netlify URL → Settings → Connect YouTube permanently

## Environment Variables

| Variable | Description |
|----------|-------------|
| `YT_CLIENT_ID` | Google Cloud OAuth 2.0 Client ID |
| `YT_CLIENT_SECRET` | Google Cloud OAuth 2.0 Client Secret |

## Features
- AI-powered breaking news scripts
- Auto SEO title + tags + description generation
- Thumbnail prompt generator (DALL·E 3 / Midjourney)
- YouTube auto-publish with US peak time scheduling
- Permanent OAuth — auto-refreshes every 50 minutes
- Multi-channel management
- Upload schedule calendar
