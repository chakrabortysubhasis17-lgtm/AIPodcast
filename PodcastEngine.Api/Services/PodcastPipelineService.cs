using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using PodcastEngine.Api.Common;

namespace PodcastEngine.Api.Services
{
    public class PodcastPipelineService
    {
        private readonly JobProgressService _progress;
        private readonly string _storageBase;
        private readonly string _assetsBase;

        private static readonly HttpClient _httpClient = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        private static Process? _daemonProcess;
        private static readonly SemaphoreSlim _daemonLock = new SemaphoreSlim(1, 1);
        private const int DaemonPort = 5055;

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

            _progress.Report(jobId, 1, 0, 0, "[TTS] Parsing script segments and scheduling parallel synthesis...");

            var lines = script.Split(new[] { "\r\n", "\n" }, StringSplitOptions.None);
            var rawParagraphsList = new List<string>();
            var currentBlock = new StringBuilder();
            bool blockHasSpeech = false;

            foreach (var line in lines)
            {
                string trimmed = line.Trim();
                if (string.IsNullOrWhiteSpace(trimmed))
                {
                    if (currentBlock.Length > 0)
                    {
                        rawParagraphsList.Add(currentBlock.ToString().Trim());
                        currentBlock.Clear();
                        blockHasSpeech = false;
                    }
                    continue;
                }

                bool isDirectiveLine = trimmed.StartsWith("[") && Regex.IsMatch(trimmed, @"^\[[a-zA-Z0-9_\s-]+:");
                if (blockHasSpeech && isDirectiveLine)
                {
                    rawParagraphsList.Add(currentBlock.ToString().Trim());
                    currentBlock.Clear();
                    blockHasSpeech = false;
                }

                currentBlock.AppendLine(line);
                string textWithoutTags = Regex.Replace(trimmed, @"\[.*?\]", "").Trim();
                if (!string.IsNullOrEmpty(textWithoutTags))
                {
                    blockHasSpeech = true;
                }
            }

            if (currentBlock.Length > 0)
            {
                rawParagraphsList.Add(currentBlock.ToString().Trim());
            }

            var rawParagraphs = rawParagraphsList.ToArray();
            var parsedSegments = new List<ScriptSegment>();

