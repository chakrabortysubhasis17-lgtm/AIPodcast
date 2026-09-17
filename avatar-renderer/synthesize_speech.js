import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const [,, inputSource, outputPath, avatarChoiceArg] = process.argv;

if (!inputSource || !outputPath) {
    console.error("Usage: node synthesize_speech.js <text|path_to_txt_file> <outputPath> [avatar]");
    process.exit(1);
}

let text = inputSource;
if (fs.existsSync(inputSource)) {
    text = fs.readFileSync(inputSource, 'utf8');
}

if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
}
text = text.replace(/\[.*?\]/g, '').trim();

if (!text) {
    console.error("Error: Spoken text is empty.");
    process.exit(1);
}

const outDir = path.dirname(path.resolve(outputPath));
if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}

const rawAvatar = (avatarChoiceArg || 'shubo').toLowerCase().trim();
const isFemale = rawAvatar.includes('mina') || rawAvatar.includes('tina') || rawAvatar.includes('female');
const selectedVoice = isFemale ? 'bn-IN-TanishaaNeural' : 'bn-IN-BashkarNeural';

console.log(`[TTS Engine] Avatar: '${rawAvatar}' | Voice: '${selectedVoice}' | Output: '${outputPath}'`);

async function synthesizeEdgeStream(spokenText) {
    const tts = new MsEdgeTTS();
    const format = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3 || "audio-24khz-48kbitrate-mono-mp3";
    await tts.setMetadata(selectedVoice, format);

    // Stream directly into a unique temp file to eliminate multi-segment collisions
    const randomId = crypto.randomBytes(6).toString('hex');
    const tempMp3Path = path.join(outDir, `temp_seg_${Date.now()}_${randomId}.mp3`);

    const streamResult = await tts.toStream(spokenText);
    const audioStream = streamResult.audioStream || streamResult;

    await new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(tempMp3Path);
        audioStream.pipe(fileStream);

        audioStream.once('error', (err) => {
            fileStream.destroy();
            reject(err);
        });

        fileStream.once('finish', () => {
            if (fs.existsSync(tempMp3Path) && fs.statSync(tempMp3Path).size > 0) {
                resolve();
            } else {
                reject(new Error("Audio stream finished but written file is empty."));
            }
        });

        fileStream.once('error', reject);
    });

    return tempMp3Path;
}

(async () => {
    let tempMp3 = null;
    try {
        tempMp3 = await synthesizeEdgeStream(text);
    } catch (err) {
        console.error(`[TTS Fatal] Voice generation failed for '${selectedVoice}':`, err.message);
        process.exit(1);
    }

    const ffmpeg = spawn('ffmpeg', [
        '-y',
        '-i', tempMp3,
        '-ar', '24000',
        '-ac', '1',
        '-c:a', 'pcm_s16le',
        outputPath
    ]);

    let stderrData = "";
    ffmpeg.stderr.on('data', d => { stderrData += d.toString(); });

    ffmpeg.on('close', (code) => {
        if (tempMp3 && fs.existsSync(tempMp3)) {
            try { fs.unlinkSync(tempMp3); } catch (_) {}
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