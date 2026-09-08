using System;
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

namespace PodcastEngine.Api.Services
{
    public class TimelineEvent
    {
        public double Time { get; set; }
        public string Type { get; set; } = string.Empty;
        public string Value { get; set; } = string.Empty;
        public string Extra { get; set; } = string.Empty;
    }

    public class ScriptSegment
    {
        public bool IsPause { get; set; }
        public double PauseDuration { get; set; }
        public string Text { get; set; } = string.Empty;
        public List<TimelineEvent> Directives { get; set; } = new();
    }

    public class PodcastPipelineService
    {
        private readonly string _storageBase;
        private readonly string _assetsBase;

        public PodcastPipelineService()
        {
            _storageBase = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Storage");
            _assetsBase = ResolveDirectory("assets");
            Directory.CreateDirectory(_storageBase);
        }

        public async Task<string> ProcessPodcastJobAsync(string jobId, string rawScript, CancellationToken ct)
        {
            string sessionDir = Path.Combine(_storageBase, jobId);
            Directory.CreateDirectory(sessionDir);

            string voiceWav = Path.Combine(sessionDir, "voice_master.wav");
            string phonemesJson = Path.Combine(sessionDir, "phonemes.json");
            string timelineJson = Path.Combine(sessionDir, "timeline.json");
            string masterAudioWav = Path.Combine(sessionDir, "master_mix.wav");
            string finalMp4 = Path.Combine(sessionDir, "podcast.mp4");

            var (segments, timelineEvents, sfxEvents, bgmEvents) = ParseScriptAndDirectives(rawScript);

            await SynthesizeSpeechMasterAsync(segments, voiceWav, sessionDir, ct);
            await RunRhubarbPhoneticsAsync(voiceWav, phonemesJson, ct);
            await MasterAudioAsync(voiceWav, masterAudioWav, sfxEvents, bgmEvents, sessionDir, ct);

            await File.WriteAllTextAsync(timelineJson, JsonSerializer.Serialize(timelineEvents, new JsonSerializerOptions { WriteIndented = true }), ct);
            await RenderAvatarToVideoAsync(sessionDir, timelineJson, phonemesJson, masterAudioWav, finalMp4, ct);

            return finalMp4;
        }

        private (List<ScriptSegment>, List<TimelineEvent>, List<TimelineEvent>, List<TimelineEvent>) ParseScriptAndDirectives(string script)
        {
            var segments = new List<ScriptSegment>();
            var allTimeline = new List<TimelineEvent>();
            var sfxEvents = new List<TimelineEvent>();
            var bgmEvents = new List<TimelineEvent>();

            var tagPattern = new Regex(@"\[(Emotion|Cam|Gesture|Pause|BGM|DefBGM|SFX|Show|Hide|LowerThird)(?::\s*([^\]]+))?\]", RegexOptions.Compiled);
            var lines = script.Split(new[] { "\r\n", "\r", "\n" }, StringSplitOptions.RemoveEmptyEntries);

            var pendingDirectives = new List<TimelineEvent>();

            foreach (var rawLine in lines)
            {
                string line = rawLine.Trim();
                if (string.IsNullOrEmpty(line)) continue;

                var matches = tagPattern.Matches(line);
                string cleanText = tagPattern.Replace(line, "").Trim();

                foreach (Match m in matches)
                {
                    string tagType = m.Groups[1].Value;
                    string tagVal = m.Groups[2].Success ? m.Groups[2].Value.Trim('"', ' ') : "";

                    if (tagType == "Pause")
                    {
                        double duration = 1.0;
                        var durMatch = Regex.Match(tagVal, @"([0-9.]+)");
                        if (durMatch.Success) double.TryParse(durMatch.Groups[1].Value, NumberStyles.Any, CultureInfo.InvariantCulture, out duration);

                        segments.Add(new ScriptSegment { IsPause = true, PauseDuration = duration, Directives = new List<TimelineEvent>(pendingDirectives) });
                        pendingDirectives.Clear();
                    }
                    else if (tagType == "DefBGM" || tagType == "BGM")
                    {
                        var evt = new TimelineEvent { Type = "bgm", Value = tagType == "DefBGM" ? "lofi" : tagVal.ToLower() };
                        bgmEvents.Add(evt);
                        pendingDirectives.Add(evt);
                    }
                    else if (tagType == "SFX")
                    {
                        var evt = new TimelineEvent { Type = "sfx", Value = tagVal };
                        sfxEvents.Add(evt);
                        pendingDirectives.Add(evt);
                    }
                    else
                    {
                        pendingDirectives.Add(new TimelineEvent { Type = tagType.ToLower(), Value = tagVal });
                    }
                }

                if (!string.IsNullOrEmpty(cleanText))
                {
                    segments.Add(new ScriptSegment { IsPause = false, Text = cleanText, Directives = new List<TimelineEvent>(pendingDirectives) });
                    pendingDirectives.Clear();
                }
            }

            return (segments, allTimeline, sfxEvents, bgmEvents);
        }

