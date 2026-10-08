# Word timings for voiceover lines with faster-whisper (optional).
#   python align.py a.wav b.wav ...  ->  JSON on stdout: [[[word, start, end], ...], ...]
# Install with: pip install faster-whisper   (the model downloads on first use)
# DEMOLOOM_WHISPER_MODEL picks the model (default base.en).
import json, os, sys
from faster_whisper import WhisperModel

m = WhisperModel(os.environ.get('DEMOLOOM_WHISPER_MODEL', 'base.en'), compute_type='int8')
out = []
for f in sys.argv[1:]:
    segs, _ = m.transcribe(f, word_timestamps=True)
    out.append([[w.word.strip(), round(w.start, 2), round(w.end, 2)] for s in segs for w in s.words])
print(json.dumps(out))
