'use strict';
// Native "Select folder" dialog (Windows Vista+ IFileDialog with FOS_PICKFOLDERS), shown by a
// short PowerShell script. The daemon runs without a window, so a hidden top-most form owns the
// dialog to bring it in front of the browser.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CSHARP = `
using System;
using System.Runtime.InteropServices;
public static class ReelHeistFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRCW {}

  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr hwnd);
    void SetFileTypes(uint count, IntPtr filters);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
  }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetAttributes(uint mask, out uint attribs);
    void Compare(IShellItem other, uint hint, out int order);
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);

  public static string Pick(string initial, string title, IntPtr owner) {
    var dlg = (IFileDialog)new FileOpenDialogRCW();
    uint fos;
    dlg.GetOptions(out fos);
    dlg.SetOptions(fos | 0x20 | 0x40); // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
    if (!String.IsNullOrEmpty(title)) dlg.SetTitle(title);
    if (!String.IsNullOrEmpty(initial) && System.IO.Directory.Exists(initial)) {
      try {
        IShellItem folder;
        SHCreateItemFromParsingName(initial, IntPtr.Zero, typeof(IShellItem).GUID, out folder);
        dlg.SetFolder(folder);
      } catch { }
    }
    int hr = dlg.Show(owner);
    if (hr == unchecked((int)0x800704C7)) return null; // ERROR_CANCELLED: the user closed the dialog
    if (hr != 0) Marshal.ThrowExceptionForHR(hr);
    IShellItem result;
    dlg.GetResult(out result);
    string picked;
    result.GetDisplayName(0x80058000, out picked); // SIGDN_FILESYSPATH
    return picked;
  }
}
`;

// Inputs come through environment variables, so no user text is ever part of the script.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
${CSHARP}
'@
$owner = New-Object System.Windows.Forms.Form -Property @{
  TopMost = $true; ShowInTaskbar = $false; Opacity = 0
  FormBorderStyle = 'None'; StartPosition = 'CenterScreen'; Width = 1; Height = 1
}
$owner.Show()
$owner.Activate()
try {
  $picked = [ReelHeistFolderPicker]::Pick($env:REELHEIST_PICK_INITIAL, $env:REELHEIST_PICK_TITLE, $owner.Handle)
} finally {
  $owner.Close()
}
if ($picked) { [Console]::Out.Write($picked) }
`;

function powershellExe() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  return path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

// -EncodedCommand returns at once without showing the dialog, so the script runs from a file.
// The name carries a hash of the content, so a changed script never reuses an old file.
function scriptFile() {
  const hash = crypto.createHash('sha256').update(SCRIPT).digest('hex').slice(0, 12);
  const file = path.join(os.tmpdir(), `reelheist-pick-folder-${hash}.ps1`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, '\ufeff' + SCRIPT.replace(/\r?\n/g, '\r\n'), 'utf8');
  return file;
}

let pending = null;

// Resolves to the chosen absolute folder path, or null when the user cancels.
// A second call while the dialog is open gets the same answer instead of a second dialog.
function pickFolder({ initial = '', title = '' } = {}) {
  if (pending) return pending;
  if (process.platform !== 'win32') {
    return Promise.reject(Object.assign(new Error('Folder picker is only available on Windows'), { code: 'unsupported' }));
  }
  pending = new Promise((resolve, reject) => {
    const child = spawn(powershellExe(), ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptFile()], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, REELHEIST_PICK_INITIAL: String(initial || ''), REELHEIST_PICK_TITLE: String(title || '') },
    });
    const out = [];
    const err = [];
    child.stdout.on('data', c => out.push(c));
    child.stderr.on('data', c => err.push(c));
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`Folder picker failed (${code}): ${Buffer.concat(err).toString('utf8').trim().slice(0, 300)}`));
        return;
      }
      const picked = Buffer.concat(out).toString('utf8').trim();
      resolve(picked || null);
    });
  }).finally(() => { pending = null; });
  return pending;
}

module.exports = { pickFolder };
