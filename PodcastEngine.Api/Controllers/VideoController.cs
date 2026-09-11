using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using PodcastEngine.Api.Common;
using PodcastEngine.Api.Services;

namespace PodcastEngine.Api.Controllers
{
    [ApiController]
    [Route("api/video")]
    public class VideoController : ControllerBase
    {
        private readonly PodcastPipelineService _pipeline;
        private readonly JobProgressService _progress;
        private static readonly JsonSerializerOptions JsonOptions = new()
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        };

        public VideoController(PodcastPipelineService pipeline, JobProgressService progress)
        {
            _pipeline = pipeline;
            _progress = progress;
        }

        [HttpPost("start")]
        [HttpPost("start-job")]
        [RequestSizeLimit(100_000_000)]
        public async Task<IActionResult> Start([FromForm] string script, [FromForm] IFormFileCollection? files, [FromForm] string? avatar)
        {
            try
            {
                string jobId = Guid.NewGuid().ToString("N")[..8];
                string sessionDir = Path.Combine(PathHelper.StorageBase, jobId);
                string overlaysDir = Path.Combine(sessionDir, "overlays");
                Directory.CreateDirectory(sessionDir);
                Directory.CreateDirectory(overlaysDir);

                string chosenAvatar = string.IsNullOrWhiteSpace(avatar) ? "mina" : avatar.Trim().ToLower();

                // Extract all [Show: "filename"] directive target names
                var showMatches = Regex.Matches(script ?? "", @"\[Show:\s*[""']?([^""'\]\s]+)[""']?", RegexOptions.IgnoreCase);
                var targetNames = showMatches.Select(m => Path.GetFileName(m.Groups[1].Value.Trim('\"', '\'', ' ')))
                                             .Where(s => !string.IsNullOrEmpty(s))
                                             .Distinct(StringComparer.OrdinalIgnoreCase)
                                             .ToList();

                var incomingFiles = (files != null && files.Count > 0) ? files : Request.Form.Files;

                if (incomingFiles != null && incomingFiles.Count > 0)
                {
                    int idx = 0;
                    foreach (var file in incomingFiles)
                    {
                        if (file.Length == 0) continue;

                        string originalName = Path.GetFileName(file.FileName.Trim('\"', '\'', ' '));
                        if (string.IsNullOrEmpty(originalName)) originalName = $"overlay_{idx}.png";

                        // 1. Save directly into session root storage (Storage/<jobId>/)
                        string rootPath = Path.Combine(sessionDir, originalName);
                        using (var fs = new FileStream(rootPath, FileMode.Create, FileAccess.Write))
                        {
                            await file.CopyToAsync(fs);
                        }

                        // 2. Mirror into overlays/ folder
                        string overlayPath = Path.Combine(overlaysDir, originalName);
                        if (!string.Equals(Path.GetFullPath(rootPath), Path.GetFullPath(overlayPath), StringComparison.OrdinalIgnoreCase))
                        {
                            System.IO.File.Copy(rootPath, overlayPath, true);
                        }

                        // 3. Map to corresponding [Show: "..."] directive name
                        if (targetNames.Count > 0)
                        {
                            string targetName = idx < targetNames.Count ? targetNames[idx] : targetNames[0];
                            string targetRoot = Path.Combine(sessionDir, targetName);
                            string targetOverlay = Path.Combine(overlaysDir, targetName);

                            if (!string.Equals(Path.GetFullPath(rootPath), Path.GetFullPath(targetRoot), StringComparison.OrdinalIgnoreCase))
                                System.IO.File.Copy(rootPath, targetRoot, true);

                            if (!string.Equals(Path.GetFullPath(rootPath), Path.GetFullPath(targetOverlay), StringComparison.OrdinalIgnoreCase))
                                System.IO.File.Copy(rootPath, targetOverlay, true);
                        }

                        idx++;
                    }
                }

                var jobToken = _progress.CreateJobToken(jobId);

                _ = Task.Run(async () =>
                {
                    try
                    {
                        await _pipeline.ExecutePipelineAsync(jobId, script ?? "", sessionDir, chosenAvatar, jobToken);
                    }
                    catch (OperationCanceledException)
                    {
                        _progress.Report(jobId, 4, 0, 100, "Render Halted: Job canceled by user.", "failed");
                    }
                    catch (Exception ex)
                    {
                        _progress.Report(jobId, 4, 0, 100, $"Fatal Error: {ex.Message}", "failed");
                    }
                }, CancellationToken.None);

                return Ok(new { jobId });
            }
            catch (Exception ex)
            {
                return StatusCode(500, new { error = ex.Message });
            }
        }

        [HttpGet("stream/{jobId}")]
        public async Task Stream(string jobId, CancellationToken ct)
        {
            Response.Headers.Append("Content-Type", "text/event-stream");
            Response.Headers.Append("Cache-Control", "no-cache");
            Response.Headers.Append("Connection", "keep-alive");

            var reader = _progress.GetReader(jobId);

            try
            {
                while (await reader.WaitToReadAsync(ct))
                {
                    while (reader.TryRead(out var ev))
                    {
                        string json = JsonSerializer.Serialize(ev, JsonOptions);
                        await Response.WriteAsync($"data: {json}\n\n", ct);
                        await Response.Body.FlushAsync(ct);
                    }
                }
            }
            catch (OperationCanceledException) { }
        }

        [HttpPost("cancel/{jobId}")]
        public IActionResult Cancel(string jobId)
        {
            _progress.CancelJob(jobId);
            return Ok(new { status = "canceled" });
        }

        [HttpGet("download/{jobId}")]
        public IActionResult Download(string jobId)
        {
            string mp4 = Path.Combine(PathHelper.StorageBase, jobId, "podcast.mp4");
            if (!System.IO.File.Exists(mp4)) return NotFound("Rendered video not found.");
            return PhysicalFile(mp4, "video/mp4", enableRangeProcessing: true);
        }
    }
}
