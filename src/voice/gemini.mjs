// Gemini TTS through the Google Cloud Text-to-Speech API, with your own gcloud
// login. No keys live in demoloom or in your repo:
//
//   gcloud auth login
//   gcloud config set project <your-project>          (or "project" in demoloom.json)
//   gcloud services enable texttospeech.googleapis.com
//
// The access token comes from `gcloud auth print-access-token` at render time.
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

let auth = null;
function gcloud() {
  if (auth) return auth;
  const run = (a) => execFileSync('gcloud', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try { auth = { token: run(['auth', 'print-access-token']), project: run(['config', 'get-value', 'project']) }; }
  catch (e) { throw new Error('voice "gemini" needs the gcloud CLI, logged in (gcloud auth login). ' + String(e.stderr || e.message).trim()); }
  return auth;
}

export async function gemini({ text, direction, voice, model, languageCode, project, outFile }) {
  const a = gcloud();
  const proj = project || a.project;
  if (!proj) throw new Error('voice "gemini": no gcloud project (gcloud config set project <id>, or voice.project in demoloom.json)');
  const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${a.token}`, 'x-goog-user-project': proj, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { prompt: direction || '', text },
      voice: { languageCode, name: voice, modelName: model },
      audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 44100 },
    }),
  });
  const j = await r.json();
  if (!j.audioContent) throw new Error('Gemini TTS: ' + JSON.stringify(j).slice(0, 400));
  writeFileSync(outFile, Buffer.from(j.audioContent, 'base64'));
}
