using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media.Imaging;

namespace DreamSkin.SharedHost
{
    internal static class PreviewImageLoader
    {
        private static readonly SemaphoreSlim VideoDecoders = new SemaphoreSlim(2);

        public static async Task<BitmapSource> LoadAsync(string path, int maximumWidth)
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path) || maximumWidth < 1) return null;
            string fullPath = Path.GetFullPath(path);
            if (string.Equals(Path.GetExtension(fullPath), ".mp4", StringComparison.OrdinalIgnoreCase))
            {
                var thumbnail = LoadShellThumbnail(fullPath, maximumWidth);
                if (thumbnail != null) return thumbnail;
                // Windows thumbnail handlers cannot decode some supported MP4 profiles,
                // including H.264 High 10. Use an installed FFmpeg without changing the source.
                await VideoDecoders.WaitAsync();
                try { return await Task.Run(() => LoadVideoFrameAsync(fullPath, maximumWidth)); }
                finally { VideoDecoders.Release(); }
            }

            BitmapImage bitmap = new BitmapImage();
            bitmap.BeginInit();
            bitmap.CacheOption = BitmapCacheOption.OnLoad;
            bitmap.DecodePixelWidth = maximumWidth;
            bitmap.UriSource = new Uri(fullPath, UriKind.Absolute);
            bitmap.EndInit();
            bitmap.Freeze();
            return bitmap;
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
                catch { return null; } // FFmpeg is optional; native thumbnails remain the default.
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
                if (result < 0 || factory == null) return null;
                result = factory.GetImage(new NativeSize(maximumWidth, maximumWidth),
                    ShellImageFlags.ResizeToFit | ShellImageFlags.ThumbnailOnly,
                    out bitmapHandle);
                if (result < 0 || bitmapHandle == IntPtr.Zero) return null;
                BitmapSource thumbnail = Imaging.CreateBitmapSourceFromHBitmap(bitmapHandle, IntPtr.Zero,
                    Int32Rect.Empty, BitmapSizeOptions.FromEmptyOptions());
                thumbnail.Freeze();
                return thumbnail;
            }
            catch { return null; }
            finally
            {
                if (bitmapHandle != IntPtr.Zero) DeleteObject(bitmapHandle);
                if (factory != null && Marshal.IsComObject(factory)) Marshal.FinalReleaseComObject(factory);
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
