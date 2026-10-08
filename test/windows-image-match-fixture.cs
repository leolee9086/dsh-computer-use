// 真正的 WinForms 像素窗口；stdin 只切换画面和读结果，点击全部由生产 SendInput 派发。
using System;
using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using System.Threading;
using System.Windows.Forms;
using System.Runtime.InteropServices;

public class ImageMatchFixture : Form {
    [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int value);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] static extern uint GetPixel(IntPtr dc, int x, int y);
    Bitmap Pattern, Distractor, ColorPattern, ColorDistractor, AlphaPattern, ScaledColor, ScaledDistractor, ScaledAlpha;
    string Mode = "none";
    int Clicks;
    Point LastClick;

    static Bitmap Twice(Bitmap source) {
        var result = new Bitmap(source.Width * 2, source.Height * 2, PixelFormat.Format32bppArgb);
        // 明确画 2x2 同色块，不靠绘图 API 的默认滤波设置猜目标像素。
        for (int y = 0; y < result.Height; y++) for (int x = 0; x < result.Width; x++)
            result.SetPixel(x, y, source.GetPixel(x / 2, y / 2));
        return result;
    }
    ImageMatchFixture(string template) {
        Text = "Computer image coverage fixture";
        AutoScaleMode = AutoScaleMode.None;
        FormBorderStyle = FormBorderStyle.None;
        ClientSize = new Size(600, 360);
        StartPosition = FormStartPosition.Manual;
        Location = new Point(40, 60);
        BackColor = Color.FromArgb(3, 3, 3);
        DoubleBuffered = true;
        Pattern = new Bitmap(24, 24, PixelFormat.Format32bppArgb);
        Distractor = new Bitmap(24, 24, PixelFormat.Format32bppArgb);
        for (int by = 0; by < 6; by++) for (int bx = 0; bx < 6; bx++) {
            int value = 65 + ((bx * 71 + by * 53 + bx * by * 17) % 120);
            for (int dy = 0; dy < 4; dy++) for (int dx = 0; dx < 4; dx++) {
                // 每个 4x4 块的均值完全相同，细节位置不同；旧粗筛无法区分。
                int delta = dy == 0 && dx == 0 ? 40 : dy == 0 && dx == 1 ? -40 : 0;
                int other = dy == 3 && dx == 2 ? 40 : dy == 3 && dx == 3 ? -40 : 0;
                Pattern.SetPixel(bx * 4 + dx, by * 4 + dy, Color.FromArgb(value + delta, value + delta, value + delta));
                Distractor.SetPixel(bx * 4 + dx, by * 4 + dy, Color.FromArgb(value + other, value + other, value + other));
            }
        }
        Pattern.Save(template, ImageFormat.Png);
        ColorPattern = new Bitmap(24, 24, PixelFormat.Format32bppArgb);
        ColorDistractor = new Bitmap(24, 24, PixelFormat.Format32bppArgb);
        AlphaPattern = new Bitmap(24, 24, PixelFormat.Format32bppArgb);
        using (var transparent = new Bitmap(24, 24, PixelFormat.Format32bppArgb))
        using (var flatAlpha = new Bitmap(24, 24, PixelFormat.Format32bppArgb)) {
            for (int y = 0; y < 24; y++) for (int x = 0; x < 24; x++) {
                int value = 50 + ((x * 71 + y * 53 + x * y * 17) % 150);
                // Rec.601 整数亮度两者严格相同：value + floor(165/1000) 与 value + floor(422/1000)。
                var color = Color.FromArgb(value + 30, value - 15, value);
                ColorPattern.SetPixel(x, y, color);
                ColorDistractor.SetPixel(x, y, Color.FromArgb(value - 30, value + 16, value));
                bool center = x >= 6 && x < 18 && y >= 6 && y < 18;
                bool ring = x >= 5 && x < 19 && y >= 5 && y < 19;
                AlphaPattern.SetPixel(x, y, center ? color : Color.FromArgb(ring ? 127 : 0, 220, 30 + x * 5, 180));
                transparent.SetPixel(x, y, Color.FromArgb(0, value + 30, value - 15, value));
                flatAlpha.SetPixel(x, y, center ? Color.FromArgb(90, 90, 90) : Color.FromArgb(0, value + 30, value - 15, value));
            }
            string directory = Path.GetDirectoryName(template);
            ColorPattern.Save(Path.Combine(directory, "rgb.png"), ImageFormat.Png);
            AlphaPattern.Save(Path.Combine(directory, "alpha.png"), ImageFormat.Png);
            transparent.Save(Path.Combine(directory, "transparent.png"), ImageFormat.Png);
            flatAlpha.Save(Path.Combine(directory, "flat-alpha.png"), ImageFormat.Png);
        }
        ScaledColor = Twice(ColorPattern); ScaledDistractor = Twice(ColorDistractor); ScaledAlpha = Twice(AlphaPattern);
        ScaledColor.Save(Path.Combine(Path.GetDirectoryName(template), "scaled-rgb.png"), ImageFormat.Png);
    }
    protected override void OnPaint(PaintEventArgs e) {
        base.OnPaint(e);
        if (Mode == "two" || Mode == "crowded") {
            e.Graphics.DrawImageUnscaled(Pattern, 40, 40);
            e.Graphics.DrawImageUnscaled(Pattern, 520, 300);
        }
        if (Mode == "crowded") for (int index = 0; index < 9; index++)
            e.Graphics.DrawImageUnscaled(Distractor, 84 + index * 44, 40);
        if (Mode == "tail") e.Graphics.DrawImageUnscaled(Pattern, 576, 336);
        if (Mode == "unique") e.Graphics.DrawImageUnscaled(Pattern, 200, 160);
        if (Mode == "rgb") {
            e.Graphics.DrawImageUnscaled(ColorPattern, 200, 160);
            e.Graphics.DrawImageUnscaled(ColorDistractor, 520, 300);
        }
        if (Mode == "alpha") e.Graphics.DrawImageUnscaled(AlphaPattern, 300, 100);
        if (Mode == "scaled") {
            e.Graphics.DrawImageUnscaled(ScaledColor, 240, 180);
            e.Graphics.DrawImageUnscaled(ScaledDistractor, 40, 60);
        }
        if (Mode == "alpha-scaled") e.Graphics.DrawImageUnscaled(ScaledAlpha, 380, 220);
    }
    protected override void OnMouseUp(MouseEventArgs e) {
        base.OnMouseUp(e);
        Clicks++;
        LastClick = e.Location;
    }
    void InspectAlpha() {
        IntPtr dc = GetDC(IntPtr.Zero);
        int differences = 0; string first = "";
        try {
            for (int y = 6; y < 18; y++) for (int x = 6; x < 18; x++) {
                var expected = AlphaPattern.GetPixel(x, y);
                var point = PointToScreen(new Point(300 + x, 100 + y));
                uint actual = GetPixel(dc, point.X, point.Y);
                int r = (int)(actual & 255), g = (int)((actual >> 8) & 255), b = (int)((actual >> 16) & 255);
                if (r != expected.R || g != expected.G || b != expected.B) {
                    differences++;
                    if (first == "") first = x + "," + y + ";expected:" + expected.R + "," + expected.G + "," + expected.B + ";actual:" + r + "," + g + "," + b;
                }
            }
        } finally { ReleaseDC(IntPtr.Zero, dc); }
        Console.WriteLine("alpha-differences:" + differences + ";first:" + first);
    }
    void Command(string text) {
        if (text == "inspect-alpha") InspectAlpha();
        else if (text == "state") Console.WriteLine("mode:" + Mode + ";clicks:" + Clicks + ";last:" + LastClick.X + "," + LastClick.Y);
        else if (text == "quit") { Console.WriteLine("quitting"); Close(); }
        else if (text == "two" || text == "crowded" || text == "tail" || text == "unique" || text == "none"
            || text == "rgb" || text == "alpha" || text == "scaled" || text == "alpha-scaled") {
            Mode = text;
            Refresh(); // 回包时新像素已经画好，验收不靠固定睡眠猜时序。
            Console.WriteLine("painted:" + Mode);
        } else Console.WriteLine("unknown");
        Console.Out.Flush();
    }
    protected override void Dispose(bool disposing) {
        if (disposing) {
            Pattern.Dispose(); Distractor.Dispose(); ColorPattern.Dispose(); ColorDistractor.Dispose();
            AlphaPattern.Dispose(); ScaledColor.Dispose(); ScaledDistractor.Dispose(); ScaledAlpha.Dispose();
        }
        base.Dispose(disposing);
    }
    [STAThread] public static void Main(string[] args) {
        SetProcessDpiAwareness(2);
        Console.InputEncoding = new System.Text.UTF8Encoding(false);
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        Application.EnableVisualStyles();
        using (var form = new ImageMatchFixture(args[0])) {
            form.Shown += delegate {
                Console.WriteLine(form.Handle.ToInt64()); Console.Out.Flush();
                new Thread(delegate() {
                    string text;
                    while ((text = Console.ReadLine()) != null) {
                        string command = text;
                        try { form.BeginInvoke((Action)delegate { form.Command(command); }); }
                        catch (InvalidOperationException) { return; }
                    }
                }) { IsBackground = true }.Start();
            };
            Application.Run(form);
        }
    }
}
