// 真正自绘 WinForms 画面：文字、RGB 色块、异步变化、遮挡与窗口移动。
// stdin 仅改变受控测试状态；MouseUp 记录用来验证观测工具没有注入点击。
using System;
using System.Drawing;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

class VisualFixture : Form {
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    readonly Form cover;
    readonly Font font = new Font("Segoe UI", 28, FontStyle.Bold, GraphicsUnit.Pixel);
    readonly System.Windows.Forms.Timer change = new System.Windows.Forms.Timer();
    string phase = "WAIT";
    bool loseFocus;
    int clicks;

    VisualFixture() {
        Text = "DSH Visual " + Guid.NewGuid();
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Bounds = new Rectangle(80, 80, 760, 420);
        BackColor = Color.White;
        DoubleBuffered = true;
        cover = new Form { Text = "DSH Visual Cover " + Guid.NewGuid(), FormBorderStyle = FormBorderStyle.None,
            StartPosition = FormStartPosition.Manual, Bounds = Bounds, BackColor = Color.FromArgb(80, 20, 160) };
        MouseUp += (sender, args) => { clicks++; };
        change.Interval = 750;
        change.Tick += (sender, args) => {
            change.Stop();
            if (loseFocus) { cover.Bounds = Bounds; cover.Show(); cover.Activate(); }
            else { phase = "DONE"; Invalidate(); Update(); }
        };
        Shown += (sender, args) => {
            Console.WriteLine(Handle.ToInt64()); Console.Out.Flush();
            var reader = new Thread(() => {
                string line;
                while ((line = Console.ReadLine()) != null) {
                    string command = line;
                    Invoke((Action)(() => Execute(command)));
                    if (command == "quit") break;
                }
            });
            reader.IsBackground = true; reader.Start();
        };
    }
    protected override void OnPaint(PaintEventArgs args) {
        base.OnPaint(args);
        Graphics g = args.Graphics;
        g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
        g.DrawString(phase == "DONE" ? "ALPHA DONE" : "ALPHA READY", font, Brushes.Black, 20, 20);
        g.DrawString(phase == "DONE" ? "STATUS OK" : "STATUS WAIT", font, Brushes.Black, 20, 70);
        g.DrawString("OUTSIDE SECRET", font, Brushes.Black, 20, 280);
        Color target = phase == "DONE" ? Color.FromArgb(25, 180, 80) : Color.FromArgb(40, 120, 200);
        using (var brush = new SolidBrush(target)) {
            g.FillRectangle(brush, 30, 180, 20, 12); g.FillRectangle(brush, 60, 180, 20, 12);
        }
        using (var brush = new SolidBrush(Color.FromArgb(42, 118, 202))) g.FillRectangle(brush, 90, 180, 20, 12);
        using (var brush = new SolidBrush(Color.FromArgb(42, 118, 203))) g.FillRectangle(brush, 120, 180, 20, 12);
    }
    void Execute(string command) {
        switch (command) {
            case "reset": change.Stop(); phase = "WAIT"; cover.Hide(); Invalidate(); Update(); break;
            case "later": case "later-lost":
                phase = "WAIT"; loseFocus = command == "later-lost"; Invalidate(); Update(); change.Start(); break;
            case "cover": cover.Bounds = Bounds; cover.Show(); cover.Activate(); break;
            case "move": Location = new Point(140, 100); break;
            case "state": break;
            case "quit": cover.Close(); Close(); break;
            default: throw new InvalidOperationException("Unknown fixture command: " + command);
        }
        Console.WriteLine("command:" + command + ";phase:" + phase + ";clicks:" + clicks + ";foreground:" + GetForegroundWindow().ToInt64()
            + ";bounds:" + Left + "," + Top + "," + Width + "," + Height + ";cover:" + cover.Handle.ToInt64());
        Console.Out.Flush();
    }
    protected override void Dispose(bool disposing) {
        if (disposing) { change.Dispose(); font.Dispose(); cover.Dispose(); }
        base.Dispose(disposing);
    }
    [STAThread] static void Main() {
        SetProcessDPIAware(); Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new VisualFixture());
    }
}
