// 真正的 WinForms 像素窗口；stdin 只切换画面和读结果，点击全部由生产 SendInput 派发。
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Threading;
using System.Windows.Forms;
using System.Runtime.InteropServices;

public class ImageMatchFixture : Form {
    [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int value);
    Bitmap Pattern, Distractor;
    string Mode = "none";
    int Clicks;
    Point LastClick;

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
    }
    protected override void OnMouseUp(MouseEventArgs e) {
        base.OnMouseUp(e);
        Clicks++;
        LastClick = e.Location;
    }
    void Command(string text) {
        if (text == "state") Console.WriteLine("mode:" + Mode + ";clicks:" + Clicks + ";last:" + LastClick.X + "," + LastClick.Y);
        else if (text == "quit") { Console.WriteLine("quitting"); Close(); }
        else if (text == "two" || text == "crowded" || text == "tail" || text == "unique" || text == "none") {
            Mode = text;
            Refresh(); // 回包时新像素已经画好，验收不靠固定睡眠猜时序。
            Console.WriteLine("painted:" + Mode);
        } else Console.WriteLine("unknown");
        Console.Out.Flush();
    }
    protected override void Dispose(bool disposing) {
        if (disposing) { Pattern.Dispose(); Distractor.Dispose(); }
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
