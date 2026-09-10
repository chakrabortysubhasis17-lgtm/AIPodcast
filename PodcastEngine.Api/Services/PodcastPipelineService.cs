using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using PodcastEngine.Api.Common;

namespace PodcastEngine.Api.Services
{
    public class TimelineEvent
    {
        public double time { get; set; }
        public string type { get; set; } = string.Empty;
        public string value { get; set; } = string.Empty;
        public string position { get; set; } = "top-left";
    }

    public class SfxCue
    {
        public double Time { get; set; }
        public string FilePath { get; set; } = string.Empty;
    }

    public class BgmCue
    {
        public double Time { get; set; }
        public string FilePath { get; set; } = string.Empty;
    }

    internal class ScriptSegment
    {
        public int Index { get; set; }
        public double PauseSec { get; set; }
        public string Cam { get; set; } = string.Empty;
        public string Emotion { get; set; } = string.Empty;
        public string Gesture { get; set; } = string.Empty;
        public string LowerThird { get; set; } = string.Empty;
        public string Show { get; set; } = string.Empty;
        public string ShowPos { get; set; } = "top-left";
        public bool Hide { get; set; }
        public string Sfx { get; set; } = string.Empty;
        public string Bgm { get; set; } = string.Empty;
        public string SpeechText { get; set; } = string.Empty;
        public string WavPath { get; set; } = string.Empty;
        public double Duration { get; set; }
    }

    public class PodcastPipelineService
    {
        private readonly JobProgressService _progress;
        private readonly string _storageBase;
        private readonly string _assetsBase;

        public PodcastPipelineService(JobProgressService progress)
        {
            _progress = progress;
            _storageBase = PathHelper.StorageBase;
            _assetsBase = PathHelper.AssetsBase;
            Directory.CreateDirectory(_storageBase);
        }

