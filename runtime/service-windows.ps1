$ErrorActionPreference = 'Stop'
$taskServiceRequest = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:FACTORY_SERVICE_REQUEST)) | ConvertFrom-Json
Remove-Item Env:FACTORY_SERVICE_REQUEST

# Join the job before starting the application, so even fast-exiting launchers cannot escape ownership.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public sealed class FactoryServiceJob : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr data, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    IntPtr job;

    FactoryServiceJob() {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway.
        int size = Marshal.SizeOf(limits);
        IntPtr data = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(limits, data, false);
            if (!SetInformationJobObject(job, 9, data, (uint)size) ||
                !AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle)) {
                int error = Marshal.GetLastWin32Error();
                CloseHandle(job); job = IntPtr.Zero;
                throw new Win32Exception(error);
            }
        } finally { Marshal.FreeHGlobal(data); }
    }

    static string Quote(string argument) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in argument) {
            if (character == '\\') { slashes++; continue; }
            result.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
            result.Append(character); slashes = 0;
        }
        result.Append('\\', slashes * 2); result.Append('"');
        return result.ToString();
    }

    public static void Run(string program, string[] arguments, string directory) {
        Console.OutputEncoding = new UTF8Encoding(false);
        using (var owner = new FactoryServiceJob()) {
            var process = new Process();
            process.StartInfo = new ProcessStartInfo(program, String.Join(" ", Array.ConvertAll(arguments, Quote))) {
                WorkingDirectory = directory, UseShellExecute = false, CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden, RedirectStandardOutput = true, RedirectStandardError = true
            };
            process.OutputDataReceived += (sender, e) => { if (e.Data != null) Console.Out.WriteLine(e.Data); };
            process.ErrorDataReceived += (sender, e) => { if (e.Data != null) Console.Error.WriteLine(e.Data); };
            process.Start(); process.BeginOutputReadLine(); process.BeginErrorReadLine(); process.WaitForExit();
            Console.Error.WriteLine("Service application exited: " + process.ExitCode);
            Console.Out.Flush(); Console.Error.Flush();
        }
    }

    public void Dispose() { if (job != IntPtr.Zero) CloseHandle(job); }
}
'@
[FactoryServiceJob]::Run([string]$taskServiceRequest.program, [string[]]@($taskServiceRequest.argv), [string]$taskServiceRequest.cwd)
