// Ward's tray icon and app window. Compiled by scripts/build-exe.mjs with the C# compiler that
// ships with Windows (.NET Framework 4, C# 5), embedded in Ward.exe and unpacked to the data folder
// at runtime. Ward (the background process) starts it and talks to it over stdin/stdout:
//
//   Ward -> helper:  notify<TAB>title<TAB>text   update<TAB>version (or empty)   focus<TAB>pid
//                    show   hide   title<TAB>text   log<TAB>line
//                    qr<TAB>base64 png<TAB>address<TAB>code   phones<TAB>name<US>last used<RS>...   exit
//   helper -> Ward:  ready   open   open-new   update   quit   newqr   forget<TAB>n|all   closed
//
// When stdin closes (Ward exited), the icon and window go away and the helper quits.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Ward")]
[assembly: AssemblyProduct("Ward")]
[assembly: AssemblyCompany("OverXone")]
[assembly: AssemblyCopyright("Copyright (c) 2026 OverXone. PolyForm Noncommercial 1.0.0.")]
[assembly: AssemblyDescription("Ward tray icon and window")]

namespace Ward
{
    /// <summary>Shows a tiny image scaled up without smoothing, so the QR code stays sharp.</summary>
    internal sealed class PixelBox : PictureBox
    {
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.InterpolationMode = InterpolationMode.NearestNeighbor;
            e.Graphics.PixelOffsetMode = PixelOffsetMode.Half;
            base.OnPaint(e);
        }
    }

    internal sealed class WardWindow : Form
    {
        private readonly Action<string> send;
        private readonly PixelBox qr = new PixelBox();
        private readonly Label address = new Label();
        private readonly Label code = new Label();
        private readonly ListBox phones = new ListBox();
        private readonly Button forget = new Button();
        private readonly Button forgetAll = new Button();
        private readonly TextBox activity = new TextBox();
        private readonly Button update = new Button();
        private readonly Label noPhones = new Label();
        public bool Quitting;

        public WardWindow(Action<string> send)
        {
            this.send = send;
            SuspendLayout();
            Text = "Ward";
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            Font = new Font("Segoe UI", 9.5F);
            BackColor = Color.White;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(560, 640);
            MinimumSize = new Size(480, 560);

            var layout = new TableLayoutPanel();
            layout.Dock = DockStyle.Fill;
            layout.Padding = new Padding(16);
            layout.ColumnCount = 1;
            layout.RowCount = 4;
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            Controls.Add(layout);

            // Pairing: QR code on the left, how-to and code on the right.
            var pairing = new TableLayoutPanel();
            pairing.Dock = DockStyle.Top;
            pairing.AutoSize = true;
            pairing.ColumnCount = 2;
            pairing.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 236F));
            pairing.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            qr.Size = new Size(220, 220);
            qr.SizeMode = PictureBoxSizeMode.Zoom;
            qr.BackColor = Color.White;
            qr.Margin = new Padding(0, 0, 16, 0);
            pairing.Controls.Add(qr, 0, 0);

            var info = new FlowLayoutPanel();
            info.FlowDirection = FlowDirection.TopDown;
            info.WrapContents = false;
            info.AutoSize = true;
            info.Dock = DockStyle.Fill;
            info.Controls.Add(Heading("Add a phone"));
            info.Controls.Add(Note("Scan the QR code with your phone's camera. The phone must be on the same Wi-Fi as this PC.", 280));
            address.AutoSize = true;
            address.MaximumSize = new Size(280, 0);
            address.Margin = new Padding(0, 10, 0, 0);
            info.Controls.Add(address);
            code.AutoSize = true;
            code.Font = new Font("Consolas", 20F, FontStyle.Bold);
            code.Margin = new Padding(0, 4, 0, 0);
            info.Controls.Add(code);
            info.Controls.Add(Note("The QR code works once. The code works once, for 5 minutes.", 280, Color.DimGray));
            var newQr = new Button();
            newQr.Text = "New QR code";
            newQr.AutoSize = true;
            newQr.Margin = new Padding(0, 10, 0, 0);
            newQr.Click += delegate { send("newqr"); };
            info.Controls.Add(newQr);
            pairing.Controls.Add(info, 1, 0);
            layout.Controls.Add(pairing, 0, 0);

            // Paired phones.
            var phonesPanel = new FlowLayoutPanel();
            phonesPanel.FlowDirection = FlowDirection.TopDown;
            phonesPanel.WrapContents = false;
            phonesPanel.AutoSize = true;
            phonesPanel.Dock = DockStyle.Top;
            phonesPanel.Margin = new Padding(0, 16, 0, 0);
            phonesPanel.Controls.Add(Heading("Paired phones"));
            phonesPanel.Controls.Add(Note("They connect by themselves whenever Ward is running.", 500, Color.DimGray));
            phones.Width = 520;
            phones.Height = 84;
            phones.IntegralHeight = false;
            phones.Margin = new Padding(0, 6, 0, 0);
            phones.SelectedIndexChanged += delegate { forget.Enabled = phones.SelectedIndex >= 0; };
            phonesPanel.Controls.Add(phones);
            noPhones.Text = "No phones paired yet.";
            noPhones.AutoSize = true;
            noPhones.ForeColor = Color.DimGray;
            noPhones.Margin = new Padding(0, 6, 0, 0);
            phonesPanel.Controls.Add(noPhones);
            var phoneButtons = new FlowLayoutPanel();
            phoneButtons.AutoSize = true;
            phoneButtons.Margin = new Padding(0, 6, 0, 0);
            forget.Text = "Forget this phone";
            forget.AutoSize = true;
            forget.Enabled = false;
            forget.Click += delegate
            {
                if (phones.SelectedIndex < 0) return;
                if (Confirm("Forget " + phones.SelectedItem + "? It will need to pair again."))
                    send("forget\t" + (phones.SelectedIndex + 1));
            };
            forgetAll.Text = "Forget all";
            forgetAll.AutoSize = true;
            forgetAll.Click += delegate { if (Confirm("Forget all phones? They will need to pair again.")) send("forget\tall"); };
            phoneButtons.Controls.Add(forget);
            phoneButtons.Controls.Add(forgetAll);
            phonesPanel.Controls.Add(phoneButtons);
            layout.Controls.Add(phonesPanel, 0, 1);

            // Activity log.
            var activityPanel = new TableLayoutPanel();
            activityPanel.Dock = DockStyle.Fill;
            activityPanel.Margin = new Padding(0, 16, 0, 0);
            activityPanel.RowCount = 2;
            activityPanel.ColumnCount = 1;
            activityPanel.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            activityPanel.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
            activityPanel.Controls.Add(Heading("Activity"), 0, 0);
            activity.Multiline = true;
            activity.ReadOnly = true;
            activity.ScrollBars = ScrollBars.Vertical;
            activity.Font = new Font("Consolas", 9F);
            activity.BackColor = Color.FromArgb(248, 248, 248);
            activity.Dock = DockStyle.Fill;
            activity.Margin = new Padding(0, 6, 0, 0);
            activityPanel.Controls.Add(activity, 0, 1);
            layout.Controls.Add(activityPanel, 0, 2);

            // Bottom bar.
            var bottom = new TableLayoutPanel();
            bottom.Dock = DockStyle.Top;
            bottom.AutoSize = true;
            bottom.ColumnCount = 3;
            bottom.Margin = new Padding(0, 12, 0, 0);
            bottom.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
            bottom.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            bottom.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
            var hint = Note("Closing this window keeps Ward running in the tray.", 300, Color.DimGray);
            hint.Anchor = AnchorStyles.Left;
            bottom.Controls.Add(hint, 0, 0);
            update.AutoSize = true;
            update.Visible = false;
            update.Click += delegate { send("update"); };
            bottom.Controls.Add(update, 1, 0);
            var quit = new Button();
            quit.Text = "Quit Ward";
            quit.AutoSize = true;
            quit.Click += delegate { if (Confirm("Quit Ward? Your phone will disconnect.")) send("quit"); };
            bottom.Controls.Add(quit, 2, 0);
            layout.Controls.Add(bottom, 0, 3);

            AutoScaleDimensions = new SizeF(96F, 96F);
            AutoScaleMode = AutoScaleMode.Dpi;
            ResumeLayout(false);
            SetPhones(new List<string>());
        }

        private static Label Heading(string text)
        {
            var label = new Label();
            label.Text = text;
            label.AutoSize = true;
            label.Font = new Font("Segoe UI Semibold", 11F);
            label.Margin = new Padding(0, 0, 0, 2);
            return label;
        }

        private static Label Note(string text, int width)
        {
            return Note(text, width, Color.Black);
        }

        private static Label Note(string text, int width, Color color)
        {
            var label = new Label();
            label.Text = text;
            label.AutoSize = true;
            label.MaximumSize = new Size(width, 0);
            label.ForeColor = color;
            label.Margin = new Padding(0, 2, 0, 0);
            return label;
        }

        private bool Confirm(string question)
        {
            return MessageBox.Show(this, question, "Ward", MessageBoxButtons.OKCancel, MessageBoxIcon.Question) == DialogResult.OK;
        }

        public void SetPairing(Image image, string addressText, string codeText)
        {
            var old = qr.Image;
            qr.Image = image;
            if (old != null) old.Dispose();
            address.Text = "Or open  " + addressText + "  on the phone and enter:";
            code.Text = codeText;
        }

        public void SetPhones(List<string> items)
        {
            phones.BeginUpdate();
            phones.Items.Clear();
            foreach (var item in items) phones.Items.Add(item);
            phones.EndUpdate();
            phones.Visible = items.Count > 0;
            noPhones.Visible = items.Count == 0;
            forget.Enabled = false;
            forgetAll.Visible = items.Count > 1;
        }

        public void AddLog(string line)
        {
            if (activity.Lines.Length > 400)
            {
                var keep = new string[300];
                Array.Copy(activity.Lines, activity.Lines.Length - 300, keep, 0, 300);
                activity.Lines = keep;
            }
            if (activity.TextLength > 0) activity.AppendText(Environment.NewLine);
            activity.AppendText(line);
        }

        public void SetUpdate(string version)
        {
            update.Text = "Update to Ward " + version;
            update.Visible = version.Length > 0;
        }

        public void ShowInFront()
        {
            if (!Visible) Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            BringToFront();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            // The X hides the window; Ward keeps running in the tray.
            if (!Quitting && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
                send("closed");
                return;
            }
            base.OnFormClosing(e);
        }
    }

    internal sealed class TrayContext : ApplicationContext
    {
        [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hWnd, int cmd);
        [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
        private const int SW_RESTORE = 9;

        private readonly NotifyIcon icon;
        private readonly ToolStripMenuItem updateItem;
        private readonly WardWindow window;
        private readonly TextWriter output;

        public TrayContext()
        {
            output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            ((StreamWriter)output).AutoFlush = true;

            window = new WardWindow(Send);
            // Create the window's handle now (hidden), so stdin messages can be run on the UI thread.
            var unused = window.Handle;

            var menu = new ContextMenuStrip();
            var open = new ToolStripMenuItem("Open Ward");
            open.Font = new Font(open.Font, FontStyle.Bold);
            open.Click += delegate { Send("open"); };
            updateItem = new ToolStripMenuItem("Update");
            updateItem.Visible = false;
            updateItem.Click += delegate { Send("update"); };
            var quit = new ToolStripMenuItem("Quit Ward");
            quit.Click += delegate { Send("quit"); };
            menu.Items.Add(open);
            menu.Items.Add(updateItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(quit);

            icon = new NotifyIcon();
            icon.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            icon.Text = "Ward";
            icon.ContextMenuStrip = menu;
            icon.MouseClick += delegate(object s, MouseEventArgs e) { if (e.Button == MouseButtons.Left) Send("open"); };
            icon.BalloonTipClicked += delegate { Send("open"); };
            icon.Visible = true;

            var reader = new Thread(ReadInput);
            reader.IsBackground = true;
            reader.Start();
            Send("ready");
        }

        private void Send(string message)
        {
            try { output.WriteLine(message); }
            catch (IOException) { Stop(); }
        }

        private void ReadInput()
        {
            var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            string line;
            try
            {
                while ((line = input.ReadLine()) != null)
                {
                    if (line == "exit") break;
                    var copy = line;
                    window.BeginInvoke(new MethodInvoker(delegate { Handle(copy); }));
                }
            }
            catch (IOException) { }
            window.BeginInvoke(new MethodInvoker(Stop));
        }

        private void Handle(string line)
        {
            var parts = line.Split('\t');
            var kind = parts[0];
            if (kind == "notify" && parts.Length >= 3)
            {
                icon.ShowBalloonTip(5000, parts[1], parts[2], ToolTipIcon.Info);
            }
            else if (kind == "update")
            {
                var version = parts.Length >= 2 ? parts[1] : "";
                updateItem.Text = "Update to Ward " + version;
                updateItem.Visible = version.Length > 0;
                window.SetUpdate(version);
            }
            else if (kind == "focus" && parts.Length >= 2)
            {
                if (!Focus(parts[1])) Send("open-new");
            }
            else if (kind == "show") window.ShowInFront();
            else if (kind == "hide") window.Hide();
            else if (kind == "title" && parts.Length >= 2) window.Text = parts[1];
            else if (kind == "log" && parts.Length >= 2) window.AddLog(parts[1]);
            else if (kind == "qr" && parts.Length >= 4)
            {
                try
                {
                    using (var stream = new MemoryStream(Convert.FromBase64String(parts[1])))
                    using (var decoded = Image.FromStream(stream))
                        window.SetPairing(new Bitmap(decoded), parts[2], parts[3]);
                }
                catch (FormatException) { }
                catch (ArgumentException) { }
            }
            else if (kind == "phones")
            {
                var items = new List<string>();
                if (parts.Length >= 2 && parts[1].Length > 0)
                {
                    foreach (var entry in parts[1].Split('\u001e'))
                    {
                        var fields = entry.Split('\u001f');
                        items.Add(fields.Length >= 2 ? fields[0] + "  (last used " + fields[1] + ")" : fields[0]);
                    }
                }
                window.SetPhones(items);
            }
        }

        /// <summary>Brings the window of a process to the front. False if it has no window of its own.</summary>
        private static bool Focus(string pidText)
        {
            int pid;
            if (!int.TryParse(pidText, out pid)) return false;
            try
            {
                var handle = Process.GetProcessById(pid).MainWindowHandle;
                if (handle == IntPtr.Zero) return false;
                if (IsIconic(handle)) ShowWindowAsync(handle, SW_RESTORE);
                return SetForegroundWindow(handle);
            }
            catch (ArgumentException) { return false; }
            catch (InvalidOperationException) { return false; }
        }

        private bool stopped;

        private void Stop()
        {
            if (stopped) return;
            stopped = true;
            icon.Visible = false;
            icon.Dispose();
            window.Quitting = true;
            window.Close();
            ExitThread();
        }
    }

    internal static class Program
    {
        [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();

        [STAThread]
        private static void Main()
        {
            try { SetProcessDPIAware(); } catch (EntryPointNotFoundException) { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayContext());
        }
    }
}