        public async Task ExecutePipelineAsync(string jobId, string script, string sessionDir, string avatar, CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested();

            // =========================================================
            // STEP 1: PARALLEL VOICE SYNTHESIS & TIMELINE SYNC (0% -> 25%)
            // =========================================================
            _progress.Report(jobId, 1, 0, 0, "[TTS] Parsing script segments and scheduling parallel synthesis...");

            var rawParagraphs = script.Split(new[] { "\r\n\r\n", "\n\n" }, StringSplitOptions.RemoveEmptyEntries);
            var parsedSegments = new List<ScriptSegment>();

            for (int pIdx = 0; pIdx < rawParagraphs.Length; pIdx++)
            {
                string para = rawParagraphs[pIdx].Trim();
                if (string.IsNullOrWhiteSpace(para)) continue;

                var seg = new ScriptSegment { Index = pIdx };

                var pauseMatch = Regex.Match(para, @"\[Pause:\s*([0-9.]+)s?\]", RegexOptions.IgnoreCase);
                if (pauseMatch.Success && double.TryParse(pauseMatch.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out double pSec))
                    seg.PauseSec = pSec;

                var camMatch = Regex.Match(para, @"\[Cam:\s*([a-zA-Z0-9_\s-]+)\]", RegexOptions.IgnoreCase);
                if (camMatch.Success) seg.Cam = camMatch.Groups[1].Value.Trim().ToLower();

                var emoMatch = Regex.Match(para, @"\[Emotion:\s*([a-zA-Z0-9_\s-]+)\]", RegexOptions.IgnoreCase);
                if (emoMatch.Success) seg.Emotion = emoMatch.Groups[1].Value.Trim().ToLower();

                var gestMatch = Regex.Match(para, @"\[Gesture:\s*([a-zA-Z0-9_\s-]+)\]", RegexOptions.IgnoreCase);
                if (gestMatch.Success) seg.Gesture = gestMatch.Groups[1].Value.Trim().ToLower();

                var ltMatch = Regex.Match(para, @"\[LowerThird:\s*[""']?([^""'\]]+)[""']?\]", RegexOptions.IgnoreCase);
                if (ltMatch.Success) seg.LowerThird = ltMatch.Groups[1].Value.Trim();

                var showMatch = Regex.Match(para, @"\[Show:\s*[""']?([^""'\]\s]+)[""']?(?:\s+at\s+[a-zA-Z-]+)?\s*\]", RegexOptions.IgnoreCase);
                if (showMatch.Success)
                {
                    seg.Show = showMatch.Groups[1].Value.Trim();
                    seg.ShowPos = "top-left";
                }

                if (Regex.IsMatch(para, @"\[Hide(?::\s*Overlay)?\]", RegexOptions.IgnoreCase))
                    seg.Hide = true;

                var sfxMatch = Regex.Match(para, @"\[SFX:\s*([a-zA-Z0-9_\s-]+)\]", RegexOptions.IgnoreCase);
                if (sfxMatch.Success) seg.Sfx = sfxMatch.Groups[1].Value.Trim();

                var bgmMatch = Regex.Match(para, @"\[BGM:\s*([a-zA-Z0-9_\s-]+)\]", RegexOptions.IgnoreCase);
                bool isDefBgm = Regex.IsMatch(para, @"\[DefBGM\]", RegexOptions.IgnoreCase);
                if (isDefBgm) seg.Bgm = "lofi";
                else if (bgmMatch.Success) seg.Bgm = bgmMatch.Groups[1].Value.Trim();

                seg.SpeechText = Regex.Replace(para, @"\[.*?\]", "").Trim();
                parsedSegments.Add(seg);
            }

            var speechItems = parsedSegments.Where(s => !string.IsNullOrEmpty(s.SpeechText)).ToList();
            var throttler = new SemaphoreSlim(4);
            int completedTts = 0;

            var ttsTasks = speechItems.Select(async seg =>
            {
                await throttler.WaitAsync(ct);
                try
                {
                    string segmentWav = Path.Combine(sessionDir, $"speech_{seg.Index}.wav");
                    await SynthesizeSegmentSpeechAsync(seg.SpeechText, segmentWav, ct);
                    seg.WavPath = segmentWav;
                    seg.Duration = GetWavDurationSeconds(segmentWav);

                    int c = Interlocked.Increment(ref completedTts);
                    int stepPct = (int)(((double)c / speechItems.Count) * 100);
                    int overallPct = (int)(((double)c / speechItems.Count) * 25);
                    _progress.Report(jobId, 1, stepPct, overallPct, $"[TTS] Synthesized dialogue segment {c}/{speechItems.Count} ({seg.Duration:F1}s)");
                }
                finally
                {
                    throttler.Release();
                }
            });

            await Task.WhenAll(ttsTasks);

            double runningTime = 0.0;
            var timeline = new List<TimelineEvent>();
            var sfxCues = new List<SfxCue>();
            var bgmCues = new List<BgmCue>();
            var orderedAudioFiles = new List<string>();

            foreach (var seg in parsedSegments)
            {
                if (seg.PauseSec > 0)
                {
                    string pauseWav = Path.Combine(sessionDir, $"pause_{seg.Index}.wav");
                    CreateSilenceWav(pauseWav, seg.PauseSec);
                    if (File.Exists(pauseWav))
                    {
                        orderedAudioFiles.Add(pauseWav);
                        runningTime += seg.PauseSec;
                    }
                }

                if (!string.IsNullOrEmpty(seg.Cam))
                    timeline.Add(new TimelineEvent { time = runningTime, type = "cam", value = seg.Cam });
                if (!string.IsNullOrEmpty(seg.Emotion))
                    timeline.Add(new TimelineEvent { time = runningTime, type = "emotion", value = seg.Emotion });
                if (!string.IsNullOrEmpty(seg.Gesture))
                    timeline.Add(new TimelineEvent { time = runningTime, type = "gesture", value = seg.Gesture });
                if (!string.IsNullOrEmpty(seg.LowerThird))
                    timeline.Add(new TimelineEvent { time = runningTime, type = "lowerthird", value = seg.LowerThird });
                if (!string.IsNullOrEmpty(seg.Show))
                    timeline.Add(new TimelineEvent { time = runningTime, type = "show", value = seg.Show, position = seg.ShowPos });
                if (seg.Hide)
                    timeline.Add(new TimelineEvent { time = runningTime, type = "hide", value = "" });

                if (!string.IsNullOrEmpty(seg.Sfx))
                {
                    string resolved = ResolveSfxFile(seg.Sfx);
                    if (File.Exists(resolved))
                    {
                        sfxCues.Add(new SfxCue { Time = runningTime, FilePath = resolved });
                        timeline.Add(new TimelineEvent { time = runningTime, type = "sfx", value = seg.Sfx });
                    }
                }

                if (!string.IsNullOrEmpty(seg.Bgm))
                {
                    string resolved = ResolveBgmFile(seg.Bgm);
                    if (File.Exists(resolved))
                    {
                        bgmCues.Add(new BgmCue { Time = runningTime, FilePath = resolved });
                        timeline.Add(new TimelineEvent { time = runningTime, type = "bgm", value = seg.Bgm });
                    }
                }

                if (!string.IsNullOrEmpty(seg.SpeechText) && File.Exists(seg.WavPath))
                {
                    timeline.Add(new TimelineEvent { time = runningTime, type = "text", value = seg.SpeechText });
                    orderedAudioFiles.Add(seg.WavPath);
                    runningTime += seg.Duration;
                }
            }

            string rawSpeechWav = Path.Combine(sessionDir, "speech_master.wav");
            await ConcatWavsAsync(orderedAudioFiles, rawSpeechWav, ct);
            _progress.Report(jobId, 1, 100, 25, $"[TTS] Master speech track assembled. Total length: {runningTime:F1}s");

            // =========================================================
            // STEP 2: RHUBARB LIP SYNC (25% -> 50%)
            // =========================================================
            _progress.Report(jobId, 2, 0, 25, "[Rhubarb] Generating phonemes aligned to speech master...");
            string phonemesJsonPath = Path.Combine(sessionDir, "phonemes.json");

            await GeneratePhonemesAsync(rawSpeechWav, phonemesJsonPath, jobId, ct);

            int mouthCuesCount = 0;
            if (File.Exists(phonemesJsonPath))
            {
                using var doc = JsonDocument.Parse(await File.ReadAllTextAsync(phonemesJsonPath, ct));
                if (doc.RootElement.TryGetProperty("mouthCues", out var cues))
                    mouthCuesCount = cues.GetArrayLength();
            }
            _progress.Report(jobId, 2, 100, 50, $"[Rhubarb] Generated {mouthCuesCount} lip-sync cues.");

            string timelinePath = Path.Combine(sessionDir, "timeline.json");
            await File.WriteAllTextAsync(timelinePath, JsonSerializer.Serialize(timeline, new JsonSerializerOptions { WriteIndented = true }), new UTF8Encoding(false), ct);

            // =========================================================
            // STEP 3: STREAMLINED BGM & SFX DUCKING (50% -> 70%)
            // =========================================================
            _progress.Report(jobId, 3, 0, 50, "[FFmpeg] Building dynamic soundtrack and sidechain ducking...");
            string bgmMasterWav = Path.Combine(sessionDir, "bgm_composed.wav");
            await BuildCompositeBgmTrackAsync(bgmCues, runningTime, bgmMasterWav, ct);

            string masterMixWav = Path.Combine(sessionDir, "master_mix.wav");
            await ApplySidechainDuckingAndSfxAsync(rawSpeechWav, bgmMasterWav, sfxCues, masterMixWav, jobId, ct);
            _progress.Report(jobId, 3, 100, 70, "[FFmpeg] Sidechain ducking applied. Master mix ready.");

            // =========================================================
            // STEP 4: BATCHED WEBGL COMPOSITE (70% -> 100%)
            // =========================================================
            _progress.Report(jobId, 4, 0, 70, $"[Three.js] Initializing Headless Chromium WebGL context for avatar: {avatar}...");
            string outputMp4 = Path.Combine(sessionDir, "podcast.mp4");

            await RenderAvatarAsync(jobId, sessionDir, timelinePath, phonemesJsonPath, masterMixWav, outputMp4, avatar, ct);
            _progress.Report(jobId, 4, 100, 100, "[Render Complete] Video broadcast exported: podcast.mp4", "completed");
        }

