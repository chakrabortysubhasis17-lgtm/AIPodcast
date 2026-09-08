import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const [,, inputSource, outputPath] = process.argv;

if (!inputSource || !outputPath) {
    console.error("Usage: node synthesize_speech.js <text|path_to_txt_file> <outputPath>");
    process.exit(1);
}

// Read from file if path exists and ends in .txt, otherwise use direct string
let text = inputSource;
if (fs.existsSync(inputSource) && inputSource.toLowerCase().endsWith('.txt')) {
    text = fs.readFileSync(inputSource, 'utf8');
}

// Strip BOM if present
if (text.charCodeAt(0) === 0xFEFF) {
    text = text.slice(1);
}
text = text.trim();

// Detect Bengali Unicode range (\u0980 - \u09FF)
const hasBengali = /[\u0980-\u09FF]/.test(text);
const lang = hasBengali ? 'bn' : 'en';

// Split along sentence terminators (Bengali Dari ।, question mark, exclamation, period)
function splitIntoChunks(input) {
    const parts = input.match(/[^।?!.,]+[।?!.,]?/g) || [input];
    const chunks = [];
    let current = "";

    for (const part of parts) {
        if ((current + part).length > 150) {
            if (current.trim()) chunks.push(current.trim());
            current = part;
        } else {
            current += part;
        }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks;
}

(async () => {
    try {
        const chunks = splitIntoChunks(text);
        const tempFiles = [];

        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${lang}&client=tw-ob&q=${encodeURIComponent(chunk)}`;
            
            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });

            if (!res.ok) {
                throw new Error(`Google TTS failed with HTTP ${res.status}: ${res.statusText}`);
            }

            const buffer = Buffer.from(await res.arrayBuffer());
            const partFile = outputPath.replace(/\.wav$/i, `_temp_${i}.mp3`);
            fs.writeFileSync(partFile, buffer);
            tempFiles.push(partFile);
        }

        // Merge segments to 24000Hz mono 16-bit PCM WAV for Rhubarb
        const concatListPath = outputPath.replace(/\.wav$/i, '_list.txt');
        const listContent = tempFiles.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
        fs.writeFileSync(concatListPath, listContent, 'utf8');

        const ffmpeg = spawn('ffmpeg', [
            '-y',
            '-f', 'concat',
            '-safe', '0',
            '-i', concatListPath,
            '-ar', '24000',
            '-ac', '1',
            '-c:a', 'pcm_s16le',
            outputPath
        ]);

        ffmpeg.on('close', (code) => {
            tempFiles.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
            if (fs.existsSync(concatListPath)) fs.unlinkSync(concatListPath);

            if (code === 0 && fs.existsSync(outputPath)) {
                console.log(`TTS synthesis successful: ${outputPath} [lang=${lang}]`);
                process.exit(0);
            } else {
                console.error(`FFmpeg concat failed with code ${code}`);
                process.exit(1);
            }
        });
    } catch (err) {
        console.error("TTS Error:", err.message);
        process.exit(1);
    }
})();
