using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using PodcastEngine.Api.Common;
using PodcastEngine.Api.Services;

namespace PodcastEngine.Api.Controllers
{
    [ApiController]
    [Route("api/[controller]")]
    public class VideoController : ControllerBase
    {
        private readonly PodcastPipelineService _pipeline;
        private readonly JobProgressService _progress;
        private static readonly ConcurrentDictionary<string, CancellationTokenSource> _jobTokens = new();

        public VideoController(PodcastPipelineService pipeline, JobProgressService progress)
        {
            _pipeline = pipeline;
            _progress = progress;
        }

        [HttpPost("start-job")]
        [RequestSizeLimit(100_000_000)]
        public async Task<IActionResult> StartJob()
        {
            string jobId = Guid.NewGuid().ToString("N");
            string script = Request.Form["script"].ToString();
            string avatar = Request.Form.ContainsKey("avatar") ? Request.Form["avatar"].ToString() : "shubo";

            if (string.IsNullOrWhiteSpace(script))
            {
                return BadRequest(new { message = "Script cannot be empty." });
            }

            string sessionDir = Path.Combine(PathHelper.StorageBase, jobId);
            Directory.CreateDirectory(sessionDir);
            string overlaysDir = Path.Combine(sessionDir, "overlays");
            Directory.CreateDirectory(overlaysDir);

            foreach (var file in Request.Form.Files)
            {
                if (file.Length > 0)
                {
                    var namesToSave = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                    if (!string.IsNullOrWhiteSpace(file.FileName)) namesToSave.Add(file.FileName);
                    if (!string.IsNullOrWhiteSpace(file.Name) && file.Name != "files" && file.Name != "overlays") namesToSave.Add(file.Name);

                    foreach (var rawName in namesToSave)
                    {
                        string targetName = Path.GetFileName(rawName).Trim().Replace("\"", "").Replace("'", "");
                        if (!string.IsNullOrEmpty(targetName) && targetName != "files" && targetName != "overlays" && targetName != "script" && targetName != "avatar")
                        {
                            var overlaySavePath = Path.Combine(overlaysDir, targetName);
                            using (var stream = new FileStream(overlaySavePath, FileMode.Create))
                            {
                                await file.CopyToAsync(stream);
                            }
                            var rootSavePath = Path.Combine(sessionDir, targetName);
                            System.IO.File.Copy(overlaySavePath, rootSavePath, true);
                        }
                    }
                }
            }

            var cts = new CancellationTokenSource();
            _jobTokens[jobId] = cts;
            var ct = cts.Token;

            _ = Task.Run(async () =>
            {
                try
                {
                    await _pipeline.ExecutePipelineAsync(jobId, script, sessionDir, avatar, ct);
                }
                catch (OperationCanceledException)
                {
                    _progress.Report(jobId, 0, 0, 0, "Job canceled by user.", "canceled");
                }
                catch (Exception ex)
                {
                    _progress.Report(jobId, 0, 0, 0, $"Fatal execution error: {ex.Message}", "failed");
                }
                finally
                {
                    if (_jobTokens.TryRemove(jobId, out var removedCts))
                    {
                        removedCts.Dispose();
                    }
                }
            });

            return Ok(new { jobId });
        }

        [HttpGet("stream/{jobId}")]
        public async Task Stream(string jobId)
        {
            Response.Headers.Append("Content-Type", "text/event-stream");
            Response.Headers.Append("Cache-Control", "no-cache");
            Response.Headers.Append("Connection", "keep-alive");

            var subscription = _progress.Subscribe(jobId);
            try
            {
                while (await subscription.Reader.WaitToReadAsync(HttpContext.RequestAborted))
                {
                    while (subscription.Reader.TryRead(out var progressEvent))
                    {
                        string json = System.Text.Json.JsonSerializer.Serialize(progressEvent);
                        await Response.WriteAsync($"data: {json}\n\n");
                        await Response.Body.FlushAsync();

                        if (progressEvent.status == "completed" || progressEvent.status == "failed" || progressEvent.status == "canceled")
                        {
                            return;
                        }
                    }
                }
            }
            finally
            {
                _progress.Unsubscribe(jobId, subscription);
            }
        }

        [HttpPost("cancel/{jobId}")]
        public IActionResult Cancel(string jobId)
        {
            if (_jobTokens.TryGetValue(jobId, out var cts))
            {
                cts.Cancel();
            }
            return Ok(new { message = "Cancellation signaled." });
        }

        [HttpGet("download/{jobId}")]
        public IActionResult Download(string jobId)
        {
            string videoPath = Path.Combine(PathHelper.StorageBase, jobId, "podcast.mp4");
            if (!System.IO.File.Exists(videoPath))
            {
                return NotFound(new { message = "Rendered video file not found." });
            }
            return PhysicalFile(videoPath, "video/mp4", "podcast.mp4");
        }
    }
}