        private void CreateSilenceWav(string outputPath, double seconds)
        {
            string dur = seconds.ToString("F3", CultureInfo.InvariantCulture);
            var psi = new ProcessStartInfo
            {
                FileName = "ffmpeg",
                Arguments = $"-y -f lavfi -i anullsrc=channel_layout=mono:sample_rate=24000 -t {dur} -c:a pcm_s16le \"{outputPath}\"",
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardError = true
            };
            using var p = Process.Start(psi) ?? throw new InvalidOperationException("Failed to generate silence via FFmpeg.");
            p.WaitForExit();
        }

        private string ClampSfxAudio(string inputPath, string outputPath, double maxSec = 3.0)
        {
            double fadeStart = Math.Max(0.1, maxSec - 0.5);
            var psi = new ProcessStartInfo
            {
                FileName = "ffmpeg",
                Arguments = $"-y -i \"{inputPath}\" -t {maxSec.ToString(System.Globalization.CultureInfo.InvariantCulture)} -af \"afade=t=out:st={fadeStart.ToString(System.Globalization.CultureInfo.InvariantCulture)}:d=0.5\" -ar 48000 -ac 1 \"{outputPath}\"",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardError = true
            };
            using var p = Process.Start(psi);
            p?.WaitForExit();
            return outputPath;
        }