            for (int pIdx = 0; pIdx < rawParagraphs.Length; pIdx++)
            {
                string para = rawParagraphs[pIdx].Trim();
                if (string.IsNullOrWhiteSpace(para)) continue;

                var seg = new ScriptSegment { Index = pIdx };

                var toneMatch = Regex.Match(para, @"\[(Friendly|Formal|Informal|Authoritative)\]", RegexOptions.IgnoreCase);
                seg.Tone = toneMatch.Success ? toneMatch.Groups[1].Value.Trim().ToLower() : "neutral";

                var stingerMatch = Regex.Match(para, @"\[Stinger(?::\s*([a-zA-Z0-9_\s-]+))?\]", RegexOptions.IgnoreCase);
                if (stingerMatch.Success)
                {
                    seg.Stinger = stingerMatch.Groups[1].Success ? stingerMatch.Groups[1].Value.Trim() : "intro";
                }

                var pauseMatch = Regex.Match(para, @"\[Pause:\s*([0-9.]+)s?\]", RegexOptions.IgnoreCase);
                if (pauseMatch.Success && double.TryParse(pauseMatch.Groups[1].Value, NumberStyles.Float, CultureInfo.InvariantCulture, out double pSec))
                    seg.PauseSec = pSec;

                var camMatch = Regex.Match(para, @"\[Cam:\s*([a-zA-Z0-9_\s-]+)\]", RegexOptions.IgnoreCase);
                if (camMatch.Success) seg.Cam = camMatch.Groups[1].Value.Trim().ToLower();

                var emoMatch = Regex.Match(para, @"\[Emotion:\s*([a-zA-Z0-9_\s-]+)\]", RegexOptions.IgnoreCase);
                if (emoMatch.Success) seg.Emotion = emoMatch.Groups[1].Value.Trim().ToLower();

                var gestMatch = Regex.Match(para, @"\[Gesture:\s*([a-zA-Z0-9_\s-]+)\]", RegexOptions.IgnoreCase);
                if (gestMatch.Success) seg.Gesture = gestMatch.Groups[1].Value.Trim().ToLower();

                var bgMatch = Regex.Match(para, @"\[Bg:\s*[""']?([^""'\]\s]+)[""']?\]", RegexOptions.IgnoreCase);
                if (bgMatch.Success) seg.Bg = bgMatch.Groups[1].Value.Trim();

                var iconMatch = Regex.Match(para, @"\[(?:Icon|Emoji):\s*[""']?([^""'\]]+)[""']?\]", RegexOptions.IgnoreCase);
                if (iconMatch.Success) seg.Icon = iconMatch.Groups[1].Value.Trim();

                var ltMatch = Regex.Match(para, @"\[LowerThird:\s*[""']?([^""'\]]+)[""']?\]", RegexOptions.IgnoreCase);
                if (ltMatch.Success) seg.LowerThird = ltMatch.Groups[1].Value.Trim();

                var showMatch = Regex.Match(para, @"\[Show:\s*[""']?([^""'\]\s]+)[""']?(?:\s+at\s+[a-zA-Z-]+)?\s*\]", RegexOptions.IgnoreCase);
                if (showMatch.Success)
                {
                    seg.Show = showMatch.Groups[1].Value.Replace("\"", "").Replace("'", "").Trim();
                    seg.ShowPos = "top-left";
                }

                var hideMatches = Regex.Matches(para, @"\[Hide(?::\s*([a-zA-Z0-9_\s-]+))?\]", RegexOptions.IgnoreCase);
                foreach (Match hm in hideMatches)
                {
                    string target = hm.Groups[1].Success ? hm.Groups[1].Value.Trim().ToLower() : "overlay";
                    seg.HideTargets.Add(target);
                    seg.Hide = true;
                }

                var sfxMatches = Regex.Matches(para, @"\[SFX:\s*([a-zA-Z0-9_\s-]+)\]", RegexOptions.IgnoreCase);
                foreach (Match m in sfxMatches)
                {
                    seg.SfxList.Add(m.Groups[1].Value.Trim());
                }

                if (seg.SfxList.Count > 0 && seg.PauseSec > 0)
                {
                    seg.PauseSec = Math.Max(0.0, seg.PauseSec - 0.8);
                }

                var bgmMatch = Regex.Match(para, @"\[BGM:\s*([a-zA-Z0-9_\s-]+)\]", RegexOptions.IgnoreCase);
                bool isDefBgm = Regex.IsMatch(para, @"\[DefBGM\]", RegexOptions.IgnoreCase);
                if (isDefBgm) seg.Bgm = "lofi";
                else if (bgmMatch.Success) seg.Bgm = bgmMatch.Groups[1].Value.Trim();

                var ambMatch = Regex.Match(para, @"\[(?:Ambience|Atmosphere):\s*[""']?([^""'\]\s]+)[""']?\]", RegexOptions.IgnoreCase);
                if (ambMatch.Success) seg.Ambience = ambMatch.Groups[1].Value.Trim();

                string extractedSpeech = Regex.Replace(para, @"\[.*?\]", "").Trim();
                seg.SpeechText = BengaliPhoneticNormalizer.Normalize(extractedSpeech);

                parsedSegments.Add(seg);
            }

            var speechItems = parsedSegments.Where(s => !string.IsNullOrEmpty(s.SpeechText)).ToList();
            var throttler = new SemaphoreSlim(2);
            int completedTts = 0;

