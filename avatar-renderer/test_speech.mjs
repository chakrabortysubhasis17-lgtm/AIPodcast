import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

(async () => {
    try {
        const tts = new MsEdgeTTS();
        const voices = await tts.getVoices();
        
        // Find best Kolkata / West Bengal voice
        const bnVoice = voices.find(v => v.ShortName === "bn-IN-BashkarNeural")
                     || voices.find(v => v.Locale === "bn-IN")
                     || voices.find(v => v.Locale.startsWith("bn"))
                     || { ShortName: "bn-IN-BashkarNeural" };

        console.log(`[TTS] Selected Voice: ${bnVoice.ShortName} (${bnVoice.FriendlyName || bnVoice.Locale})`);

        const format = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3 || "audio-24khz-48kbitrate-mono-mp3";
        await tts.setMetadata(bnVoice.ShortName, format);

        const sampleText = "কলকাতা বিরিয়ানির আলু থেকে ডার্বির ময়দান, সকালের বাজারের তাজা ইলিশ থেকে রকের সন্ধেবেলা আড্ডা... ফুটবল অনেকের কাছে just ৯০ মিনিটের একটা game, but কিছু club-এর কাছে ফুটবল মানে বেঁচে থাকার লড়াই।";
        
        const tempMp3 = path.resolve("./test_temp.mp3");
        const outWav = path.resolve("./test_bengali.wav");

        console.log("[TTS] Streaming audio from Microsoft Edge Neural engine...");
        const readable = tts.toStream(sampleText);
        const fileStream = fs.createWriteStream(tempMp3);

        await new Promise((resolve, reject) => {
            readable.pipe(fileStream);
            fileStream.on('finish', resolve);
            fileStream.on('error', reject);
            readable.on('error', reject);
        });

        console.log("[TTS] Stream completed. Converting to 24kHz PCM WAV via FFmpeg...");
        const ffmpeg = spawn('ffmpeg', [
            '-y',
            '-i', tempMp3,
            '-ar', '24000',
            '-ac', '1',
            '-c:a', 'pcm_s16le',
            outWav
        ]);

        ffmpeg.on('close', (code) => {
            if (fs.existsSync(tempMp3)) fs.unlinkSync(tempMp3);
            if (code === 0 && fs.existsSync(outWav)) {
                console.log("[TTS] Success! Generated: " + outWav);
                process.exit(0);
            } else {
                console.error("[TTS] FFmpeg exited with code " + code);
                process.exit(1);
            }
        });
    } catch (err) {
        console.error("[TTS Error Stack]:", err);
        process.exit(1);
    }
})();