        private double GetWavDurationSeconds(string wavPath)
        {
            var fi = new FileInfo(wavPath);
            if (fi.Length > 44)
            {
                return (fi.Length - 44.0) / 48000.0;
            }
            return 1.0;
        }

        private async Task ConcatWavsAsync(List<string> wavFiles, string outputWav, CancellationToken ct)
        {
            var existingFiles = wavFiles.Where(File.Exists).ToList();
            if (existingFiles.Count == 0)
                throw new InvalidOperationException("No audio segments exist to concatenate.");

            if (existingFiles.Count == 1)
            {
                File.Copy(existingFiles[0], outputWav, true);
                return;
            }

            string listFile = Path.ChangeExtension(outputWav, "_list.txt");
            var sb = new StringBuilder();
            foreach (var f in existingFiles)
            {
                string safePath = f.Replace("\\", "/").Replace("'", "'\\''");
                sb.AppendLine($"file '{safePath}'");
            }

            await File.WriteAllTextAsync(listFile, sb.ToString(), new UTF8Encoding(false), ct);

            var psi = new ProcessStartInfo
            {
                FileName = "ffmpeg",
                Arguments = $"-y -f concat -safe 0 -i \"{listFile}\" -c:a pcm_s16le -ar 24000 -ac 1 \"{outputWav}\"",
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardError = true
            };

            using var p = Process.Start(psi) ?? throw new InvalidOperationException("Failed to start FFmpeg concat.");
            string err = await p.StandardError.ReadToEndAsync(ct);
            await p.WaitForExitAsync(ct);

            if (File.Exists(listFile)) File.Delete(listFile);

            if (p.ExitCode != 0 || !File.Exists(outputWav))
                throw new InvalidOperationException($"FFmpeg concat failed (Exit {p.ExitCode}): {err}");
        }

        private async Task SynthesizeSegmentSpeechAsync(string text, string outputPath, CancellationToken ct)
        {
            text = System.Text.RegularExpressions.Regex.Replace(text, @"(?<=[\d\u09E6-\u09EF])\s*[-\u2013\u2014]\s*(?=[\d\u09E6-\u09EF])", " ");
            text = System.Text.RegularExpressions.Regex.Replace(text, @"(?<=[০-৯])\s*[-–—]\s*(?=[০-৯])", " ");
            string txtFile = Path.ChangeExtension(outputPath, ".txt");
            await File.WriteAllTextAsync(txtFile, text, new UTF8Encoding(false), ct);

            var psi = new ProcessStartInfo
            {
                FileName = "node",
                Arguments = $"synthesize_speech.js \"{txtFile}\" \"{outputPath}\"",
                WorkingDirectory = PathHelper.AvatarRendererBase,
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardError = true,
                RedirectStandardOutput = true
            };

            using var p = Process.Start(psi) ?? throw new InvalidOperationException("Failed to start speech node.");
            string err = await p.StandardError.ReadToEndAsync(ct);
            await p.WaitForExitAsync(ct);

            if (File.Exists(txtFile)) File.Delete(txtFile);
            if (p.ExitCode != 0 || !File.Exists(outputPath))
                throw new InvalidOperationException($"Speech segment synthesis failed: {err}");
        }