            var ttsTasks = speechItems.Select(async seg =>
            {
                await throttler.WaitAsync(ct);
                try
                {
                    string segmentWav = Path.Combine(sessionDir, $"speech_{seg.Index}.wav");
                    await SynthesizeSegmentSpeechAsync(seg.SpeechText, segmentWav, avatar, seg.Tone, ct);
                    seg.WavPath = segmentWav;
                    seg.Duration = GetWavDurationSeconds(segmentWav);

                    int c = Interlocked.Increment(ref completedTts);
                    int stepPct = (int)(((double)c / speechItems.Count) * 100);
                    int overallPct = (int)(((double)c / speechItems.Count) * 20);
                    _progress.Report(jobId, 1, stepPct, overallPct, $"[TTS] Synthesized dialogue segment {c}/{speechItems.Count} ({seg.Duration:F1}s)");

                    string segPhonemesJson = Path.Combine(sessionDir, $"phonemes_seg_{seg.Index}.json");
                    await ExtractSegmentPhonemesAsync(segmentWav, segPhonemesJson, ct);
                    if (File.Exists(segPhonemesJson))
                    {
                        using var doc = JsonDocument.Parse(await File.ReadAllTextAsync(segPhonemesJson, ct));
                        if (doc.RootElement.TryGetProperty("mouthCues", out var cues))
                        {
                            foreach (var item in cues.EnumerateArray())
                            {
                                seg.MouthCues.Add(new MouthCueItem
                                {
                                    start = item.GetProperty("start").GetDouble(),
                                    end = item.GetProperty("end").GetDouble(),
                                    value = item.GetProperty("value").GetString() ?? "X"
                                });
                            }
                        }
                    }
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
            var ambienceCues = new List<AmbienceCue>();
            var orderedAudioFiles = new List<string>();
            var masterMouthCues = new List<MouthCueItem>();
            bool hasActiveOverlay = false;

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

                if (!string.IsNullOrEmpty(seg.Bgm))
                {
                    string resolved = ResolveBgmFile(seg.Bgm);
                    if (File.Exists(resolved))
                    {
                        bgmCues.Add(new BgmCue { Time = runningTime, FilePath = resolved });
                        timeline.Add(new TimelineEvent { time = runningTime, type = "bgm", value = seg.Bgm });
                    }
                }

                if (!string.IsNullOrEmpty(seg.Ambience))
                {
                    string resolvedAmb = ResolveAmbienceFile(seg.Ambience);
                    if (File.Exists(resolvedAmb))
                    {
                        ambienceCues.Add(new AmbienceCue { Time = runningTime, FilePath = resolvedAmb });
                        timeline.Add(new TimelineEvent { time = runningTime, type = "ambience", value = seg.Ambience });
                    }
                }

                if (!string.IsNullOrEmpty(seg.Stinger))
                {
                    string resolvedStinger = ResolveStingerFile(seg.Stinger);
                    if (File.Exists(resolvedStinger))
                    {
                        string clampedStinger = Path.Combine(sessionDir, $"stinger_{seg.Index}.wav");
                        ClampSfxAudio(resolvedStinger, clampedStinger, 3.5);
                        string finalStinger = File.Exists(clampedStinger) ? clampedStinger : resolvedStinger;

                        sfxCues.Add(new SfxCue { Time = runningTime, FilePath = finalStinger });
                        timeline.Add(new TimelineEvent { time = runningTime, type = "stinger", value = seg.Stinger });
                    }
                }

                double sfxHoldDuration = 0.0;
                int sfxSubIdx = 0;
                foreach (var sfxItem in seg.SfxList)
                {
                    string resolved = ResolveSfxFile(sfxItem);
                    if (File.Exists(resolved))
                    {
                        string clampedSfx = Path.Combine(sessionDir, $"sfx_{seg.Index}_{sfxSubIdx++}.wav");
                        ClampSfxAudio(resolved, clampedSfx, 2.2);
                        string finalSfx = File.Exists(clampedSfx) ? clampedSfx : resolved;

                        sfxCues.Add(new SfxCue { Time = runningTime, FilePath = finalSfx });
                        timeline.Add(new TimelineEvent { time = runningTime, type = "sfx", value = sfxItem });
                        sfxHoldDuration += 2.0;
                    }
                }

                if (sfxHoldDuration > 0 && !string.IsNullOrEmpty(seg.SpeechText))
                {
                    string sfxPauseWav = Path.Combine(sessionDir, $"sfx_hold_{seg.Index}.wav");
                    CreateSilenceWav(sfxPauseWav, sfxHoldDuration);
                    if (File.Exists(sfxPauseWav))
                    {
                        orderedAudioFiles.Add(sfxPauseWav);
                        runningTime += sfxHoldDuration;
                    }
                }

                // Visual Directives
                if (!string.IsNullOrEmpty(seg.Tone) && seg.Tone != "neutral")
                    timeline.Add(new TimelineEvent { time = runningTime, type = "tone", value = seg.Tone });
                if (!string.IsNullOrEmpty(seg.Cam))
                    timeline.Add(new TimelineEvent { time = runningTime, type = "cam", value = seg.Cam });
                if (!string.IsNullOrEmpty(seg.Emotion))
                    timeline.Add(new TimelineEvent { time = runningTime, type = "emotion", value = seg.Emotion });
                if (!string.IsNullOrEmpty(seg.Gesture))
                    timeline.Add(new TimelineEvent { time = runningTime, type = "gesture", value = seg.Gesture });

                if (!string.IsNullOrEmpty(seg.Bg))
                    timeline.Add(new TimelineEvent { time = runningTime, type = "bg", value = seg.Bg });
                if (!string.IsNullOrEmpty(seg.Icon))
                    timeline.Add(new TimelineEvent { time = runningTime, type = "icon", value = seg.Icon });

                if (!string.IsNullOrEmpty(seg.LowerThird))
                    timeline.Add(new TimelineEvent { time = runningTime, type = "lowerthird", value = seg.LowerThird });

                if (!string.IsNullOrEmpty(seg.Show))
                {
                    timeline.Add(new TimelineEvent { time = runningTime, type = "show", value = seg.Show, position = seg.ShowPos });
                    hasActiveOverlay = true;
                }
                else if (seg.HideTargets.Count > 0)
                {
                    foreach (var ht in seg.HideTargets)
                    {
                        string val = ht;
                        if (val == "show" || val == "overlay") val = "";
                        timeline.Add(new TimelineEvent { time = runningTime, type = "hide", value = val });
                        if (string.IsNullOrEmpty(val)) hasActiveOverlay = false;
                    }
                }
                else if (hasActiveOverlay)
                {
                    timeline.Add(new TimelineEvent { time = runningTime, type = "hide", value = "" });
                    hasActiveOverlay = false;
                }

                if (!string.IsNullOrEmpty(seg.SpeechText) && File.Exists(seg.WavPath))
                {
                    timeline.Add(new TimelineEvent { time = runningTime, type = "text", value = seg.SpeechText });
                    orderedAudioFiles.Add(seg.WavPath);

                    foreach (var cue in seg.MouthCues)
                    {
                        masterMouthCues.Add(new MouthCueItem
                        {
                            start = Math.Round(runningTime + cue.start, 3),
                            end = Math.Round(runningTime + cue.end, 3),
                            value = cue.value
                        });
                    }

                    runningTime += seg.Duration;
                }
            }

            double maxAudioEnd = runningTime;
            if (sfxCues.Count > 0)
            {
                double lastCueEnd = sfxCues.Max(c => c.Time) + 3.2;
                if (lastCueEnd > maxAudioEnd) maxAudioEnd = lastCueEnd;
            }

            if (maxAudioEnd > runningTime)
            {
                double paddingNeeded = Math.Round(maxAudioEnd - runningTime + 0.5, 2);
                string tailSilenceWav = Path.Combine(sessionDir, "stinger_tail_padding.wav");
                CreateSilenceWav(tailSilenceWav, paddingNeeded);
                if (File.Exists(tailSilenceWav))
                {
                    orderedAudioFiles.Add(tailSilenceWav);
                    runningTime += paddingNeeded;
                }
            }

            string rawSpeechWav = Path.Combine(sessionDir, "speech_master.wav");
            await ConcatWavsAsync(orderedAudioFiles, rawSpeechWav, ct);
            _progress.Report(jobId, 1, 100, 25, $"[TTS] Master speech track assembled. Total length: {runningTime:F1}s");

            string phonemesJsonPath = Path.Combine(sessionDir, "phonemes.json");
            var phonemesPayload = new
            {
                metadata = new { duration = Math.Round(runningTime, 2) },
                mouthCues = masterMouthCues.OrderBy(c => c.start).ToList()
            };
            await File.WriteAllTextAsync(phonemesJsonPath, JsonSerializer.Serialize(phonemesPayload, new JsonSerializerOptions { WriteIndented = true }), new UTF8Encoding(false), ct);
            _progress.Report(jobId, 2, 100, 50, $"[Rhubarb] Generated {masterMouthCues.Count} lip-sync cues.");

            string timelinePath = Path.Combine(sessionDir, "timeline.json");
            var timelineTask = File.WriteAllTextAsync(timelinePath, JsonSerializer.Serialize(timeline, new JsonSerializerOptions { WriteIndented = true }), new UTF8Encoding(false), ct);

            string bgmMasterWav = Path.Combine(sessionDir, "bgm_composed.wav");
            string ambienceMasterWav = Path.Combine(sessionDir, "ambience_composed.wav");
            string masterMixWav = Path.Combine(sessionDir, "master_mix.wav");

            _progress.Report(jobId, 3, 0, 50, "[FFmpeg] Building broadcast acoustics, ambience bed, and sidechain ducking...");
            var audioMasterTask = Task.Run(async () =>
            {
                await BuildCompositeBgmTrackAsync(bgmCues, runningTime, bgmMasterWav, ct);
                await BuildCompositeAmbienceTrackAsync(ambienceCues, runningTime, ambienceMasterWav, ct);
                await ApplyBroadcastMasteringMixAsync(rawSpeechWav, bgmMasterWav, ambienceMasterWav, sfxCues, masterMixWav, jobId, ct);
                _progress.Report(jobId, 3, 100, 70, "[FFmpeg] Broadcast room warmth, dynamic swells, and mastering applied.");
            }, ct);

            await Task.WhenAll(timelineTask, audioMasterTask);

            _progress.Report(jobId, 4, 0, 70, $"[Three.js] Initializing Headless Chromium WebGL context for avatar: {avatar}...");
            string outputMp4 = Path.Combine(sessionDir, "podcast.mp4");

            await RenderAvatarAsync(jobId, sessionDir, timelinePath, phonemesJsonPath, masterMixWav, outputMp4, avatar, ct);
            _progress.Report(jobId, 4, 100, 100, "[Render Complete] Video broadcast exported: podcast.mp4", "completed");
        }

        private async Task ExtractSegmentPhonemesAsync(string segmentWav, string outputJson, CancellationToken ct)
        {
            string rhubarbExe = @"D:\Rhubarb\Rhubarb-Lip-Sync-1.14.0-Windows\rhubarb.exe";
            if (!File.Exists(rhubarbExe)) rhubarbExe = "rhubarb";

            var psi = new ProcessStartInfo
            {
                FileName = rhubarbExe,
                Arguments = $"-r phonetic -f json -o \"{outputJson}\" \"{segmentWav}\"",
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };

            using var p = Process.Start(psi);
            if (p != null) await p.WaitForExitAsync(ct);
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

        private string ClampSfxAudio(string inputPath, string outputPath, double maxSec = 2.2)
        {
            double fadeStart = Math.Max(0.1, maxSec - 0.4);
            var psi = new ProcessStartInfo
            {
                FileName = "ffmpeg",
                Arguments = $"-y -i \"{inputPath}\" -t {maxSec.ToString(CultureInfo.InvariantCulture)} -af \"afade=t=out:st={fadeStart.ToString(CultureInfo.InvariantCulture)}:d=0.4\" -ar 24000 -ac 1 \"{outputPath}\"",
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardError = true
            };
            using var p = Process.Start(psi);
            if (p != null)
            {
                p.StandardError.ReadToEnd();
                p.WaitForExit();
            }
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

        private async Task SynthesizeSegmentSpeechAsync(string text, string outputPath, string avatar, string tone, CancellationToken ct)
        {
            text = Regex.Replace(text, @"[\u200B-\u200D\uFEFF\u200E\u200F\u00A0]", " ");
            text = Regex.Replace(text, @"[—–]", ", ");
            text = Regex.Replace(text, @"(?<=[\d\u09E6-\u09EF])\s*[-\u2013\u2014]\s*(?=[\d\u09E6-\u09EF])", " ");
            text = Regex.Replace(text, @"(?<=[০-৯])\s*[-–—]\s*(?=[০-৯])", " ");
            string txtFile = Path.ChangeExtension(outputPath, ".txt");
            await File.WriteAllTextAsync(txtFile, text, new UTF8Encoding(false), ct);

            var psi = new ProcessStartInfo
            {
                FileName = "node",
                Arguments = $"synthesize_speech.js \"{txtFile}\" \"{outputPath}\" \"{avatar}\" \"{tone}\"",
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

        private string ResolveStingerFile(string stingerName)
        {
            string sfxFolder = Path.Combine(_assetsBase, "sfx");
            string musicFolder = Path.Combine(_assetsBase, "music");
            string norm = stingerName.ToLower().Trim().Replace(" ", "_").Replace("-", "_");

            string[] candidates = new[]
            {
                Path.Combine(sfxFolder, $"stinger_{norm}.mp3"),
                Path.Combine(sfxFolder, $"stinger_{norm}.wav"),
                Path.Combine(sfxFolder, "stinger.mp3"),
                Path.Combine(musicFolder, $"stinger_{norm}.mp3"),
                Path.Combine(sfxFolder, "camera_shutter.mp3"),
                Path.Combine(sfxFolder, "ding.mp3")
            };

            foreach (var path in candidates)
            {
                if (File.Exists(path)) return path;
            }
            return candidates.Last();
        }

        private string ResolveSfxFile(string sfxName)
        {
            string sfxFolder = Path.Combine(_assetsBase, "sfx");
            string normalized = sfxName.ToLower().Trim().Replace(" ", "_").Replace("-", "_");

            string directPath = Path.Combine(sfxFolder, $"{normalized}.mp3");
            if (File.Exists(directPath)) return directPath;

            if (normalized.Contains("whoosh"))
            {
                string w = Path.Combine(sfxFolder, "whoosh.mp3");
                return File.Exists(w) ? w : Path.Combine(sfxFolder, "camera_shutter.mp3");
            }
            if (normalized.Contains("whistle"))
            {
                string wh = Path.Combine(sfxFolder, "whistle.mp3");
                return File.Exists(wh) ? wh : Path.Combine(sfxFolder, "ding.mp3");
            }
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

        private string ResolveAmbienceFile(string ambName)
        {
            string ambFolder = Path.Combine(_assetsBase, "ambience");
            string sfxFolder = Path.Combine(_assetsBase, "sfx");
            string normalized = ambName.ToLower().Trim().Replace(" ", "_").Replace("-", "_");

            string[] candidates = new[]
            {
                Path.Combine(ambFolder, $"{normalized}.mp3"),
                Path.Combine(ambFolder, $"{normalized}.wav"),
                Path.Combine(sfxFolder, $"{normalized}.mp3"),
                Path.Combine(sfxFolder, $"ambience_{normalized}.mp3"),
                Path.Combine(ambFolder, "stadium_murmur.mp3"),
                Path.Combine(ambFolder, "room_tone.mp3")
            };

            foreach (var path in candidates)
            {
                if (File.Exists(path)) return path;
            }
            return candidates[0];
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

        private async Task BuildCompositeAmbienceTrackAsync(List<AmbienceCue> ambCues, double totalDuration, string outputAmbWav, CancellationToken ct)
        {
            string durStr = totalDuration.ToString("F2", CultureInfo.InvariantCulture);
            string? firstValid = ambCues.FirstOrDefault(c => File.Exists(c.FilePath))?.FilePath;

            if (firstValid != null && File.Exists(firstValid))
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "ffmpeg",
                    Arguments = $"-y -stream_loop -1 -i \"{firstValid}\" -t {durStr} -af \"afade=t=in:st=0:d=0.5,afade=t=out:st={Math.Max(0, totalDuration - 0.5).ToString("F2", CultureInfo.InvariantCulture)}:d=0.5,volume=0.22\" -c:a pcm_s16le -ar 24000 -ac 1 \"{outputAmbWav}\"",
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    RedirectStandardError = true
                };
                using var p = Process.Start(psi)!;
                await p.WaitForExitAsync(ct);
            }
            else
            {
                var psi = new ProcessStartInfo
                {
                    FileName = "ffmpeg",
                    Arguments = $"-y -f lavfi -i \"anoisesrc=d={durStr}:c=pink:r=24000:a=0.0007\" -af \"lowpass=f=1100,highpass=f=80,volume=0.25\" -c:a pcm_s16le -ar 24000 -ac 1 \"{outputAmbWav}\"",
                    CreateNoWindow = true,
                    UseShellExecute = false,
                    RedirectStandardError = true
                };
                using var p = Process.Start(psi)!;
                await p.WaitForExitAsync(ct);
            }
        }

        private async Task ApplyBroadcastMasteringMixAsync(string speechWav, string bgmTrackWav, string ambTrackWav, List<SfxCue> sfxCues, string outputWav, string jobId, CancellationToken ct)
        {
            var sb = new StringBuilder();
            var filterSb = new StringBuilder();

            sb.Append($"-y -i \"{speechWav}\" -i \"{bgmTrackWav}\" -i \"{ambTrackWav}\" ");
            int inputIndex = 3;

            var sfxInputs = new List<(int Idx, double Time)>();
            foreach (var cue in sfxCues)
            {
                if (File.Exists(cue.FilePath))
                {
                    sb.Append($"-i \"{cue.FilePath}\" ");
                    sfxInputs.Add((inputIndex++, cue.Time));
                }
            }

            filterSb.Append("[0:a]highpass=f=75,equalizer=f=190:width_type=q:width=1.1:gain=2.6,equalizer=f=420:width_type=q:width=1.0:gain=-1.2,equalizer=f=3400:width_type=q:width=1.2:gain=2.2,equalizer=f=11000:width_type=q:width=0.8:gain=1.5,aecho=0.96:0.82:18|28:0.08|0.05[speechPolished];");
            filterSb.Append("[1:a]volume=0.25[bgmNorm];");
            filterSb.Append("[bgmNorm][speechPolished]sidechaincompress=threshold=0.05:ratio=8:attack=22:release=720[duckedBgm];");
            filterSb.Append("[2:a]volume=0.20[ambBed];");

            var mixInputs = new List<string> { "[speechPolished]", "[duckedBgm]", "[ambBed]" };

            for (int i = 0; i < sfxInputs.Count; i++)
            {
                var item = sfxInputs[i];
                long delayMs = (long)(item.Time * 1000);
                filterSb.Append($"[{item.Idx}:a]aresample=24000,aformat=channel_layouts=mono,adelay=delays={delayMs}:all=1,volume=0.52[sfx{i}];");
                mixInputs.Add($"[sfx{i}]");
            }

            string combined = string.Join("", mixInputs);
            filterSb.Append($"{combined}amix=inputs={mixInputs.Count}:duration=first:dropout_transition=2[mixedRaw];");
            filterSb.Append("[mixedRaw]loudnorm=I=-14:TP=-1.0:LRA=9[masterAudio]");

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

        private async Task EnsureWarmDaemonActiveAsync(CancellationToken ct)
        {
            await _daemonLock.WaitAsync(ct);
            try
            {
                bool isHealthy = false;
                try
                {
                    using var cts = new CancellationTokenSource(800);
                    var resp = await _httpClient.GetAsync($"http://127.0.0.1:{DaemonPort}/health", cts.Token);
                    if (resp.IsSuccessStatusCode) isHealthy = true;
                }
                catch { }

                if (isHealthy) return;

                if (_daemonProcess != null && !_daemonProcess.HasExited)
                {
                    try { _daemonProcess.Kill(true); } catch { }
                }

                var psi = new ProcessStartInfo
                {
                    FileName = "node",
                    Arguments = $"render_avatar.js --daemon {DaemonPort}",
                    WorkingDirectory = PathHelper.AvatarRendererBase,
                    CreateNoWindow = true,
                    UseShellExecute = false
                };

                _daemonProcess = Process.Start(psi);

                for (int i = 0; i < 20; i++)
                {
                    await Task.Delay(500, ct);
                    try
                    {
                        using var cts = new CancellationTokenSource(800);
                        var resp = await _httpClient.GetAsync($"http://127.0.0.1:{DaemonPort}/health", cts.Token);
                        if (resp.IsSuccessStatusCode) return;
                    }
                    catch { }
                }
            }
            finally
            {
                _daemonLock.Release();
            }
        }

        private async Task RenderAvatarAsync(string jobId, string sessionDir, string timelinePath, string phonemesPath, string audioPath, string outputPath, string avatar, CancellationToken ct)
        {
            try
            {
                await EnsureWarmDaemonActiveAsync(ct);

                var payload = new
                {
                    sessionDir,
                    timelinePath,
                    phonemesPath,
                    audioPath,
                    outputPath,
                    avatar
                };

                var content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
                using var req = new HttpRequestMessage(HttpMethod.Post, $"http://127.0.0.1:{DaemonPort}/render") { Content = content };
                using var response = await _httpClient.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);

                if (response.IsSuccessStatusCode)
                {
                    using var stream = await response.Content.ReadAsStreamAsync(ct);
                    using var reader = new StreamReader(stream);
                    while (!ct.IsCancellationRequested)
                    {
                        var line = await reader.ReadLineAsync(ct);
                        if (line == null) break;
                        if (string.IsNullOrEmpty(line)) continue;

                        if (line.StartsWith("PROGRESS:"))
                        {
                            var parts = line.Split(':');
                            if (parts.Length == 3 && int.TryParse(parts[1], out int cur) && int.TryParse(parts[2], out int total))
                            {
                                int stepPct = (int)((cur * 100.0) / total);
                                int overallPct = 70 + (int)((cur * 30.0) / total);
                                _progress.Report(jobId, 4, stepPct, overallPct, $"[Three.js] Rendered frame {cur}/{total} ({stepPct}%)");
                            }
                        }
                    }

                    if (File.Exists(outputPath)) return;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"[Warm Daemon Warning] Fallback to standard CLI render process: {ex.Message}");
            }

            var directPsi = new ProcessStartInfo
            {
                FileName = "node",
                Arguments = $"render_avatar.js \"{sessionDir}\" \"{timelinePath}\" \"{phonemesPath}\" \"{audioPath}\" \"{outputPath}\" \"{avatar}\"",
                WorkingDirectory = PathHelper.AvatarRendererBase,
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };

            using var p = Process.Start(directPsi) ?? throw new InvalidOperationException("Failed to invoke avatar renderer.");
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