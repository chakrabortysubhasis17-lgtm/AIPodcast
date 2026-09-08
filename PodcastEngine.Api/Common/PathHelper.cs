using System;
using System.IO;

namespace PodcastEngine.Api.Common
{
    public static class PathHelper
    {
        public static string? TryResolveDirectory(string targetDirName)
        {
            var dir = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
            while (dir != null)
            {
                string candidate = Path.Combine(dir.FullName, targetDirName);
                if (Directory.Exists(candidate)) return candidate;
                dir = dir.Parent;
            }
            return null;
        }

        public static string ResolveDirectory(string targetDirName)
        {
            return TryResolveDirectory(targetDirName) 
                ?? throw new DirectoryNotFoundException($"Could not locate ancestor containing '{targetDirName}'.");
        }

        public static string ApiBase => ResolveDirectory("PodcastEngine.Api");
        public static string StorageBase => Path.Combine(ApiBase, "Storage");
        public static string AssetsBase => Path.Combine(ApiBase, "assets");
        public static string AvatarRendererBase => ResolveDirectory("avatar-renderer");
    }
}