        private string ResolveSfxFile(string sfxName)
        {
            string sfxFolder = Path.Combine(_assetsBase, "sfx");
            string normalized = sfxName.ToLower().Trim().Replace(" ", "_").Replace("-", "_");

            string directPath = Path.Combine(sfxFolder, $"{normalized}.mp3");
            if (File.Exists(directPath)) return directPath;

            if (normalized.Contains("scratch")) return Path.Combine(sfxFolder, "record_scratch.mp3");
            if (normalized.Contains("shutter")) return Path.Combine(sfxFolder, "camera_shutter.mp3");
            if (normalized.Contains("thud")) return Path.Combine(sfxFolder, "dramatic_thud.mp3");
            if (normalized.Contains("roar")) return Path.Combine(sfxFolder, "stadium_roar.mp3");
            if (normalized.Contains("boo")) return Path.Combine(sfxFolder, "crowd_boo.mp3");

            var match = Directory.GetFiles(sfxFolder, $"{normalized}*.mp3").FirstOrDefault();
            return match ?? Path.Combine(sfxFolder, "ding.mp3");
        }

        private string ResolveBgmFile(string bgmName)
        {
            string musicFolder = Path.Combine(_assetsBase, "music");
            string normalized = bgmName.ToLower().Trim().Replace(" ", "_").Replace("bgm_", "");

            if (normalized == "defbgm" || normalized == "default")
                return Path.Combine(musicFolder, "lofi.mp3");

            string directPath = Path.Combine(musicFolder, $"{normalized}.mp3");
            if (File.Exists(directPath)) return directPath;

            if (normalized.Contains("melanchol")) return Path.Combine(musicFolder, "melancholy.mp3");
            if (normalized.Contains("upbeat")) return Path.Combine(musicFolder, "upbeat.mp3");
            if (normalized.Contains("lofi") || normalized.Contains("chill")) return Path.Combine(musicFolder, "lofi.mp3");

            return Path.Combine(musicFolder, "lofi.mp3");
        }