        private async Task SynthesizeSpeechMasterAsync(List<ScriptSegment> segments, string voiceWav, string sessionDir, CancellationToken ct)
        {
            string concatList = Path.Combine(sessionDir, "voice_concat.txt");
            var fileList = new StringBuilder();

            int chunkIdx = 0;
            foreach (var seg in segments)
            {
                string chunkPath = Path.Combine(sessionDir, $"chunk_{chunkIdx:D4}.wav");
                if (seg.IsPause)
                {
                    var startInfo = new ProcessStartInfo
                    {
                        FileName = "ffmpeg",
                        Arguments = $"-y -f lavfi -i anullsrc=r=24000:cl=mono -t {seg.PauseDuration.ToString("0.00", CultureInfo.InvariantCulture)} -c:a pcm_s16le \"{chunkPath}\"",
                        CreateNoWindow = true,
                        UseShellExecute = false
                    };
                    using var proc = Process.Start(startInfo);
                    await proc!.WaitForExitAsync(ct);
                }
                else
                {
                    await GenerateTtsAudioAsync(seg.Text, chunkPath, ct);
                }

                fileList.AppendLine($"file '{chunkPath.Replace("\\", "/")}'");
                chunkIdx++;
            }

            await File.WriteAllTextAsync(concatList, fileList.ToString(), ct);

            var concatProc = Process.Start(new ProcessStartInfo
            {
                FileName = "ffmpeg",
                Arguments = $"-y -f concat -safe 0 -i \"{concatList}\" -c:a pcm_s16le \"{voiceWav}\"",
                CreateNoWindow = true,
                UseShellExecute = false
            });
            await concatProc!.WaitForExitAsync(ct);
        }

        private async Task MasterAudioAsync(string voiceWav, string masterAudioWav, List<TimelineEvent> sfxEvents, List<TimelineEvent> bgmEvents, string sessionDir, CancellationToken ct)
        {
            string lofiPath = Path.Combine(_assetsBase, "music", "lofi.mp3");
            string sfxFolder = Path.Combine(_assetsBase, "sfx");

            var filter = new StringBuilder();
            filter.Append("[1:a]volume=0.35[bgm_pre];");
            filter.Append("[bgm_pre][0:a]sidechaincompress=threshold=0.18:ratio=4:attack=30:release=400[ducked_bgm];");
            filter.Append("[0:a][ducked_bgm]amix=inputs=2:normalize=0[mixed_bed]");

            var args = new StringBuilder();
            args.Append($"-y -i \"{voiceWav}\" -stream_loop -1 -i \"{lofiPath}\" ");

            int sfxInputIdx = 2;
            var sfxLabels = new List<string>();

            foreach (var sfx in sfxEvents)
            {
                string sfxFile = Path.Combine(sfxFolder, sfx.Value.ToLower().Replace(" ", "_") + ".mp3");
                if (File.Exists(sfxFile))
                {
                    args.Append($"-i \"{sfxFile}\" ");
                    int delayMs = (int)(sfx.Time * 1000);
                    string label = $"sfx_{sfxInputIdx}";
                    filter.Append($";[{sfxInputIdx}:a]atrim=0:3,afade=t=out:st=2.5:d=0.5,adelay={delayMs}|{delayMs}[{label}]");
                    sfxLabels.Add($"[{label}]");
                    sfxInputIdx++;
                }
            }

            if (sfxLabels.Any())
            {
                filter.Append($";[mixed_bed]{string.Join("", sfxLabels)}amix=inputs={1 + sfxLabels.Count}:normalize=0[final_master]");
                args.Append($"-filter_complex \"{filter}\" -map \"[final_master]\" ");
            }
            else
            {
                args.Append($"-filter_complex \"{filter}\" -map \"[mixed_bed]\" ");
            }

            args.Append($"-c:a pcm_s16le -threads 0 \"{masterAudioWav}\"");

            var mixProc = Process.Start(new ProcessStartInfo
            {
                FileName = "ffmpeg",
                Arguments = args.ToString(),
                CreateNoWindow = true,
                UseShellExecute = false
            });
            await mixProc!.WaitForExitAsync(ct);
        }

