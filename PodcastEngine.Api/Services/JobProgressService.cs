using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;

namespace PodcastEngine.Api.Services
{
    public class JobProgressEvent
    {
        public int Step { get; set; } = 1;
        public int StepProgress { get; set; } = 0;
        public int OverallProgress { get; set; } = 0;
        public string Message { get; set; } = string.Empty;
        public string Timestamp { get; set; } = DateTime.Now.ToString("HH:mm:ss");
        public string Status { get; set; } = "running"; // running, completed, failed
    }

    public class JobProgressService
    {
        private readonly ConcurrentDictionary<string, Channel<JobProgressEvent>> _channels = new();
        private readonly ConcurrentDictionary<string, List<JobProgressEvent>> _history = new();
        private readonly ConcurrentDictionary<string, CancellationTokenSource> _cancellationTokens = new();

        public CancellationToken CreateJobToken(string jobId)
        {
            var cts = new CancellationTokenSource();
            _cancellationTokens[jobId] = cts;
            return cts.Token;
        }

        public void CancelJob(string jobId)
        {
            if (_cancellationTokens.TryGetValue(jobId, out var cts))
            {
                cts.Cancel();
            }
        }

        public ChannelReader<JobProgressEvent> GetReader(string jobId)
        {
            var channel = _channels.GetOrAdd(jobId, _ => Channel.CreateUnbounded<JobProgressEvent>(new UnboundedChannelOptions
            {
                SingleWriter = false,
                SingleReader = false
            }));
            return channel.Reader;
        }

        public List<JobProgressEvent> GetHistory(string jobId)
        {
            return _history.TryGetValue(jobId, out var list) ? list : new List<JobProgressEvent>();
        }

        public void Report(string jobId, int step, int stepProgress, int overallProgress, string message, string status = "running")
        {
            var ev = new JobProgressEvent
            {
                Step = step,
                StepProgress = Math.Clamp(stepProgress, 0, 100),
                OverallProgress = Math.Clamp(overallProgress, 0, 100),
                Message = message,
                Status = status
            };

            var list = _history.GetOrAdd(jobId, _ => new List<JobProgressEvent>());
            lock (list) list.Add(ev);

            var channel = _channels.GetOrAdd(jobId, _ => Channel.CreateUnbounded<JobProgressEvent>());
            channel.Writer.TryWrite(ev);

            if (status == "completed" || status == "failed")
            {
                channel.Writer.TryComplete();
            }
        }
    }
}
