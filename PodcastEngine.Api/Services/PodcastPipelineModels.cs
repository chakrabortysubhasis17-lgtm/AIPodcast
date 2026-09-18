using System.Collections.Generic;

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

    public class AmbienceCue
    {
        public double Time { get; set; }
        public string FilePath { get; set; } = string.Empty;
    }

    public class MouthCueItem
    {
        public double start { get; set; }
        public double end { get; set; }
        public string value { get; set; } = string.Empty;
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
        public List<string> HideTargets { get; set; } = new();
        public string Bg { get; set; } = string.Empty;
        public string Icon { get; set; } = string.Empty;
        public List<string> SfxList { get; set; } = new();
        public string Bgm { get; set; } = string.Empty;
        public string Ambience { get; set; } = string.Empty;
        public string Tone { get; set; } = "neutral";
        public string Stinger { get; set; } = string.Empty;
        public string SpeechText { get; set; } = string.Empty;
        public string WavPath { get; set; } = string.Empty;
        public double Duration { get; set; }
        public List<MouthCueItem> MouthCues { get; set; } = new();
    }
}