        private async Task BuildCompositeBgmTrackAsync(List<BgmCue> bgmCues, double totalDuration, string outputBgmWav, CancellationToken ct)
        {
            string musicFolder = Path.Combine(_assetsBase, "music");
            string defaultMusic = Path.Combine(musicFolder, "lofi.mp3");

            if (bgmCues.Count == 0)
                bgmCues.Add(new BgmCue { Time = 0.0, FilePath = defaultMusic });

            bgmCues = bgmCues.OrderBy(c => c.Time).ToList();
            if (bgmCues[0].Time > 0.0)
                bgmCues.Insert(0, new BgmCue { Time = 0.0, FilePath = bgmCues[0].FilePath });

            if (bgmCues.Count == 1)
            {
                string src = File.Exists(bgmCues[0].FilePath) ? bgmCues[0].FilePath : defaultMusic;
                string durStr = totalDuration.ToString("F2", CultureInfo.InvariantCulture);
                var psi = new ProcessStartInfo
                {
                    FileName = "ffmpeg",
                    Arguments = $"-y -stream_loop -1 -i \"{src}\" -t {durStr} -af \"afade=t=in:st=0:d=0.3,afade=t=out:st={Math.Max(0, totalDuration - 0.5).ToString("F2", CultureInfo.InvariantCulture)}:d=0.5\" -c:a pcm_s16le -ar 24000 -ac 1 \"{outputBgmWav}\"",
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    RedirectStandardError = true
                };
                using var p = Process.Start(psi)!;
                await p.WaitForExitAsync(ct);
                return;
            }

            var segmentWavs = new List<string>();
            string tempDir = Path.GetDirectoryName(outputBgmWav)!;

            for (int i = 0; i < bgmCues.Count; i++)
            {
                double start = bgmCues[i].Time;
                double end = (i + 1 < bgmCues.Count) ? bgmCues[i + 1].Time : totalDuration;
                double duration = Math.Max(0.5, end - start);

                string segFile = Path.Combine(tempDir, $"bgm_seg_{i}.wav");
                string src = File.Exists(bgmCues[i].FilePath) ? bgmCues[i].FilePath : defaultMusic;

                string durStr = duration.ToString("F2", CultureInfo.InvariantCulture);
                string fadeOutStr = Math.Max(0, duration - 0.3).ToString("F2", CultureInfo.InvariantCulture);

                var psi = new ProcessStartInfo
                {
                    FileName = "ffmpeg",
                    Arguments = $"-y -stream_loop -1 -i \"{src}\" -t {durStr} -af \"afade=t=in:st=0:d=0.3,afade=t=out:st={fadeOutStr}:d=0.3\" -c:a pcm_s16le -ar 24000 -ac 1 \"{segFile}\"",
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    RedirectStandardError = true
                };

                using var p = Process.Start(psi)!;
                await p.WaitForExitAsync(ct);
                segmentWavs.Add(segFile);
            }

            await ConcatWavsAsync(segmentWavs, outputBgmWav, ct);
            foreach (var f in segmentWavs) { if (File.Exists(f)) File.Delete(f); }
        }

        private async Task GeneratePhonemesAsync(string inputWav, string outputJson, string jobId, CancellationToken ct)
        {
            if (!File.Exists(inputWav))
                throw new FileNotFoundException($"Input speech file does not exist: {inputWav}");

            string rhubarbExe = @"D:\Rhubarb\Rhubarb-Lip-Sync-1.14.0-Windows\rhubarb.exe";
            if (!File.Exists(rhubarbExe)) rhubarbExe = "rhubarb";

            var psi = new ProcessStartInfo
            {
                FileName = rhubarbExe,
                Arguments = $"-r phonetic -f json -o \"{outputJson}\" \"{inputWav}\"",
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };

            using var p = new Process { StartInfo = psi };
            var stderr = new StringBuilder();

            p.OutputDataReceived += (_, e) => { };
            p.ErrorDataReceived += (_, e) =>
            {
                if (!string.IsNullOrWhiteSpace(e.Data))
                {
                    stderr.AppendLine(e.Data);
                    var match = Regex.Match(e.Data, @"(\d{1,3})%");
                    if (match.Success && int.TryParse(match.Groups[1].Value, out int pct))
                    {
                        int stepPct = Math.Clamp(pct, 0, 100);
                        int overallPct = Math.Clamp(25 + (int)Math.Round(pct * 0.25), 25, 50);
                        _progress.Report(jobId, 2, stepPct, overallPct, $"[Rhubarb] Analyzing speech phonetics ({stepPct}%)");
                    }
                }
            };

            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            var ticker = Task.Run(async () =>
            {
                int cur = 5;
                while (!p.HasExited)
                {
                    try { await Task.Delay(500); } catch { break; }
                    if (p.HasExited || cts.Token.IsCancellationRequested) break;

                    if (cur < 95)
                    {
                        cur += 5;
                        int overallPct = Math.Clamp(25 + (int)Math.Round(cur * 0.25), 25, 50);
                        _progress.Report(jobId, 2, cur, overallPct, $"[Rhubarb] Analyzing speech phonetics ({cur}%)...");
                    }
                }
            }, cts.Token);

            await p.WaitForExitAsync(ct);
            cts.Cancel();

            if (p.ExitCode != 0 || !File.Exists(outputJson))
            {
                string errText = stderr.ToString().Trim();
                throw new InvalidOperationException($"Rhubarb failed (Exit {p.ExitCode}): {errText}");
            }
        }

