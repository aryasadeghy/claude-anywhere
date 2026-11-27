// The Windows half of lib/screen.mjs: one long-lived PowerShell process that compiled this with
// Add-Type and talks line-delimited JSON over stdin/stdout - a request with an id in, an answer
// with the same id out, and the banner's Stop as an event of its own.
//
// C# 5 on purpose: Windows PowerShell 5.1's Add-Type compiles with the .NET Framework's own
// compiler, which knows nothing newer (no $"...", no ?., no => members). It is on every Windows,
// so this needs no install and no npm dependency.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace CaScreen
{
    public static class Helper
    {
        [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
        [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
        [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public int mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
        [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
        [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
        [StructLayout(LayoutKind.Sequential)] struct CURSORINFO { public int cbSize; public int flags; public IntPtr hCursor; public POINT pt; }
        [StructLayout(LayoutKind.Sequential)] struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct MONITORINFOEX { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }

        delegate bool EnumProc(IntPtr h, IntPtr l);
        delegate bool MonitorProc(IntPtr m, IntPtr hdc, ref RECT r, IntPtr data);
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
        [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
        [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
        [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc f, IntPtr l);
        [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorProc f, IntPtr data);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFOEX mi);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
        [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
        [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
        [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
        [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);
        [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO ci);
        [DllImport("user32.dll")] static extern bool GetIconInfo(IntPtr h, out ICONINFO ii);
        [DllImport("user32.dll")] static extern bool DrawIcon(IntPtr hdc, int x, int y, IntPtr icon);
        [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint type);
        [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr h);
        [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
        [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr h);
        [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
        [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
        [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int flags, StringBuilder s, ref int size);

        static StreamWriter Out;
        static readonly object OutLock = new object();
        static JavaScriptSerializer Json;
        static string Confine;

        public static void Run(string confine)
        {
            // Physical pixels everywhere, or a 150% display reports two thirds of itself and every
            // click lands short. Per-monitor v2 where Windows has it, the old switch where not.
            bool aware = false;
            try { aware = SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { }
            if (!aware) { try { SetProcessDPIAware(); } catch (Exception) { } }
            Confine = string.IsNullOrEmpty(confine) ? null : confine;
            Json = new JavaScriptSerializer();
            Json.MaxJsonLength = int.MaxValue;
            Out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            Out.AutoFlush = true;
            var inp = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            Send(Obj("ev", "ready", "pid", Process.GetCurrentProcess().Id, "confine", Confine));
            string line;
            // The server holds the other end of stdin: when it goes - even killed outright, with no
            // chance to say so - the read ends, and so does this process and its banner.
            while ((line = inp.ReadLine()) != null)
            {
                object id = null;
                try
                {
                    var m = Json.DeserializeObject(line) as Dictionary<string, object>;
                    if (m == null) continue;
                    if (m.ContainsKey("id")) id = m["id"];
                    var r = Handle(m);
                    r["id"] = id;
                    Send(r);
                }
                catch (Exception e) { Send(Obj("id", id, "error", e.Message)); }
            }
            Environment.Exit(0);
        }

        internal static void Send(Dictionary<string, object> o)
        {
            string s = Json.Serialize(o);
            lock (OutLock) { Out.WriteLine(s); }
        }

        static Dictionary<string, object> Obj(params object[] kv)
        {
            var d = new Dictionary<string, object>();
            for (int i = 0; i + 1 < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
            return d;
        }
        static string Str(Dictionary<string, object> m, string k) { object v; return m.TryGetValue(k, out v) && v != null ? Convert.ToString(v) : null; }
        static int Int(Dictionary<string, object> m, string k, int def = 0) { object v; return m.TryGetValue(k, out v) && v != null ? (int)Math.Round(Convert.ToDouble(v)) : def; }
        static bool Bool(Dictionary<string, object> m, string k) { object v; return m.TryGetValue(k, out v) && v is bool && (bool)v; }

        static Dictionary<string, object> Handle(Dictionary<string, object> m)
        {
            string cmd = Str(m, "cmd");
            switch (cmd)
            {
                case "ping": return Obj("ok", true);
                case "displays": return Obj("displays", Displays());
                case "windows": return Obj("windows", WindowList(Bool(m, "all")));
                case "at": return Obj("window", WindowAt(Int(m, "x"), Int(m, "y")));
                case "foreground": { var h = GetForegroundWindow(); return Obj("window", h == IntPtr.Zero ? null : Describe(Info(h))); }
                case "cursor": { POINT p; GetCursorPos(out p); return Obj("x", p.X, "y", p.Y); }
                case "grab": return Grab(m);
                case "mouse": Mouse(m); return Obj("ok", true);
                case "drag": Drag(m); return Obj("ok", true);
                case "scroll": Scroll(m); return Obj("ok", true);
                case "keys": Keys(m); return Obj("ok", true);
                case "text": TypeText(Str(m, "text") ?? ""); return Obj("ok", true);
                case "focus": return Obj("ok", Focus(new IntPtr(Convert.ToInt64(m["hwnd"]))));
                case "open": return Open(Str(m, "name") ?? "");
                case "banner": BannerSet(Bool(m, "on"), Str(m, "text"), Str(m, "button")); return Obj("ok", true);
                default: throw new Exception("Unknown command " + cmd);
            }
        }

        // ---------- displays ----------
        static List<object> Displays()
        {
            var list = new List<object>();
            EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr mon, IntPtr hdc, ref RECT r, IntPtr data)
            {
                var mi = new MONITORINFOEX();
                mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
                GetMonitorInfo(mon, ref mi);
                list.Add(Obj("name", mi.szDevice, "primary", (mi.dwFlags & 1) != 0, "x", mi.rcMonitor.Left, "y", mi.rcMonitor.Top, "w", mi.rcMonitor.Right - mi.rcMonitor.Left, "h", mi.rcMonitor.Bottom - mi.rcMonitor.Top));
                return true;
            }, IntPtr.Zero);
            return list;
        }

        // ---------- windows ----------
        class Win { public IntPtr H; public string Title; public string Cls; public uint Pid; public RECT R; public bool Min; public int Ex; }
        static readonly string[] ShellClasses = new string[] { "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd" };
        static bool IsShell(string cls) { return Array.IndexOf(ShellClasses, cls) >= 0; }

        static string TitleOf(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }
        static string ClassOf(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, sb.Capacity); return sb.ToString(); }
        static RECT BoundsOf(IntPtr h)
        {
            // The frame as drawn: GetWindowRect counts the invisible resize border around it too.
            RECT r;
            if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) == 0 && r.Right > r.Left) return r;
            GetWindowRect(h, out r);
            return r;
        }
        static Win Info(IntPtr h)
        {
            var w = new Win();
            w.H = h; w.Title = TitleOf(h); w.Cls = ClassOf(h);
            GetWindowThreadProcessId(h, out w.Pid);
            w.Min = IsIconic(h); w.Ex = GetWindowLong(h, -20); w.R = BoundsOf(h);
            return w;
        }
        // Top to bottom, as Windows stacks them; what is on another virtual desktop (cloaked) is not on screen.
        static List<Win> TopWindows()
        {
            var list = new List<Win>();
            EnumWindows(delegate (IntPtr h, IntPtr l)
            {
                if (!IsWindowVisible(h)) return true;
                int cloaked;
                if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
                list.Add(Info(h));
                return true;
            }, IntPtr.Zero);
            return list;
        }

        static Dictionary<uint, string[]> procCache = new Dictionary<uint, string[]>();
        static string[] ProcOf(uint pid)
        {
            string[] r;
            if (procCache.TryGetValue(pid, out r)) return r;
            string path = null;
            var hp = OpenProcess(0x1000, false, pid);
            if (hp != IntPtr.Zero)
            {
                var sb = new StringBuilder(1024); int n = sb.Capacity;
                if (QueryFullProcessImageName(hp, 0, sb, ref n)) path = sb.ToString();
                CloseHandle(hp);
            }
            string exe = path != null ? Path.GetFileNameWithoutExtension(path) : "process " + pid;
            string name = exe;
            if (path != null)
            {
                try { var d = FileVersionInfo.GetVersionInfo(path).FileDescription; if (!string.IsNullOrEmpty(d) && d.Trim().Length > 0) name = d.Trim(); } catch (Exception) { }
            }
            r = new string[] { name, exe, path ?? "" };
            procCache[pid] = r;
            return r;
        }
        // A Store app's window belongs to ApplicationFrameHost; the app itself owns a child of it.
        static uint AppPid(Win w)
        {
            if (!string.Equals(ProcOf(w.Pid)[1], "ApplicationFrameHost", StringComparison.OrdinalIgnoreCase)) return w.Pid;
            uint found = 0;
            EnumChildWindows(w.H, delegate (IntPtr c, IntPtr l) { uint p; GetWindowThreadProcessId(c, out p); if (p != w.Pid) { found = p; return false; } return true; }, IntPtr.Zero);
            return found != 0 ? found : w.Pid;
        }
        // A click-through overlay (a game bar, a GPU driver's, a screen recorder's frame) covers
        // the screen and shows next to nothing; painted over, it would hide everything under it.
        // NVIDIA's says so only by being layered, unfocusable and off the taskbar at once.
        static bool IsOverlay(Win w) { return (w.Ex & 0x80000) != 0 && ((w.Ex & 0x20) != 0 || ((w.Ex & 0x08000000) != 0 && (w.Ex & 0x80) != 0)); }
        internal const string ShellApp = "Desktop and taskbar";
        static string AppName(Win w) { return IsShell(w.Cls) ? ShellApp : ProcOf(AppPid(w))[0]; }

        static Dictionary<string, object> Describe(Win w)
        {
            var p = ProcOf(AppPid(w));
            return Obj("hwnd", w.H.ToInt64(), "title", w.Title, "app", AppName(w), "exe", p[1], "pid", (long)AppPid(w),
                "x", w.R.Left, "y", w.R.Top, "w", w.R.Right - w.R.Left, "h", w.R.Bottom - w.R.Top,
                "minimized", w.Min, "shell", IsShell(w.Cls), "banner", w.H == BannerHandle && w.H != IntPtr.Zero);
        }
        static List<object> WindowList(bool all)
        {
            procCache.Clear();
            var fg = GetForegroundWindow();
            var list = new List<object>();
            foreach (var w in TopWindows())
            {
                // What a person would call a window: titled, not a tool palette, not the shell or ours.
                if (!all && (w.Title.Length == 0 || IsShell(w.Cls) || w.H == BannerHandle)) continue;
                if (!all && (w.Ex & 0x80) != 0 && (w.Ex & 0x40000) == 0) continue;
                if (!all && (w.R.Right - w.R.Left <= 1 || w.R.Bottom - w.R.Top <= 1)) continue;
                var d = Describe(w);
                d["foreground"] = w.H == fg;
                if (all) { d["cls"] = w.Cls; d["ex"] = w.Ex; d["overlay"] = IsOverlay(w); }
                list.Add(d);
            }
            return list;
        }
        static IntPtr RootAt(int x, int y)
        {
            var p = new POINT(); p.X = x; p.Y = y;
            var h = WindowFromPoint(p);
            return h == IntPtr.Zero ? IntPtr.Zero : GetAncestor(h, 2);
        }
        static Dictionary<string, object> WindowAt(int x, int y)
        {
            procCache.Clear();
            var h = RootAt(x, y);
            return h == IntPtr.Zero ? null : Describe(Info(h));
        }

        // ---------- what a test may touch ----------
        // CLAUDE_ANYWHERE_SCREEN_CONFINE (tests only): every input must land on a window whose
        // title holds that text - or another window of the same process, its menus and popups -
        // and every picture shows nothing else. A walkthrough drives the real mouse and keyboard;
        // this is what keeps it from ever touching anything but the window it opened.
        static HashSet<uint> ConfinedPids()
        {
            var s = new HashSet<uint>();
            foreach (var w in TopWindows()) if (w.Title.IndexOf(Confine, StringComparison.OrdinalIgnoreCase) >= 0) s.Add(w.Pid);
            return s;
        }
        static void Guard(int x, int y, bool claude)
        {
            if (Confine == null && !claude) return;
            var root = RootAt(x, y);
            if (claude && root != IntPtr.Zero && root == BannerHandle) throw new Exception("That point is claude-anywhere's own banner on the PC; it is there for the person, not for Claude.");
            if (Confine == null) return;
            uint pid; GetWindowThreadProcessId(root, out pid);
            if (root == IntPtr.Zero || !ConfinedPids().Contains(pid)) throw new Exception("Refused: (" + x + ", " + y + ") is outside the window this test opened (" + Confine + ").");
        }
        static void GuardKeys()
        {
            if (Confine == null) return;
            uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid);
            if (!ConfinedPids().Contains(pid)) throw new Exception("Refused: the window in front is not the one this test opened (" + Confine + ").");
        }

        // ---------- pictures ----------
        static Dictionary<string, ulong> lastHash = new Dictionary<string, ulong>();
        static ImageCodecInfo jpegCodec;
        static Dictionary<string, object> Grab(Dictionary<string, object> m)
        {
            int x = Int(m, "x"), y = Int(m, "y"), w = Int(m, "w"), h = Int(m, "h");
            if (w <= 0 || h <= 0) throw new Exception("Nothing to capture.");
            int maxW = Int(m, "maxW", w), maxH = Int(m, "maxH", h), q = Int(m, "quality", 70);
            string key = Str(m, "key");
            object show; m.TryGetValue("show", out show);
            using (var bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb))
            {
                // CAPTUREBLT: without it a layered window (a tooltip, a menu, many modern apps) is
                // missing - and CopyFromScreen refuses the flag, so this is BitBlt by hand.
                using (var g = Graphics.FromImage(bmp))
                {
                    var hdc = g.GetHdc(); var sdc = GetDC(IntPtr.Zero);
                    try { BitBlt(hdc, 0, 0, w, h, sdc, x, y, 0x00CC0020 | 0x40000000); }
                    finally { ReleaseDC(IntPtr.Zero, sdc); g.ReleaseHdc(hdc); }
                }
                List<string> hidden = null;
                if (show is object[] || Confine != null) hidden = Mask(bmp, x, y, show as object[]);
                if (Bool(m, "cursor")) DrawCursor(bmp, x, y);
                // Nothing moved since the last picture of this stream: say so, and spare the JPEG.
                if (key != null)
                {
                    ulong hv = Hash(bmp), prev;
                    if (lastHash.TryGetValue(key, out prev) && prev == hv) return Obj("same", true);
                    lastHash[key] = hv;
                }
                double s = Math.Min(1.0, Math.Min((double)maxW / w, (double)maxH / h));
                int ow = Math.Max(1, (int)Math.Round(w * s)), oh = Math.Max(1, (int)Math.Round(h * s));
                byte[] jpg;
                if (ow == w && oh == h) jpg = Jpeg(bmp, q);
                else
                {
                    using (var small = new Bitmap(ow, oh, PixelFormat.Format24bppRgb))
                    {
                        using (var g = Graphics.FromImage(small))
                        using (var ia = new ImageAttributes())
                        {
                            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
                            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                            ia.SetWrapMode(WrapMode.TileFlipXY); // or the right and bottom edges come out ghosted
                            g.DrawImage(bmp, new Rectangle(0, 0, ow, oh), 0, 0, w, h, GraphicsUnit.Pixel, ia);
                        }
                        jpg = Jpeg(small, q);
                    }
                }
                return Obj("w", ow, "h", oh, "sw", w, "sh", h, "jpeg", Convert.ToBase64String(jpg), "hidden", hidden);
            }
        }
        static byte[] Jpeg(Bitmap b, int q)
        {
            if (jpegCodec == null) foreach (var c in ImageCodecInfo.GetImageEncoders()) if (c.MimeType == "image/jpeg") jpegCodec = c;
            using (var ms = new MemoryStream())
            using (var ep = new EncoderParameters(1))
            {
                ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, (long)Math.Max(10, Math.Min(95, q)));
                b.Save(ms, jpegCodec, ep);
                return ms.ToArray();
            }
        }
        static ulong Hash(Bitmap b)
        {
            var d = b.LockBits(new Rectangle(0, 0, b.Width, b.Height), ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
            try
            {
                int n = Math.Abs(d.Stride) * b.Height;
                var buf = new byte[n];
                Marshal.Copy(d.Scan0, buf, 0, n);
                ulong h = 14695981039346656037UL;
                for (int i = 0; i + 8 <= n; i += 8) { h ^= BitConverter.ToUInt64(buf, i); h *= 1099511628211UL; }
                return h;
            }
            finally { b.UnlockBits(d); }
        }
        static void DrawCursor(Bitmap bmp, int ox, int oy)
        {
            var ci = new CURSORINFO(); ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
            if (!GetCursorInfo(ref ci) || (ci.flags & 1) == 0) return;
            int hx = 0, hy = 0; ICONINFO ii;
            if (GetIconInfo(ci.hCursor, out ii))
            {
                hx = ii.xHotspot; hy = ii.yHotspot;
                if (ii.hbmMask != IntPtr.Zero) DeleteObject(ii.hbmMask);
                if (ii.hbmColor != IntPtr.Zero) DeleteObject(ii.hbmColor);
            }
            using (var g = Graphics.FromImage(bmp))
            {
                var hdc = g.GetHdc();
                try { DrawIcon(hdc, ci.pt.X - ox - hx, ci.pt.Y - oy - hy, ci.hCursor); } finally { g.ReleaseHdc(hdc); }
            }
        }
        // Claude sees only the apps it was given: every other window is painted over, bottom to top
        // as Windows stacks them, so a window it may see that sits under one it may not stays
        // covered where it is covered. The desktop and taskbar stay; they are the way around.
        static List<string> Mask(Bitmap bmp, int ox, int oy, object[] show)
        {
            procCache.Clear();
            var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (show != null) foreach (var o in show) allowed.Add(Convert.ToString(o));
            var hidden = new List<string>();
            var wins = TopWindows();
            wins.Reverse();
            var confined = Confine != null ? ConfinedPids() : null;
            var full = new Rectangle(0, 0, bmp.Width, bmp.Height);
            using (var orig = (Bitmap)bmp.Clone())
            using (var g = Graphics.FromImage(bmp))
            using (var grey = new SolidBrush(Color.FromArgb(58, 58, 58)))
            {
                if (confined != null) g.FillRectangle(grey, full);
                foreach (var w in wins)
                {
                    if (w.Min || IsOverlay(w)) continue;
                    var r = new Rectangle(w.R.Left - ox, w.R.Top - oy, w.R.Right - w.R.Left, w.R.Bottom - w.R.Top);
                    r.Intersect(full);
                    if (r.Width <= 0 || r.Height <= 0) continue;
                    bool ok;
                    if (confined != null) ok = confined.Contains(w.Pid);
                    else if (IsShell(w.Cls) || w.H == BannerHandle) ok = true;
                    else
                    {
                        var app = AppName(w);
                        ok = allowed.Contains(app);
                        if (!ok && !hidden.Contains(app)) hidden.Add(app);
                    }
                    if (ok) g.DrawImage(orig, r, r, GraphicsUnit.Pixel);
                    else g.FillRectangle(grey, r);
                }
            }
            return hidden;
        }

        // ---------- input ----------
        const uint MOVE = 0x1, LDOWN = 0x2, LUP = 0x4, RDOWN = 0x8, RUP = 0x10, MDOWN = 0x20, MUP = 0x40, WHEEL = 0x800, HWHEEL = 0x1000;
        static readonly int InputSize = Marshal.SizeOf(typeof(INPUT));
        static void SendMouse(uint flags, int data)
        {
            var i = new INPUT[1];
            i[0].type = 0; i[0].u.mi.dwFlags = flags; i[0].u.mi.mouseData = data;
            SendInput(1, i, InputSize);
        }
        static void MoveTo(int x, int y)
        {
            SetCursorPos(x, y);
            SendMouse(MOVE, 0); // a move of nothing, so the window under it hears the pointer arrive (hover, drag)
        }
        static void Mouse(Dictionary<string, object> m)
        {
            string a = Str(m, "action") ?? "click";
            int x = Int(m, "x"), y = Int(m, "y");
            bool claude = Bool(m, "claude");
            // A button let go never waits on the guard: refused, it would stay held down.
            if (a != "up") Guard(x, y, claude);
            string b = Str(m, "button") ?? "left";
            uint down = b == "right" ? RDOWN : b == "middle" ? MDOWN : LDOWN, up = b == "right" ? RUP : b == "middle" ? MUP : LUP;
            if (a != "up" || Int(m, "x", int.MinValue) != int.MinValue) MoveTo(x, y);
            if (a == "move") return;
            if (a == "down") { SendMouse(down, 0); return; }
            if (a == "up") { SendMouse(up, 0); return; }
            int n = Math.Max(1, Math.Min(3, Int(m, "count", 1)));
            for (int i = 0; i < n; i++) { SendMouse(down, 0); SendMouse(up, 0); if (i + 1 < n) Thread.Sleep(40); }
        }
        static void Drag(Dictionary<string, object> m)
        {
            var pts = m["path"] as object[];
            if (pts == null || pts.Length < 2) throw new Exception("A drag needs a start and an end.");
            bool claude = Bool(m, "claude");
            var xs = new int[pts.Length]; var ys = new int[pts.Length];
            for (int i = 0; i < pts.Length; i++) { var p = (object[])pts[i]; xs[i] = (int)Math.Round(Convert.ToDouble(p[0])); ys[i] = (int)Math.Round(Convert.ToDouble(p[1])); Guard(xs[i], ys[i], claude); }
            MoveTo(xs[0], ys[0]);
            SendMouse(LDOWN, 0);
            Thread.Sleep(60);
            for (int i = 1; i < pts.Length; i++)
            {
                // In small steps: many apps only start a drag once they see the pointer move with the button down.
                int steps = Math.Max(1, (int)(Math.Sqrt(Math.Pow(xs[i] - xs[i - 1], 2) + Math.Pow(ys[i] - ys[i - 1], 2)) / 12));
                for (int s = 1; s <= steps; s++) { MoveTo(xs[i - 1] + (xs[i] - xs[i - 1]) * s / steps, ys[i - 1] + (ys[i] - ys[i - 1]) * s / steps); Thread.Sleep(8); }
            }
            Thread.Sleep(60);
            SendMouse(LUP, 0);
        }
        static void Scroll(Dictionary<string, object> m)
        {
            int x = Int(m, "x"), y = Int(m, "y");
            Guard(x, y, Bool(m, "claude"));
            MoveTo(x, y);
            int dy = Int(m, "dy"), dx = Int(m, "dx");
            if (dy != 0) SendMouse(WHEEL, dy);
            if (dx != 0) SendMouse(HWHEEL, dx);
        }
        // Keys that live on the extended part of the keyboard; sent without the flag, an arrow
        // arrives as its number-pad twin.
        static readonly HashSet<int> Extended = new HashSet<int> { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2C, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0x6F, 0x90, 0xA3, 0xA5 };
        static void Key(int vk, bool up)
        {
            var i = new INPUT[1];
            i[0].type = 1; i[0].u.ki.wVk = (ushort)vk; i[0].u.ki.wScan = (ushort)MapVirtualKey((uint)vk, 0);
            i[0].u.ki.dwFlags = (up ? 2u : 0u) | (Extended.Contains(vk) ? 1u : 0u);
            SendInput(1, i, InputSize);
        }
        static void Keys(Dictionary<string, object> m)
        {
            var arr = m["vks"] as object[];
            if (arr == null || arr.Length == 0) return;
            string a = Str(m, "action") ?? "press";
            if (a != "up") GuardKeys();
            var vks = new int[arr.Length];
            for (int i = 0; i < arr.Length; i++) vks[i] = Convert.ToInt32(arr[i]);
            if (a == "down" || a == "press") foreach (var vk in vks) Key(vk, false);
            if (a == "press") Thread.Sleep(20);
            if (a == "up" || a == "press") for (int i = vks.Length - 1; i >= 0; i--) Key(vks[i], true);
        }
        static void TypeText(string text)
        {
            if (text.Length == 0) return;
            GuardKeys();
            int sent = 0;
            foreach (char ch in text)
            {
                if (ch == '\r') continue;
                if (ch == '\n') { Key(0x0D, false); Key(0x0D, true); }
                else if (ch == '\t') { Key(0x09, false); Key(0x09, true); }
                else
                {
                    // KEYEVENTF_UNICODE: the character itself, whatever the keyboard layout.
                    var i = new INPUT[2];
                    i[0].type = 1; i[0].u.ki.wScan = ch; i[0].u.ki.dwFlags = 4;
                    i[1].type = 1; i[1].u.ki.wScan = ch; i[1].u.ki.dwFlags = 4 | 2;
                    SendInput(2, i, InputSize);
                }
                if (++sent % 24 == 0) Thread.Sleep(10); // a slow app drops what arrives faster than it reads
            }
        }
        // Windows lets a window be brought forward only by the process that last had input; joining
        // the input of the window in front for the moment of the switch is the documented way round.
        static bool Focus(IntPtr h)
        {
            if (Confine != null) { uint p; GetWindowThreadProcessId(h, out p); if (!ConfinedPids().Contains(p)) throw new Exception("Refused: that window is not the one this test opened."); }
            if (IsIconic(h)) ShowWindow(h, 9);
            var fg = GetForegroundWindow();
            uint fpid, tpid;
            uint ft = GetWindowThreadProcessId(fg, out fpid), me = GetCurrentThreadId(), tt = GetWindowThreadProcessId(h, out tpid);
            bool a1 = ft != me && AttachThreadInput(me, ft, true), a2 = tt != me && tt != ft && AttachThreadInput(me, tt, true);
            try { BringWindowToTop(h); SetForegroundWindow(h); }
            finally { if (a1) AttachThreadInput(me, ft, false); if (a2) AttachThreadInput(me, tt, false); }
            Thread.Sleep(80);
            return GetForegroundWindow() == h;
        }
        static Dictionary<string, object> Open(string name)
        {
            if (Confine != null) throw new Exception("Refused: a test never opens apps.");
            if (name.Trim().Length == 0) throw new Exception("Which app?");
            // A Start menu shortcut first - that is the name a person knows an app by - then
            // whatever Windows itself can run by that name (notepad, calc, an App Paths entry).
            string lnk = FindShortcut(name);
            var psi = new ProcessStartInfo(lnk ?? name);
            psi.UseShellExecute = true;
            Process.Start(psi);
            return Obj("ok", true, "via", lnk != null ? "start menu" : "name", "path", lnk);
        }
        static string FindShortcut(string name)
        {
            var roots = new string[] { Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu), Environment.GetFolderPath(Environment.SpecialFolder.StartMenu) };
            string contains = null;
            foreach (var root in roots)
            {
                if (string.IsNullOrEmpty(root) || !Directory.Exists(root)) continue;
                string[] files;
                try { files = Directory.GetFiles(root, "*.lnk", SearchOption.AllDirectories); } catch (Exception) { continue; }
                foreach (var f in files)
                {
                    var n = Path.GetFileNameWithoutExtension(f);
                    if (string.Equals(n, name, StringComparison.OrdinalIgnoreCase)) return f;
                    if (contains == null && n.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0 && n.IndexOf("uninstall", StringComparison.OrdinalIgnoreCase) < 0) contains = f;
                }
            }
            return contains;
        }

        // ---------- the banner on the PC ----------
        static Banner TheBanner;
        internal static IntPtr BannerHandle = IntPtr.Zero;
        static void BannerSet(bool on, string text, string button)
        {
            if (TheBanner == null)
            {
                if (!on) return;
                var ready = new ManualResetEvent(false);
                var t = new Thread(delegate ()
                {
                    TheBanner = new Banner();
                    BannerHandle = TheBanner.Handle;
                    ready.Set();
                    Application.Run();
                });
                t.IsBackground = true;
                t.SetApartmentState(ApartmentState.STA);
                t.Start();
                ready.WaitOne();
            }
            TheBanner.BeginInvoke((MethodInvoker)delegate
            {
                if (on) TheBanner.Present(text ?? "This PC is being controlled from claude-anywhere", button ?? "Stop");
                else TheBanner.Hide();
            });
        }
        internal static void KeepOnTop(IntPtr h) { SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010 | 0x0040); }
    }

    // Small, on top of everything, and never takes the keyboard from what the person is doing.
    class Banner : Form
    {
        readonly Label label = new Label();
        readonly Button stop = new Button();
        public Banner()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            TopMost = true;
            StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None;
            BackColor = Color.FromArgb(38, 38, 36);
            Font = new Font("Segoe UI", 10f);
            Text = "claude-anywhere";
            label.AutoSize = true;
            label.ForeColor = Color.FromArgb(240, 238, 230);
            label.BackColor = Color.Transparent;
            stop.FlatStyle = FlatStyle.Flat;
            stop.FlatAppearance.BorderSize = 0;
            stop.BackColor = Color.FromArgb(217, 119, 87);
            stop.ForeColor = Color.White;
            stop.AutoSize = true;
            stop.Cursor = Cursors.Hand;
            stop.Click += delegate { Hide(); Helper.Send(new Dictionary<string, object> { { "ev", "stop" } }); };
            Controls.Add(label);
            Controls.Add(stop);
        }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams
        {
            get
            {
                var cp = base.CreateParams;
                cp.ExStyle |= 0x08000000 | 0x80 | 0x8; // no activate, no taskbar button, topmost
                return cp;
            }
        }
        public void Present(string text, string button)
        {
            label.Text = text;
            stop.Text = button;
            var ls = label.PreferredSize; var bs = stop.PreferredSize;
            int pad = (int)Math.Round(ls.Height * 0.6), gap = ls.Height;
            int h = Math.Max(ls.Height, bs.Height) + pad;
            int w = pad + ls.Width + gap + bs.Width + pad / 2;
            label.Location = new Point(pad, (h - ls.Height) / 2);
            stop.Size = new Size(bs.Width + pad / 2, Math.Max(bs.Height, h - pad / 2));
            stop.Location = new Point(w - stop.Width - pad / 4, (h - stop.Height) / 2);
            var wa = Screen.PrimaryScreen.WorkingArea;
            Bounds = new Rectangle(wa.Left + (wa.Width - w) / 2, wa.Top + Math.Max(4, pad / 2), w, h);
            if (!Visible) Show();
            Helper.KeepOnTop(Handle);
        }
    }
}
