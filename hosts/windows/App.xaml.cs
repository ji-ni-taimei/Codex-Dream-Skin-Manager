using System;
using System.IO;
using System.Windows;

namespace DreamSkin.SharedHost
{
    public partial class App : Application
    {
        private SingleInstance instance;
        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);
            try
            {
                var root = AppDomain.CurrentDomain.BaseDirectory;
                string link = null;
                if (e.Args.Length == 1) link = e.Args[0];
                else if ((e.Args.Length == 2 || e.Args.Length == 3) && e.Args[0] == "--application-root" && Path.IsPathRooted(e.Args[1])) {
                    root = Path.GetFullPath(e.Args[1]);
                    if (e.Args.Length == 3) link = e.Args[2];
                } else if (e.Args.Length != 0) throw new InvalidOperationException("Invalid manager startup arguments.");
                if (link != null) NativeDesktop.CommunityLink(link);
                instance = new SingleInstance();
                if (!instance.IsOwner) { instance.Forward(link); Shutdown(); return; }
                var window = new ManagerWindow(root); MainWindow = window;
                if (link != null) window.Desktop.Navigate("import", "none", NativeDesktop.CommunityLink(link));
                instance.Listen(value => Dispatcher.InvokeAsync(() => {
                    try { if (value == "activate") window.Desktop.Navigate("console"); else window.Desktop.Navigate("import", "none", NativeDesktop.CommunityLink(value)); } catch { }
                }));
                MainWindow.Show();
            }
            catch { MessageBox.Show("无法打开共享管理器，请检查本地资源目录。", "Dream Skin"); Shutdown(1); }
        }
        protected override void OnExit(ExitEventArgs e) { instance?.Dispose(); base.OnExit(e); }
    }
}
