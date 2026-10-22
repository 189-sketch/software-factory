param([switch]$CompileOnly)
$ErrorActionPreference = 'Stop'
if (-not $CompileOnly) {
    $taskServiceRequest = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:FACTORY_SERVICE_REQUEST)) | ConvertFrom-Json
    Remove-Item Env:FACTORY_SERVICE_REQUEST
}

# Join the job before starting the application, so even fast-exiting launchers cannot escape ownership.
$taskJobSource = @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

public sealed class FactoryServiceJob : IDisposable {
    public static void Main(string[] arguments) {
        var argv = new string[arguments.Length - 1];
        Array.Copy(arguments, 1, argv, 0, argv.Length);
        Run(arguments[0], argv, Environment.CurrentDirectory, true);
    }
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
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr data, uint length, out uint returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint id);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, uint exitCode);
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

    void StopDescendants() {
        int size = 1024;
        while (true) {
            IntPtr data = Marshal.AllocHGlobal(size);
            try {
                uint returned;
                if (!QueryInformationJobObject(job, 3, data, (uint)size, out returned)) {
                    int error = Marshal.GetLastWin32Error();
                    if (error == 234) { size *= 2; continue; }
                    throw new Win32Exception(error);
                }
                int count = Marshal.ReadInt32(data, 4);
                if (count <= 1) return;
                for (int i = 0; i < count; i++) {
                    uint id = unchecked((uint)Marshal.ReadIntPtr(data, 8 + i * IntPtr.Size).ToInt64());
                    if (id == (uint)Process.GetCurrentProcess().Id) continue;
                    IntPtr process = OpenProcess(1 | 0x1000, false, id);
                    if (process == IntPtr.Zero) continue;
                    try {
                        bool member;
                        // Recheck membership on the opened handle so a reused PID cannot kill an unrelated process.
                        if (IsProcessInJob(process, job, out member) && member) TerminateProcess(process, 1);
                    } finally { CloseHandle(process); }
                }
            } finally { Marshal.FreeHGlobal(data); }
        }
    }

    public static void Run(string program, string[] arguments, string directory, bool finite) {
        Console.OutputEncoding = new UTF8Encoding(false);
        using (var owner = new FactoryServiceJob()) {
            var process = new Process();
            process.StartInfo = new ProcessStartInfo(program, String.Join(" ", Array.ConvertAll(arguments, Quote))) {
                WorkingDirectory = directory, UseShellExecute = false, CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden, RedirectStandardOutput = true, RedirectStandardError = true
            };
            process.Start();
            var stdout = process.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
            var stderr = process.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
            process.WaitForExit(Int32.MaxValue);
            if (finite) {
                // Descendants may have inherited the output pipes; end them before draining those pipes.
                owner.StopDescendants();
                Task.WaitAll(stdout, stderr);
                // Preserve the actual command status. OS handle closure then kills every job descendant.
                Environment.Exit(process.ExitCode);
            }
            Task.WaitAll(stdout, stderr);
            Console.Error.WriteLine("Service application exited: " + process.ExitCode);
            Console.Out.Flush(); Console.Error.Flush();
        }
    }

    public void Dispose() { if (job != IntPtr.Zero) CloseHandle(job); }
}
'@
$taskJobHash = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($taskJobSource))).Replace('-', '').ToLowerInvariant()
$taskJobDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'software-factory/runtime'
[IO.Directory]::CreateDirectory($taskJobDirectory) | Out-Null
$taskJobAssembly = Join-Path $taskJobDirectory "$taskJobHash.exe"
if (-not [IO.File]::Exists($taskJobAssembly)) {
    $taskJobTemporary = Join-Path $taskJobDirectory "$taskJobHash.$PID.$([Guid]::NewGuid().ToString('N')).exe"
    try {
        Add-Type -TypeDefinition $taskJobSource -OutputAssembly $taskJobTemporary -OutputType ConsoleApplication
        try { [IO.File]::Move($taskJobTemporary, $taskJobAssembly) }
        catch { if (-not [IO.File]::Exists($taskJobAssembly)) { throw } }
    } finally {
        if ([IO.File]::Exists($taskJobTemporary)) { [IO.File]::Delete($taskJobTemporary) }
    }
}
if ($CompileOnly) { Write-Output $taskJobAssembly; exit 0 }
[Reflection.Assembly]::LoadFrom($taskJobAssembly) | Out-Null
[FactoryServiceJob]::Run([string]$taskServiceRequest.program, [string[]]@($taskServiceRequest.argv), [string]$taskServiceRequest.cwd, [bool]$taskServiceRequest.finite)
