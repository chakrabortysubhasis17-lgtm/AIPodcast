import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const [,, inputSource, outputPath, avatarChoiceArg, toneArg] = process.argv;

if (!inputSource || !outputPath) {
    console.error("Usage: node synthesize_speech.js <text|path_to_txt_file> <outputPath> [avatar] [tone]");
    process.exit(1);
}

let text = inputSource;
if (fs.existsSync(inputSource)) {
    text = fs.readFileSync(inputSource, 'utf8');
}

function sanitizeText(raw) {
    if (!raw) return "";
    return raw
        .replace(/\[.*?\]/g, '') // strip all directive tags
        .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, '') // strip zero-width and directional marks
        .replace(/\u00A0/g, ' ') // non-breaking space
        .replace(/[—–]/g, ', ') // em-dash and en-dash to comma
        .replace(/…/g, '...')
        .replace(/[""]/g, '"')
        .replace(/['']/g, "'")
        .replace(/\r\n|\r|\n/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

text = sanitizeText(text);

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

const activeTone = (toneArg || 'neutral').toLowerCase().trim();
let audioFilter = "";
if (activeTone === 'friendly') {
    audioFilter = "asetrate=24000*1.025,atempo=0.9756";
} else if (activeTone === 'formal') {
    audioFilter = "atempo=0.97";
} else if (activeTone === 'informal') {
    audioFilter = "asetrate=24000*1.012,atempo=1.0375";
} else if (activeTone === 'authoritative') {
    audioFilter = "asetrate=24000*0.97,atempo=1.01";
}

function splitIntoChunks(fullText, maxLen = 220) {
    if (fullText.length <= maxLen) return [fullText];

    const sentences = fullText.split(/(?<=[।!?.\n])\s+/).filter(Boolean);
    const chunks = [];
    let cur = "";

    for (const s of sentences) {
        if ((cur + " " + s).trim().length <= maxLen) {
            cur = (cur + " " + s).trim();
        } else {
            if (cur) chunks.push(cur);
            if (s.length > maxLen) {
                const clauses = s.split(/(?<=[,;])\s+/).filter(Boolean);
                for (const c of clauses) {
                    if ((cur + " " + c).trim().length <= maxLen) {
                        cur = (cur + " " + c).trim();
                    } else {
                        if (cur) chunks.push(cur);
                        cur = c;
                    }
                }
            } else {
                cur = s;
            }
        }
    }
    if (cur) chunks.push(cur);
    return chunks.filter(c => c && c.trim().length > 0);
}

function generateSilenceAudio(targetPath, seconds) {
    return new Promise((resolve) => {
        const ffmpeg = spawn('ffmpeg', [
            '-y',
            '-f', 'lavfi',
            '-i', 'anullsrc=channel_layout=mono:sample_rate=24000',
            '-t', seconds.toFixed(2),
            '-c:a', 'libmp3lame',
            '-b:a', '48k',
            targetPath
        ]);
        ffmpeg.on('close', () => resolve());
    });
}

async function synthesizeSingleAudio(spokenText, voiceName, targetMp3) {
    const tts = new MsEdgeTTS();
    const format = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3 || "audio-24khz-48kbitrate-mono-mp3";
    await tts.setMetadata(voiceName, format);

    const streamResult = await tts.toStream(spokenText);
    const audioStream = streamResult.audioStream || streamResult;

    await new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(targetMp3);
        audioStream.pipe(fileStream);

        audioStream.once('error', (err) => {
            try { fileStream.destroy(); } catch (_) {}
            reject(err);
        });

        fileStream.once('finish', () => {
            if (fs.existsSync(targetMp3) && fs.statSync(targetMp3).size > 0) {
                resolve();
            } else {
                reject(new Error("Written file is empty"));
            }
        });

        fileStream.once('error', (err) => {
            try { fileStream.destroy(); } catch (_) {}
            reject(err);
        });
    });
}

async function synthesizeChunkWithFallbacks(chunkText, targetMp3) {
    // Tier 1: Primary voice with clean text
    try {
        await synthesizeSingleAudio(chunkText, selectedVoice, targetMp3);
        return;
    } catch (err1) {
        console.warn(`[TTS Tier 1 Notice] '${selectedVoice}' connection dropped. Retrying with simplified syntax in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
    }

    // Tier 2: Primary voice with simplified punctuation
    const simplifiedText = chunkText.replace(/[,;!?]/g, ' ').replace(/\s+/g, ' ').trim();
    try {
        await synthesizeSingleAudio(simplifiedText, selectedVoice, targetMp3);
        return;
    } catch (err2) {
        console.warn(`[TTS Tier 2 Notice] Retrying with alternate voice model in 2.5s...`);
        await new Promise(r => setTimeout(r, 2500));
    }

    // Tier 3: Alternate voice model
    const altVoice = isFemale ? 'bn-IN-BashkarNeural' : 'bn-IN-TanishaaNeural';
    try {
        await synthesizeSingleAudio(simplifiedText, altVoice, targetMp3);
        return;
    } catch (err3) {
        console.warn(`[TTS Tier 3 Notice] Checking English phonetics...`);
    }

    // Tier 4: English neural voice if no Bengali characters exist
    const hasBengali = /[\u0980-\u09FF]/.test(chunkText);
    if (!hasBengali) {
        try {
            await synthesizeSingleAudio(simplifiedText, 'en-IN-PrabhatNeural', targetMp3);
            return;
        } catch (err4) {
            console.warn(`[TTS Tier 4 Notice] English voice fallback skipped.`);
        }
    }

    // Tier 5: Safety silence padding to prevent pipeline termination
    console.warn(`[TTS Safety Pad] Generating silence padding (${chunkText.length} chars) to ensure broadcast completion.`);
    const estSec = Math.max(1.5, Math.round((chunkText.length / 14) * 10) / 10);
    await generateSilenceAudio(targetMp3, estSec);
}

(async () => {
    const chunks = splitIntoChunks(text);
    const tempFiles = [];

    for (let i = 0; i < chunks.length; i++) {
        if (i > 0) {
            await new Promise(r => setTimeout(r, 1200)); // Inter-chunk cooldown avoids CDN socket churn
        }
        const randomId = crypto.randomBytes(4).toString('hex');
        const chunkPath = path.join(outDir, `chunk_${Date.now()}_${i}_${randomId}.mp3`);
        await synthesizeChunkWithFallbacks(chunks[i], chunkPath);
        tempFiles.push(chunkPath);
    }

    const ffmpegArgs = ['-y'];
    let listFile = null;

    if (tempFiles.length === 1) {
        ffmpegArgs.push('-i', tempFiles[0]);
    } else {
        listFile = path.join(outDir, `concat_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.txt`);
        const listContent = tempFiles.map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
        fs.writeFileSync(listFile, listContent, 'utf8');
        ffmpegArgs.push('-f', 'concat', '-safe', '0', '-i', listFile);
    }

    if (audioFilter) {
        ffmpegArgs.push('-af', audioFilter);
    }

    ffmpegArgs.push('-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', outputPath);

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    let stderr = "";
    ffmpeg.stderr.on('data', d => { stderr += d.toString(); });

    ffmpeg.on('close', code => {
        tempFiles.forEach(f => { if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch (_) {} });
        if (listFile && fs.existsSync(listFile)) try { fs.unlinkSync(listFile); } catch (_) {}

        if (code === 0 && fs.existsSync(outputPath)) {
            console.log("TTS_DONE:" + outputPath);
            process.exit(0);
        } else {
            console.error("FFmpeg mastering failed (Exit " + code + "): " + stderr);
            process.exit(1);
        }
    });
})();