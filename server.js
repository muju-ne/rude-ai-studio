import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { GoogleGenAI } from '@google/genai';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 3000);
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

const upload = multer({
  dest: path.join(os.tmpdir(), 'rude-ai-uploads'),
  limits: { fileSize: 80 * 1024 * 1024 }
});

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function requireKey(res) {
  if (!ai) {
    res.status(500).json({ error: 'GEMINI_API_KEY is not configured on the server.' });
    return false;
  }
  return true;
}

function parseJson(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}
  }
  return { raw: cleaned };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'RUDE AI STUDIO', aiConfigured: Boolean(ai) });
});

app.post('/api/analyze-recording', upload.single('audio'), async (req, res) => {
  if (!requireKey(res)) return;
  if (!req.file) return res.status(400).json({ error: 'Please upload or record an audio file.' });

  try {
    const uploaded = await ai.files.upload({
      file: req.file.path,
      config: { mimeType: req.file.mimetype || 'audio/webm' }
    });

    const interaction = await ai.interactions.create({
      model: 'gemini-3.8-flash',
      input: [
        { type: 'text', text: `Analyze this music/vocal recording for production purposes. Return ONLY valid JSON with these keys: style, mood, tempo_estimate_bpm, vocal_character, rhythm, instruments_or_timbres, suggested_genres, production_notes. Do not identify or imitate a real artist. If an item cannot be confidently estimated, use null. Focus on musical characteristics useful for creating an original backing track.` },
        { type: 'audio', uri: uploaded.uri, mime_type: uploaded.mimeType || req.file.mimetype || 'audio/webm' }
      ]
    });

    res.json({ analysis: parseJson(interaction.output_text) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error?.message || 'Audio analysis failed.' });
  } finally {
    fs.promises.unlink(req.file.path).catch(() => {});
  }
});

app.post('/api/generate-beat', async (req, res) => {
  if (!requireKey(res)) return;
  const { prompt = '', analysis = {} } = req.body || {};
  const musical = typeof analysis === 'string' ? analysis : JSON.stringify(analysis);
  const finalPrompt = `Create an ORIGINAL instrumental backing track for a singer. No copied song, no named artist imitation, and no copyrighted lyrics. Musical analysis from the user's recording: ${musical}. User direction: ${prompt || 'Make a polished modern backing track that leaves clear space for the lead vocal.'}. Prefer a clean arrangement with an intro, main groove, variation, and outro. Keep the instrumental suitable for mixing with a separate vocal. Generate about 60-90 seconds for this prototype.`;

  try {
    const response = await ai.models.generateContent({
      model: 'lyria-3.5',
      contents: finalPrompt,
      config: {
        responseModalities: ['AUDIO', 'TEXT'],
        responseFormat: { audio: { mimeType: 'audio/wav' } }
      }
    });

    let audio = null;
    for (const part of response?.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData?.data) {
        audio = part.inlineData.data;
        break;
      }
    }
    if (!audio) return res.status(502).json({ error: 'The music model returned no audio.' });
    res.json({ audioBase64: audio, mimeType: 'audio/wav' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error?.message || 'Music generation failed.' });
  }
});

app.post('/api/mix-master', upload.fields([
  { name: 'vocal', maxCount: 1 },
  { name: 'beat', maxCount: 1 }
]), async (req, res) => {
  const vocal = req.files?.vocal?.[0];
  const beat = req.files?.beat?.[0];
  if (!vocal || !beat) return res.status(400).json({ error: 'Both vocal and beat are required.' });

  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rude-mix-'));
  const outMp3 = path.join(work, 'rude-ai-master.mp3');
  const outWav = path.join(work, 'rude-ai-master.wav');

  try {
    // Prototype production chain: vocal cleanup + balanced beat + stereo mix + loudness normalization.
    await execFileAsync(ffmpegPath, [
      '-y', '-i', vocal.path, '-i', beat.path,
      '-filter_complex',
      '[0:a]highpass=f=70,acompressor=threshold=-18dB:ratio=3:attack=8:release=100[v];[1:a]volume=0.62[b];[v][b]amix=inputs=2:duration=longest:dropout_transition=2,loudnorm=I=-14:TP=-1.5:LRA=11[m]',
      '-map', '[m]', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', outWav
    ], { timeout: 180000 });

    await execFileAsync(ffmpegPath, [
      '-y', '-i', outWav, '-codec:a', 'libmp3lame', '-b:a', '192k', outMp3
    ], { timeout: 120000 });

    const mp3 = (await fs.promises.readFile(outMp3)).toString('base64');
    const wav = (await fs.promises.readFile(outWav)).toString('base64');
    res.json({ mp3Base64: mp3, wavBase64: wav, mp3MimeType: 'audio/mpeg', wavMimeType: 'audio/wav' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error?.message || 'Mix/master failed.' });
  } finally {
    await Promise.all([
      fs.promises.rm(work, { recursive: true, force: true }),
      fs.promises.unlink(vocal.path).catch(() => {}),
      fs.promises.unlink(beat.path).catch(() => {})
    ]);
  }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(port, () => console.log(`RUDE AI STUDIO running on port ${port}`));
