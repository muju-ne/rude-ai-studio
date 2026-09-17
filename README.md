# RUDE AI STUDIO

Deployable Node/Express website for the RUDE AI STUDIO prototype.

## What it does
1. Records or uploads a vocal.
2. Uses Gemini audio understanding to analyze musical characteristics.
3. Uses Lyria 3.5 to generate an original instrumental guided by that analysis.
4. Uses FFmpeg to mix the original vocal with the generated beat and apply a basic loudness/production chain.
5. Offers MP3 and WAV output.

## Render
- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Environment variable: `GEMINI_API_KEY` = your Google AI Studio API key

Do not commit `.env` or any API key to GitHub.