        private async Task ApplySidechainDuckingAndSfxAsync(string speechWav, string bgmTrackWav, List<SfxCue> sfxCues, string outputWav, string jobId, CancellationToken ct)
        {
            var sb = new StringBuilder();
            var filterSb = new StringBuilder();

            sb.Append($"-y -i \"{speechWav}\" -i \"{bgmTrackWav}\" ");
            int inputIndex = 2;

            var sfxInputs = new List<(int Idx, double Time)>();
            foreach (var cue in sfxCues)
            {
                if (File.Exists(cue.FilePath))
                {
                    sb.Append($"-i \"{cue.FilePath}\" ");
                    sfxInputs.Add((inputIndex++, cue.Time));
                }
            }

            filterSb.Append("[1:a]volume=0.20[bgmNorm];");
            filterSb.Append("[bgmNorm][0:a]sidechaincompress=threshold=0.08:ratio=6:attack=20:release=300[duckedBgm];");

            var mixInputs = new List<string> { "[0:a]", "[duckedBgm]" };

            for (int i = 0; i < sfxInputs.Count; i++)
            {
                var item = sfxInputs[i];
                long delayMs = (long)(item.Time * 1000);
                filterSb.Append($"[{item.Idx}:a]aresample=24000,aformat=channel_layouts=mono,adelay=delays={delayMs}:all=1,volume=0.85[sfx{i}];");
                mixInputs.Add($"[sfx{i}]");
            }

            string combined = string.Join("", mixInputs);
            filterSb.Append($"{combined}amix=inputs={mixInputs.Count}:duration=first:dropout_transition=2[masterAudio]");

            sb.Append($"-filter_complex \"{filterSb}\" -map \"[masterAudio]\" -c:a pcm_s16le -ar 24000 -ac 1 \"{outputWav}\"");

            var psi = new ProcessStartInfo
            {
                FileName = "ffmpeg",
                Arguments = sb.ToString(),
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardError = true
            };

            using var p = Process.Start(psi) ?? throw new InvalidOperationException("Failed to invoke FFmpeg audio mixer.");
            string err = await p.StandardError.ReadToEndAsync(ct);
            await p.WaitForExitAsync(ct);

            if (p.ExitCode != 0 || !File.Exists(outputWav))
                throw new InvalidOperationException($"FFmpeg mastering failed (Exit {p.ExitCode}): {err}");
        }

        private async Task RenderAvatarAsync(string jobId, string sessionDir, string timelinePath, string phonemesPath, string audioPath, string outputPath, string avatar, CancellationToken ct)
        {
            var psi = new ProcessStartInfo
            {
                FileName = "node",
                Arguments = $"render_avatar.js \"{sessionDir}\" \"{timelinePath}\" \"{phonemesPath}\" \"{audioPath}\" \"{outputPath}\" \"{avatar}\"",
                WorkingDirectory = PathHelper.AvatarRendererBase,
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };

            using var p = Process.Start(psi) ?? throw new InvalidOperationException("Failed to invoke avatar renderer.");

            p.OutputDataReceived += (_, e) =>
            {
                if (string.IsNullOrEmpty(e.Data)) return;

                if (e.Data.StartsWith("PROGRESS:"))
                {
                    var parts = e.Data.Split(':');
                    if (parts.Length == 3 && int.TryParse(parts[1], out int cur) && int.TryParse(parts[2], out int total))
                    {
                        int stepPct = (int)((cur * 100.0) / total);
                        int overallPct = 70 + (int)((cur * 30.0) / total);
                        _progress.Report(jobId, 4, stepPct, overallPct, $"[Three.js] Rendered frame {cur}/{total} ({stepPct}%)");
                    }
                }
            };

            p.BeginOutputReadLine();
            string stderr = await p.StandardError.ReadToEndAsync(ct);
            await p.WaitForExitAsync(ct);

            if (p.ExitCode != 0 || !File.Exists(outputPath))
                throw new InvalidOperationException($"Avatar rendering failed: {stderr}");
        }
    }
}
