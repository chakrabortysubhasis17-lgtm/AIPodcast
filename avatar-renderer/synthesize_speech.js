import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const [,, inputSource, outputPath] = process.argv;

if (!inputSource || !outputPath) {
    console.error("Usage: node synthesize_speech.js <text|path_to_txt_file> <outputPath>");
    process.exit(1);
}

let text = inputSource;
if (fs.existsSync(inputSource) && inputSource.toLowerCase().endsWith('.txt')) {
    text = fs.readFileSync(inputSource, 'utf8');
}

if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
}
text = text.replace(/\[.*?\]/g, '').trim();

if (!text) {
    console.error("Error: Input text is empty.");
    process.exit(1);
}

const outDir = path.dirname(path.resolve(outputPath));
if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}

// Derive clean base name without extension to prevent .mp3.mp3 double extensions
const fileBase = path.basename(outputPath, path.extname(outputPath));
const uniqueId = `${fileBase}_${Date.now()}`;

async function synthesizeEdge(spokenText) {
    const tts = new MsEdgeTTS();
    const format = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3 || "audio-24khz-48kbitrate-mono-mp3";
    
    // Female Kolkata / West Bengal Neural Voice
    await tts.setMetadata("bn-IN-TanishaaNeural", format);

    // msedge-tts appends the extension automatically
    const generatedPath = await tts.toFile(outDir, spokenText, { filename: uniqueId });
    
    let resolvedMp3 = generatedPath;
    if (!resolvedMp3 || !fs.existsSync(resolvedMp3)) {
        const expected = path.join(outDir, `${uniqueId}.mp3`);
        if (fs.existsSync(expected)) {
            resolvedMp3 = expected;
        } else {
            throw new Error(`Edge TTS output not found at ${expected}`);
        }
    }
    return resolvedMp3;
}

async function synthesizeGoogleFallback(spokenText, targetWav) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=bn&client=tw-ob&q=${encodeURIComponent(spokenText.substring(0, 200))}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`Google Web TTS failed: HTTP ${res.status}`);
    
    const tempFallbackMp3 = path.join(outDir, `${uniqueId}_gfb.mp3`);
    fs.writeFileSync(tempFallbackMp3, Buffer.from(await res.arrayBuffer()));

    await new Promise((resolve, reject) => {
        const ff = spawn('ffmpeg', ['-y', '-i', tempFallbackMp3, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', targetWav]);
        ff.on('close', code => {
            if (fs.existsSync(tempFallbackMp3)) fs.unlinkSync(tempFallbackMp3);
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg fallback conversion failed with code ${code}`));
        });
        ff.on('error', reject);
    });
}

(async () => {
    let intermediateMp3 = null;
    try {
        intermediateMp3 = await synthesizeEdge(text);
    } catch (edgeErr) {
        console.warn("[TTS Warning] Edge Neural voice failed, switching to fallback:", edgeErr.message);
        try {
            await synthesizeGoogleFallback(text, outputPath);
            console.log("TTS_DONE:" + outputPath);
            process.exit(0);
        } catch (fallbackErr) {
            console.error("Fatal: Both Edge and Fallback TTS engines failed:", fallbackErr.message);
            process.exit(1);
        }
    }

    const ffmpeg = spawn('ffmpeg', [
        '-y',
        '-i', intermediateMp3,
        '-ar', '24000',
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        outputPath
    ]);

    let stderrData = "";
    ffmpeg.stderr.on('data', d => { stderrData += d.toString(); });

    ffmpeg.on('close', (code) => {
        if (intermediateMp3 && fs.existsSync(intermediateMp3)) {
            fs.unlinkSync(intermediateMp3);
        }
        if (code === 0 && fs.existsSync(outputPath)) {
            console.log("TTS_DONE:" + outputPath);
            process.exit(0);
        } else {
            console.error("FFmpeg conversion failed (Exit " + code + "): " + stderrData);
            process.exit(1);
        }
    });
})();
