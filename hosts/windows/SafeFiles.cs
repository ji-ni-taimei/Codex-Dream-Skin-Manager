using System;
using System.IO;

namespace DreamSkin.SharedHost
{
    internal static class SafeFiles
    {
        internal static void CheckDirectory(string directory)
        {
            var current = Path.GetFullPath(directory);
            if (!Directory.Exists(current)) throw new IOException();
            while (!string.IsNullOrEmpty(current)) {
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new IOException();
                current = Path.GetDirectoryName(current);
            }
        }
        internal static void Check(string file, string root)
        {
            var absolute = Path.GetFullPath(file); var basis = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            if (!absolute.StartsWith(basis, StringComparison.OrdinalIgnoreCase)) throw new IOException();
            var current = absolute;
            while (!string.IsNullOrEmpty(current))
            {
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new IOException();
                current = Path.GetDirectoryName(current);
            }
        }
    }
}
