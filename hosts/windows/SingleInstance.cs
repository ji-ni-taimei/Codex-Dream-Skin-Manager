using System;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace DreamSkin.SharedHost
{
    internal sealed class SingleInstance : IDisposable
    {
        private readonly Mutex mutex;
        private readonly string name;
        private NamedPipeServerStream server;
        private volatile bool closed;
        internal bool IsOwner { get; }
        internal SingleInstance()
        {
            name = "DreamSkin.Manager." + WindowsIdentity.GetCurrent().User.Value;
            bool created; mutex = new Mutex(true, "Local\\" + name, out created); IsOwner = created;
        }
        internal void Forward(string link)
        {
            using (var pipe = new NamedPipeClientStream(".", name, PipeDirection.Out)) {
                pipe.Connect(2500); var bytes = Encoding.UTF8.GetBytes((link ?? "activate") + "\n"); pipe.Write(bytes, 0, bytes.Length); pipe.Flush();
            }
        }
        internal void Listen(Action<string> receive)
        {
            _ = Task.Run(async () => {
                while (!closed) {
                    try {
                        var security = new PipeSecurity(); security.SetAccessRuleProtection(true, false);
                        security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
                        using (var pipe = new NamedPipeServerStream(name, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous, 1024, 1024, security)) {
                            server = pipe; await pipe.WaitForConnectionAsync();
                            var buffer = new byte[1]; var line = new StringBuilder();
                            var deadline = DateTime.UtcNow.AddSeconds(3);
                            while (line.Length <= 256) {
                                var remaining = deadline - DateTime.UtcNow;
                                if (remaining <= TimeSpan.Zero) break;
                                var read = pipe.ReadAsync(buffer, 0, 1);
                                if (await Task.WhenAny(read, Task.Delay(remaining)) != read) break;
                                if (await read != 1) break;
                                if (buffer[0] == 10) { receive(line.ToString()); break; }
                                if (buffer[0] < 32 || buffer[0] > 126) break;
                                line.Append((char)buffer[0]);
                            }
                        }
                    } catch { if (closed) return; }
                }
            });
        }
        public void Dispose() { closed = true; server?.Dispose(); if (IsOwner) { try { mutex.ReleaseMutex(); } catch { } } mutex.Dispose(); }
    }
}
