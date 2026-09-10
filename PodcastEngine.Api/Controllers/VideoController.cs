using System;
using System.IO;
using System.Text.Json;
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
            string jobId = Guid.NewGuid().ToString("N")[..8];
            string sessionDir = Path.Combine(PathHelper.StorageBase, jobId);
            string overlaysDir = Path.Combine(sessionDir, "overlays");
            Directory.CreateDirectory(overlaysDir);

            string chosenAvatar = string.IsNullOrWhiteSpace(avatar) ? "mina" : avatar.Trim().ToLower();

            if (files != null)
            {
                foreach (var file in files)
                {
                    if (file.Length > 0)
                    {
                        string savePath = Path.Combine(overlaysDir, file.FileName);
                        using var fs = new FileStream(savePath, FileMode.Create);
                        await file.CopyToAsync(fs);
                    }
                }
            }

            var jobToken = _progress.CreateJobToken(jobId);

            _ = Task.Run(async () =>
            {
                try
                {
                    await _pipeline.ExecutePipelineAsync(jobId, script, sessionDir, chosenAvatar, jobToken);
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
