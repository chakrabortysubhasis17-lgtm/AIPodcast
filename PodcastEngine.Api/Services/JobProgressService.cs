using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;

namespace PodcastEngine.Api.Services
{
    public class JobStatusUpdate
    {
        public int? Stage { get; set; }
        public int? Percent { get; set; }
        public string? StageMessage { get; set; }
        public string? Log { get; set; }
        public string? DownloadUrl { get; set; }
        public string? Error { get; set; }
    }

    public class JobSession
    {
        public string JobId { get; set; } = string.Empty;
        public CancellationTokenSource Cts { get; set; } = new();
        public Channel<string> StreamChannel { get; set; } = Channel.CreateUnbounded<string>();
        public List<string> History { get; set; } = new();
    }

    public class JobProgressService
    {
        private readonly ConcurrentDictionary<string, JobSession> _jobs = new();

        public JobSession CreateJob(string jobId)
        {
            var session = new JobSession { JobId = jobId };
            _jobs[jobId] = session;
            return session;
        }

        public JobSession? GetJob(string jobId)
        {
            _jobs.TryGetValue(jobId, out var session);
            return session;
        }

        public void Publish(string jobId, JobStatusUpdate update)
        {
            if (_jobs.TryGetValue(jobId, out var session))
            {
                string json = JsonSerializer.Serialize(update, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
                session.History.Add(json);
                session.StreamChannel.Writer.TryWrite(json);
            }
        }

        public void Cancel(string jobId)
        {
            if (_jobs.TryGetValue(jobId, out var session))
            {
                session.Cts.Cancel();
                Publish(jobId, new JobStatusUpdate { Error = "Render canceled by user." });
            }
        }
    }
}
