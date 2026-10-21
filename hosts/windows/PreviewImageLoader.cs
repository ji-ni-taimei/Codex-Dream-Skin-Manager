using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace DreamSkin.SharedHost
{
    internal static class PreviewImageLoader
    {
        private static readonly SemaphoreSlim PreviewDecoders = new SemaphoreSlim(20);
        private static readonly Dictionary<string, Task<byte[]>> Pending = new Dictionary<string, Task<byte[]>>();
        private static readonly object CacheWrites = new object();
        private const int MaximumCachedBytes = 8 * 1024 * 1024;
        private static readonly string CacheDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CodexDreamSkin", "preview-cache-v1");

        public static async Task<byte[]> LoadPngAsync(string path, int maximumWidth, string digest,
            Func<string, int, Task<BitmapSource>> decodeVideo)
        {
            var cacheName = digest + "-" + maximumWidth + ".png";
            Task<byte[]> pending;
            lock (Pending)
            {
                if (!Pending.TryGetValue(cacheName, out pending))
                {
                    // Coalesce identical content even when multiple themes refer to it.
                    pending = Task.Run(() => LoadPngCoreAsync(path, maximumWidth, digest, cacheName, decodeVideo));
                    Pending.Add(cacheName, pending);
                }
            }
            try { return await pending; }
            finally
            {
                lock (Pending)
                    if (Pending.TryGetValue(cacheName, out var current) && current == pending) Pending.Remove(cacheName);
            }
        }

        private static async Task<byte[]> LoadPngCoreAsync(string path, int maximumWidth, string digest, string cacheName,
            Func<string, int, Task<BitmapSource>> decodeVideo)
        {
            // Hashing and cache reads stay off the UI thread. Hits bypass the decoder queue.
            using (var handle = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                if (handle.Length < 1 || handle.Length > 128L * 1024 * 1024) return null;
                using (var hash = SHA256.Create())
                    if (BitConverter.ToString(hash.ComputeHash(handle)).Replace("-", "").ToLowerInvariant() != digest) return null;
                var cached = ReadCached(cacheName, maximumWidth);
                if (cached != null) return cached;
                await PreviewDecoders.WaitAsync();
                try
                {
                    // Content hash + render size survives random session filenames and app restarts.
                    var image = await LoadAsync(path, maximumWidth, decodeVideo);
                    if (image == null) return null;
                    var encoder = new PngBitmapEncoder(); encoder.Frames.Add(BitmapFrame.Create(image));
                    using (var output = new MemoryStream())
                    {
                        encoder.Save(output);
                        var bytes = output.ToArray();
                        if (bytes.Length <= MaximumCachedBytes) WriteCached(cacheName, bytes);
                        return bytes;
                    }
                }
                finally { PreviewDecoders.Release(); }
            }
        }

        private static byte[] ReadCached(string name, int maximumWidth)
        {
            try
            {
                var file = Path.Combine(CacheDirectory, name);
                SafeFiles.Check(file, CacheDirectory);
                if (new FileInfo(file).Length > MaximumCachedBytes) return null;
                var bytes = File.ReadAllBytes(file);
                using (var stream = new MemoryStream(bytes))
                {
                    var decoder = new PngBitmapDecoder(stream, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
                    var frame = decoder.Frames[0];
                    if (frame.PixelWidth < 1 || frame.PixelHeight < 1 || frame.PixelWidth > maximumWidth || frame.PixelHeight > maximumWidth) return null;
                    // Complete decoding here, so damaged cache entries fall back to the original.
                    var pixels = new byte[frame.PixelWidth * frame.PixelHeight * 4];
                    new FormatConvertedBitmap(frame, PixelFormats.Bgra32, null, 0).CopyPixels(pixels, frame.PixelWidth * 4, 0);
                }
                return bytes;
            }
            catch { return null; }
        }

        private static void WriteCached(string name, byte[] bytes)
        {
            lock (CacheWrites)
            {
                string temporary = null;
                try
                {
                    Directory.CreateDirectory(CacheDirectory); SafeFiles.CheckDirectory(CacheDirectory);
                    // Bound this disposable cache to 128 MiB and 256 images. Never touch theme files.
                    var files = new DirectoryInfo(CacheDirectory).GetFiles("*.png").OrderBy(file => file.LastWriteTimeUtc).ToList();
                    long total = files.Sum(file => file.Length);
                    while (files.Count > 0 && (files.Count >= 256 || total + bytes.Length > 128L * 1024 * 1024))
                    {
                        var oldest = files[0]; SafeFiles.Check(oldest.FullName, CacheDirectory);
                        total -= oldest.Length; oldest.Delete(); files.RemoveAt(0);
                    }
                    var destination = Path.Combine(CacheDirectory, name);
                    if (File.Exists(destination)) { SafeFiles.Check(destination, CacheDirectory); File.Delete(destination); }
                    temporary = Path.Combine(CacheDirectory, Guid.NewGuid().ToString("N") + ".tmp");
                    using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) output.Write(bytes, 0, bytes.Length);
                    File.Move(temporary, destination);
                }
                catch { /* Cache failures must not prevent displaying the newly decoded preview. */ }
                finally { if (temporary != null) { try { File.Delete(temporary); } catch { } } }
            }
        }

        private static async Task<BitmapSource> LoadAsync(string path, int maximumWidth, Func<string, int, Task<BitmapSource>> decodeVideo)
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path) || maximumWidth < 1) return null;
            string fullPath = Path.GetFullPath(path);
            if (string.Equals(Path.GetExtension(fullPath), ".mp4", StringComparison.OrdinalIgnoreCase))
            {
                var thumbnail = LoadShellThumbnail(fullPath, maximumWidth);
                if (thumbnail != null) return thumbnail;
                if (decodeVideo != null)
                {
                    try { thumbnail = await decodeVideo(fullPath, maximumWidth); }
                    catch (Exception error) { ReportFailure("webview-decode", error); }
                    if (thumbnail != null) return thumbnail;
                }
                // Optional final fallback for profiles unsupported by the installed WebView2 runtime.
                return await LoadVideoFrameAsync(fullPath, maximumWidth);
            }

            using (var input = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                var decoder = BitmapDecoder.Create(input, BitmapCreateOptions.DelayCreation, BitmapCacheOption.None);
                var frame = decoder.Frames[0];
                var bitmap = new BitmapImage();
                bitmap.BeginInit(); bitmap.CacheOption = BitmapCacheOption.OnLoad;
                if (frame.PixelWidth >= frame.PixelHeight) bitmap.DecodePixelWidth = maximumWidth;
                else bitmap.DecodePixelHeight = maximumWidth;
                // WIC reads lazily: querying frame dimensions can move the stream.
                // Rewind after those reads so BitmapImage sees the format header.
                input.Position = 0;
                bitmap.StreamSource = input;
                bitmap.EndInit(); bitmap.Freeze();
                return bitmap;
            }
        }

        private static async Task<BitmapSource> LoadVideoFrameAsync(string path, int maximumWidth)
        {
            using (var process = new Process())
            {
                process.StartInfo = new ProcessStartInfo {
                    FileName = "ffmpeg.exe", UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    Arguments = "-hide_banner -loglevel quiet -nostdin -threads 2 -i \"" + path +
                        "\" -map 0:v:0 -frames:v 1 -an -sn -dn -vf \"scale=" + maximumWidth + ":" + maximumWidth +
                        ":force_original_aspect_ratio=decrease\" -threads 2 -pix_fmt rgb24 -c:v png -f image2pipe pipe:1"
                };
                try
                {
                    if (!process.Start()) return null;
                    var read = ReadFrameAsync(process.StandardOutput.BaseStream);
                    if (await Task.WhenAny(read, Task.Delay(10000)) != read)
                    {
                        process.Kill();
                        try { await read; } catch { }
                        return null;
                    }
                    var bytes = await read;
                    if (!process.WaitForExit(1000) || process.ExitCode != 0 || bytes.Length == 0) return null;
                    using (var stream = new MemoryStream(bytes))
                    {
                        var bitmap = new BitmapImage();
                        bitmap.BeginInit();
                        bitmap.CacheOption = BitmapCacheOption.OnLoad;
                        bitmap.StreamSource = stream;
                        bitmap.EndInit();
                        bitmap.Freeze();
                        return bitmap;
                    }
                }
                catch (Exception error) { ReportFailure("ffmpeg-decode", error); return null; }
                finally
                {
                    try { if (!process.HasExited) process.Kill(); } catch { }
                }
            }
        }

        private static async Task<byte[]> ReadFrameAsync(Stream stream)
        {
            using (var output = new MemoryStream())
            {
                var buffer = new byte[8192];
                int count;
                while ((count = await stream.ReadAsync(buffer, 0, buffer.Length)) > 0)
                {
                    if (output.Length + count > 8 * 1024 * 1024) throw new IOException("Video preview exceeds its size limit.");
                    output.Write(buffer, 0, count);
                }
                return output.ToArray();
            }
        }

        private static BitmapSource LoadShellThumbnail(string path, int maximumWidth)
        {
            IShellItemImageFactory factory = null;
            IntPtr bitmapHandle = IntPtr.Zero;
            try
            {
                Guid interfaceId = typeof(IShellItemImageFactory).GUID;
                int result = SHCreateItemFromParsingName(path, IntPtr.Zero, ref interfaceId, out factory);
                if (result < 0 || factory == null) { ReportFailure("shell-create", Marshal.GetExceptionForHR(result) ?? new IOException()); return null; }
                result = factory.GetImage(new NativeSize(maximumWidth, maximumWidth),
                    ShellImageFlags.ResizeToFit | ShellImageFlags.ThumbnailOnly,
                    out bitmapHandle);
                if (result < 0 || bitmapHandle == IntPtr.Zero) { ReportFailure("shell-thumbnail", Marshal.GetExceptionForHR(result) ?? new IOException()); return null; }
                BitmapSource thumbnail = Imaging.CreateBitmapSourceFromHBitmap(bitmapHandle, IntPtr.Zero,
                    Int32Rect.Empty, BitmapSizeOptions.FromEmptyOptions());
                thumbnail.Freeze();
                return thumbnail;
            }
            catch (Exception error) { ReportFailure("shell-thumbnail", error); return null; }
            finally
            {
                if (bitmapHandle != IntPtr.Zero) DeleteObject(bitmapHandle);
                if (factory != null && Marshal.IsComObject(factory)) Marshal.FinalReleaseComObject(factory);
            }
        }

        internal static void ReportFailure(string stage, Exception error)
        {
            lock (CacheWrites)
            {
                try
                {
                    Directory.CreateDirectory(CacheDirectory); SafeFiles.CheckDirectory(CacheDirectory);
                    var file = Path.Combine(CacheDirectory, "preview-errors.log");
                    if (File.Exists(file)) { SafeFiles.Check(file, CacheDirectory); if (new FileInfo(file).Length > 64 * 1024) File.WriteAllText(file, ""); }
                    // Avoid logging user paths or video bytes. Keep the native failure code for diagnosis.
                    File.AppendAllText(file, DateTime.UtcNow.ToString("o") + " " + stage + " " + error.GetType().Name + " 0x" + error.HResult.ToString("X8") + Environment.NewLine);
                }
                catch { }
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct NativeSize
        {
            public int Width;
            public int Height;

            public NativeSize(int width, int height)
            {
                Width = width;
                Height = height;
            }
        }

        [Flags]
        private enum ShellImageFlags
        {
            ResizeToFit = 0,
            ThumbnailOnly = 8
        }

        [ComImport]
        [Guid("BCC18B79-BA16-442F-80C4-8A59C30C463B")]
        [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IShellItemImageFactory
        {
            [PreserveSig]
            int GetImage(NativeSize size, ShellImageFlags flags, out IntPtr bitmapHandle);
        }

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
        private static extern int SHCreateItemFromParsingName(string path, IntPtr bindingContext,
            ref Guid interfaceId, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory factory);

        [DllImport("gdi32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DeleteObject(IntPtr value);
    }
}
