using System;
using System.Collections.Concurrent;
using System.Threading.Channels;

namespace PodcastEngine.Api.Services
{
    public class JobProgressEvent
    {
        public string jobId { get; set; } = string.Empty;
        public int step { get; set; }
        public int stepProgress { get; set; }
        public int overallProgress { get; set; }
        public string message { get; set; } = string.Empty;
        public string status { get; set; } = "in_progress";
        public string? error { get; set; }
        public string? downloadUrl { get; set; }
    }

    public class JobProgressSubscription
    {
        public Guid Id { get; } = Guid.NewGuid();
        public Channel<JobProgressEvent> Channel { get; }
        public ChannelReader<JobProgressEvent> Reader => Channel.Reader;

        public JobProgressSubscription()
        {
            Channel = System.Threading.Channels.Channel.CreateUnbounded<JobProgressEvent>(new UnboundedChannelOptions
            {
                SingleWriter = false,
                SingleReader = true
            });
        }
    }

    public class JobProgressService
    {
        private readonly ConcurrentDictionary<string, ConcurrentDictionary<Guid, JobProgressSubscription>> _subscribers = new();

        public void Report(string jobId, int step, int stepProgress, int overallProgress, string message, string status = "in_progress")
        {
            var evt = new JobProgressEvent
            {
                jobId = jobId,
                step = step,
                stepProgress = stepProgress,
                overallProgress = overallProgress,
                message = message,
                status = status
            };

            if (_subscribers.TryGetValue(jobId, out var jobSubs))
            {
                foreach (var sub in jobSubs.Values)
                {
                    sub.Channel.Writer.TryWrite(evt);
                }
            }
        }

        public JobProgressSubscription Subscribe(string jobId)
        {
            var sub = new JobProgressSubscription();
            var jobSubs = _subscribers.GetOrAdd(jobId, _ => new ConcurrentDictionary<Guid, JobProgressSubscription>());
            jobSubs[sub.Id] = sub;
            return sub;
        }

        public void Unsubscribe(string jobId, JobProgressSubscription sub)
        {
            if (sub != null && _subscribers.TryGetValue(jobId, out var jobSubs))
            {
                if (jobSubs.TryRemove(sub.Id, out var removedSub))
                {
                    removedSub.Channel.Writer.TryComplete();
                }
                if (jobSubs.IsEmpty)
                {
                    _subscribers.TryRemove(jobId, out _);
                }
            }
        }
    }
}