        private async Task GenerateTtsAudioAsync(string text, string outputPath, CancellationToken ct)
        {
            string txtPath = Path.ChangeExtension(outputPath, ".txt");
            await File.WriteAllTextAsync(txtPath, text, new UTF8Encoding(false), ct);

            var psi = new ProcessStartInfo
            {
                FileName = "node",
                Arguments = $"synthesize_speech.js \"{txtPath}\" \"{outputPath}\"",
                WorkingDirectory = ResolveDirectory("avatar-renderer"),
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardError = true,
                RedirectStandardOutput = true
            };

            using var p = Process.Start(psi);
            if (p == null) throw new InvalidOperationException("Failed to start TTS process.");

            string stderr = await p.StandardError.ReadToEndAsync(ct);
            string stdout = await p.StandardOutput.ReadToEndAsync(ct);
            await p.WaitForExitAsync(ct);

            if (File.Exists(txtPath)) File.Delete(txtPath);

            if (p.ExitCode != 0 || !File.Exists(outputPath))
            {
                throw new InvalidOperationException($"TTS synthesis failed.\nStderr: {stderr}\nStdout: {stdout}");
            }
        }

        private async Task RunRhubarbPhoneticsAsync(string voiceWav, string phonemesJson, CancellationToken ct)
        {
            var p = Process.Start(new ProcessStartInfo
            {
                FileName = "rhubarb",
                Arguments = $"-f json -r phonetic -o \"{phonemesJson}\" \"{voiceWav}\"",
                CreateNoWindow = true,
                UseShellExecute = false
            });
            await p!.WaitForExitAsync(ct);
        }

        private async Task RenderAvatarToVideoAsync(string sessionDir, string timelineJson, string phonemesJson, string masterAudioWav, string finalMp4, CancellationToken ct)
        {
            var psi = new ProcessStartInfo
            {
                FileName = "node",
                Arguments = $"render_avatar.js \"{sessionDir}\" \"{timelineJson}\" \"{phonemesJson}\" \"{masterAudioWav}\" \"{finalMp4}\"",
                WorkingDirectory = ResolveDirectory("avatar-renderer"),
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };

            using var p = Process.Start(psi);
            if (p == null) throw new InvalidOperationException("Failed to start Node rendering process.");

            string stdout = await p.StandardOutput.ReadToEndAsync(ct);
            string stderr = await p.StandardError.ReadToEndAsync(ct);
            await p.WaitForExitAsync(ct);

            if (p.ExitCode != 0 || !File.Exists(finalMp4))
            {
                throw new InvalidOperationException($"Node rendering process exited with code {p.ExitCode}.\nError: {stderr}\nOutput: {stdout}");
            }
        }

        private static string ResolveDirectory(string folderName)
        {
            var dir = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
            while (dir != null)
            {
                string target = Path.Combine(dir.FullName, folderName);
                if (Directory.Exists(target)) return target;
                dir = dir.Parent;
            }
            return Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "..", "..", "..", folderName));
        }
    }
}


