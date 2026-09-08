using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using PodcastEngine.Api.Services;

namespace PodcastEngine.Api.Controllers
{
    public class StartJobRequest
    {
        public string Script { get; set; } = string.Empty;
        public List<IFormFile>? Overlays { get; set; }
    }

    [ApiController]
    [Route("api/[controller]")]
    public class VideoController : ControllerBase
    {
        private readonly PodcastPipelineService _pipelineService;
        private readonly JobProgressService _progressService;

        public VideoController(PodcastPipelineService pipelineService, JobProgressService progressService)
        {
            _pipelineService = pipelineService;
            _progressService = progressService;
        }

        [HttpPost("start-job")]
        [Consumes("multipart/form-data")]
        public async Task<IActionResult> StartJob([FromForm] StartJobRequest request)
        {
            if (string.IsNullOrWhiteSpace(request.Script))
            {
                return BadRequest(new { message = "Script cannot be empty." });
            }

            string jobId = Guid.NewGuid().ToString("N");
            var session = _progressService.CreateJob(jobId);

            string storageBase = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Storage", jobId);
            string overlaysDir = Path.Combine(storageBase, "overlays");
            Directory.CreateDirectory(overlaysDir);

            if (request.Overlays != null && request.Overlays.Count > 0)
            {
                foreach (var file in request.Overlays)
                {
                    if (file.Length > 0)
                    {
                        string safeFileName = Path.GetFileName(file.FileName);
                        string destPath = Path.Combine(overlaysDir, safeFileName);
                        using var stream = new FileStream(destPath, FileMode.Create);
                        await file.CopyToAsync(stream);
                    }
                }
            }

            _ = Task.Run(async () =>
            {
                try
                {
                    _progressService.Publish(jobId, new JobStatusUpdate { Stage = 1, Percent = 10, StageMessage = "Synthesizing voice chunks...", Log = "[TTS] Generating speech masters." });
                    await Task.Delay(1000, session.Cts.Token);

                    _progressService.Publish(jobId, new JobStatusUpdate { Stage = 2, Percent = 35, StageMessage = "Running Rhubarb phonetic lip-sync...", Log = "[Rhubarb] Generating phonemes.json" });
                    await Task.Delay(1000, session.Cts.Token);

                    _progressService.Publish(jobId, new JobStatusUpdate { Stage = 3, Percent = 60, StageMessage = "Mastering audio & ducking...", Log = "[FFmpeg] Sidechain compression applied." });
                    await Task.Delay(1000, session.Cts.Token);

                    _progressService.Publish(jobId, new JobStatusUpdate { Stage = 4, Percent = 85, StageMessage = "Rendering Three.js WebGL canvas...", Log = "[Three.js] Pipe to libx264 ultrafast." });

                    string finalPath = await _pipelineService.ProcessPodcastJobAsync(jobId, request.Script, session.Cts.Token);

                    _progressService.Publish(jobId, new JobStatusUpdate
                    {
                        Stage = 4,
                        Percent = 100,
                        StageMessage = "Render Complete!",
                        DownloadUrl = $"/api/video/download/{jobId}",
                        Log = "Job completed successfully."
                    });
                }
                catch (OperationCanceledException)
                {
                    _progressService.Publish(jobId, new JobStatusUpdate { Error = "Job canceled." });
                }
                catch (Exception ex)
                {
                    _progressService.Publish(jobId, new JobStatusUpdate { Error = ex.Message, Log = $"[FATAL] {ex.Message}" });
                }
            });

            return Ok(new { jobId });
        }

        [HttpGet("stream/{jobId}")]
        public async Task Stream(string jobId, CancellationToken ct)
        {
            Response.Headers.Append("Content-Type", "text/event-stream");
            Response.Headers.Append("Cache-Control", "no-cache");
            Response.Headers.Append("Connection", "keep-alive");

            var session = _progressService.GetJob(jobId);
            if (session == null)
            {
                byte[] notFoundBytes = Encoding.UTF8.GetBytes("data: {\"error\":\"Job not found\"}\n\n");
                await Response.Body.WriteAsync(notFoundBytes, ct);
                return;
            }

            try
            {
                // Flush historical buffered updates first
                foreach (var pastEvent in session.History)
                {
                    byte[] bytes = Encoding.UTF8.GetBytes($"data: {pastEvent}\n\n");
                    await Response.Body.WriteAsync(bytes, ct);
                }
                await Response.Body.FlushAsync(ct);

                // Stream live updates safely
                var reader = session.StreamChannel.Reader;
                while (!ct.IsCancellationRequested && await reader.WaitToReadAsync(ct))
                {
                    while (reader.TryRead(out var msg))
                    {
                        byte[] bytes = Encoding.UTF8.GetBytes($"data: {msg}\n\n");
                        await Response.Body.WriteAsync(bytes, ct);
                        await Response.Body.FlushAsync(ct);
                    }
                }
            }
            catch (OperationCanceledException)
            {
                // Client closed browser or EventSource disconnected cleanly
            }
        }

        [HttpPost("cancel/{jobId}")]
        public IActionResult CancelJob(string jobId)
        {
            _progressService.Cancel(jobId);
            return Ok(new { status = "Canceled" });
        }

        [HttpGet("download/{jobId}")]
        public IActionResult DownloadVideo(string jobId)
        {
            string filePath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Storage", jobId, "podcast.mp4");
            if (!System.IO.File.Exists(filePath)) return NotFound();
            return PhysicalFile(filePath, "video/mp4", enableRangeProcessing: true);
        }
    }
}

