using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace AssetVault.EditorTools
{
    /// <summary>
    /// Imports a completed ImportJobDto into the current project's Assets folder.
    /// .unitypackage files are opened through Unity's own import dialog; all other
    /// importable files are copied under Assets/PolyVaultImports/...
    /// </summary>
    [InitializeOnLoad]
    public static class AssetVaultImporter
    {
        public const string ImportRoot = "Assets/PolyVaultImports";

        private static readonly HashSet<string> InFlight = new HashSet<string>();
        private static readonly HashSet<string> ReportedDone = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private static readonly Dictionary<string, ImportJobDto> PendingPackageJobs =
            new Dictionary<string, ImportJobDto>(StringComparer.OrdinalIgnoreCase);
        private static readonly Dictionary<string, ImportJobDto> KnownPackageJobs =
            new Dictionary<string, ImportJobDto>(StringComparer.OrdinalIgnoreCase);

        static AssetVaultImporter()
        {
            AssetDatabase.importPackageCompleted += OnPackageImportCompleted;
            AssetDatabase.importPackageCancelled += OnPackageImportCancelled;
            AssetDatabase.importPackageFailed += OnPackageImportFailed;
        }

        public static bool IsInFlight(string jobId) => !string.IsNullOrEmpty(jobId) && InFlight.Contains(jobId);

        public static void CancelInFlight(string jobId)
        {
            if (string.IsNullOrEmpty(jobId)) return;
            InFlight.Remove(jobId);
            ReportedDone.Remove(jobId);
            RemoveJobFromPendingByKey(PendingPackageJobs, jobId);
            RemoveJobFromPendingByKey(KnownPackageJobs, jobId);
        }

        private static void RegisterPendingPackage(ImportableDto item, ImportJobDto job)
        {
            if (item == null || job == null) return;
            string key1 = Path.GetFileNameWithoutExtension(item.path);
            if (!string.IsNullOrEmpty(key1))
            {
                PendingPackageJobs[key1] = job;
                KnownPackageJobs[key1] = job;
            }
            if (!string.IsNullOrEmpty(item.name))
            {
                PendingPackageJobs[item.name] = job;
                KnownPackageJobs[item.name] = job;
                string key2 = Path.GetFileNameWithoutExtension(item.name);
                if (!string.IsNullOrEmpty(key2))
                {
                    PendingPackageJobs[key2] = job;
                    KnownPackageJobs[key2] = job;
                }
            }
        }

        private static bool TryGetPackageJob(string packageName, out ImportJobDto job)
        {
            job = null;
            if (string.IsNullOrEmpty(packageName) || KnownPackageJobs.Count == 0) return false;
            if (KnownPackageJobs.TryGetValue(packageName, out job)) return true;
            string clean = Path.GetFileNameWithoutExtension(packageName);
            return !string.IsNullOrEmpty(clean) && KnownPackageJobs.TryGetValue(clean, out job);
        }

        private static void RemoveJobFromPendingByKey(Dictionary<string, ImportJobDto> map, string jobId)
        {
            var keys = new List<string>();
            foreach (var kvp in map)
            {
                if (kvp.Value != null && kvp.Value.id == jobId) keys.Add(kvp.Key);
            }
            foreach (var k in keys) map.Remove(k);
        }

        private static void FinishPackageJob(ImportJobDto job)
        {
            if (job == null) return;
            RemoveJobFromPendingByKey(PendingPackageJobs, job.id);
            InFlight.Remove(job.id);
        }

        private static void OnPackageImportCompleted(string packageName)
        {
            if (TryGetPackageJob(packageName, out var job))
            {
                if (ReportedDone.Contains(job.id)) return;
                ReportedDone.Add(job.id);
                Debug.Log($"[Poly Vault] Package '{packageName}' imported successfully.");
                ReportJobResult(job, true, $"Imported package {packageName}.");
                FinishPackageJob(job);
                AssetVaultQueue.PollNow();
            }
            else Debug.LogWarning($"[Poly Vault] Unity reported '{packageName}' complete, but no Poly Vault import is waiting for it.");
        }

        private static void OnPackageImportCancelled(string packageName)
        {
            if (TryGetPackageJob(packageName, out var job))
            {
                ReportedDone.Remove(job.id);
                Debug.LogWarning($"[Poly Vault] Package '{packageName}' import was cancelled in Unity.");
                ReportJobResult(job, false, $"Package '{packageName}' import cancelled in Unity.");
                FinishPackageJob(job);
                AssetVaultQueue.PollNow();
            }
        }

        private static void OnPackageImportFailed(string packageName, string errorMessage)
        {
            if (TryGetPackageJob(packageName, out var job))
            {
                ReportedDone.Remove(job.id);
                Debug.LogError($"[Poly Vault] Package '{packageName}' import failed: {errorMessage}");
                ReportJobResult(job, false, $"Package '{packageName}' import failed: {errorMessage}");
                FinishPackageJob(job);
                AssetVaultQueue.PollNow();
            }
        }

        private static string Sanitize(string name)
        {
            if (string.IsNullOrEmpty(name)) return "unknown";
            char[] invalid = Path.GetInvalidFileNameChars();
            char[] trimmed = new char[name.Length];
            for (int i = 0; i < name.Length; i++)
            {
                trimmed[i] = Array.IndexOf(invalid, name[i]) >= 0 ? '_' : name[i];
            }
            string result = new string(trimmed).Trim(' ', '.');
            return result.Length == 0 ? "unknown" : result;
        }

        private static string UniqueFile(string dest)
        {
            if (!File.Exists(dest)) return dest;

            string dir = Path.GetDirectoryName(dest);
            string filename = Path.GetFileNameWithoutExtension(dest);
            string ext = Path.GetExtension(dest);
            for (int i = 1; i < 1000; i++)
            {
                string candidate = Path.Combine(dir, $"{filename} ({i}){ext}");
                if (!File.Exists(candidate)) return candidate;
            }
            return dest;
        }

        private static string DestinationFor(ImportJobDto job, ImportableDto item)
        {
            string folder =
                Path.Combine(ImportRoot.Replace('/', Path.DirectorySeparatorChar),
                    Sanitize(job.libraryName),
                    Sanitize(job.category),
                    Sanitize(job.assetName));

            string rel = string.IsNullOrEmpty(item.rel)
                ? item.name
                : item.rel.Replace('/', Path.DirectorySeparatorChar);

            // Guard against nav-out via malicious rel paths.
            string combined = Path.GetFullPath(Path.Combine(folder, rel));
            string root = Path.GetFullPath(folder);
            if (!combined.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                combined = Path.Combine(folder, item.name);

            return combined;
        }

        /// <returns>true if the job was accepted (started or completed).</returns>
        public static bool TryImport(ImportJobDto job, bool interactive, Action<string> log, Action<string, bool> finished)
        {
            if (job == null || string.IsNullOrEmpty(job.id))
            {
                finished?.Invoke("Job has no id", false);
                return false;
            }
            if (IsInFlight(job.id))
            {
                log?.Invoke($"Job {job.assetName} is already being imported.");
                return false;
            }

            InFlight.Add(job.id);
            ReportedDone.Remove(job.id);
            try
            {
                int imported = 0;
                int skippedPackages = 0;
                int failedItems = 0;
                bool hasInteractivePackage = false;

                string destAssetRoot = Path.Combine(
                    ImportRoot.Replace('/', Path.DirectorySeparatorChar),
                    Sanitize(job.libraryName),
                    Sanitize(job.category),
                    Sanitize(job.assetName));

                foreach (var item in job.importables)
                {
                    if (item == null) continue;

                    if (string.Equals(item.kind, "unitypackage", StringComparison.OrdinalIgnoreCase))
                    {
                        if (File.Exists(item.path))
                        {
                            if (interactive)
                            {
                                hasInteractivePackage = true;
                                RegisterPendingPackage(item, job);
                                ReportJobStatus(job, "processing", $"Importing package {item.name} in Unity...");

                                // Opens Unity's package import dialog.
                                AssetDatabase.ImportPackage(item.path, true);
                                log?.Invoke($"Opened package import for {item.name}");
                                imported++;
                            }
                            else
                            {
                                skippedPackages++;
                                log?.Invoke($"Skipped {item.name} (unitypackage needs manual import from the window).");
                            }
                        }
                        else
                        {
                            failedItems++;
                            log?.Invoke($"Missing file: {item.path}");
                        }
                        continue;
                    }

                    if (!File.Exists(item.path))
                    {
                        failedItems++;
                        log?.Invoke($"Missing file: {item.path}");
                        continue;
                    }

                    string dest = UniqueFile(DestinationFor(job, item));
                    string destDir = Path.GetDirectoryName(dest);
                    if (!Directory.Exists(destDir)) Directory.CreateDirectory(destDir);

                    try
                    {
                        File.Copy(item.path, dest, overwrite: false);
                        imported++;
                        log?.Invoke($"Copied {item.name} -> {dest.Replace(Path.DirectorySeparatorChar, '/')}");
                    }
                    catch (Exception e)
                    {
                        failedItems++;
                        log?.Invoke($"Copy failed for {item.name}: {e.Message}");
                    }
                }

                AssetDatabase.Refresh();
                WriteTagsFile(destAssetRoot, job.tags);

                if (hasInteractivePackage)
                {
                    finished?.Invoke($"Opened package import dialog for {job.assetName}.", true);
                    return true;
                }

                if (imported == 0 && skippedPackages > 0)
                {
                    finished?.Invoke("Only unitypackage files pending manual import.", false);
                    InFlight.Remove(job.id);
                    return true;
                }

                InFlight.Remove(job.id);
                if (imported == 0 || failedItems > 0)
                {
                    string msg = imported == 0
                        ? "Nothing was imported: no source files were found or all copies failed."
                        : $"Imported {imported} file(s), but {failedItems} failed.";
                    ReportJobResult(job, false, msg);
                    finished?.Invoke(msg, false);
                    return true;
                }

                ReportJobResult(job, true, $"Imported {imported} file(s).");
                finished?.Invoke($"Imported {imported} file(s).", true);
                return true;
            }
            catch (Exception e)
            {
                InFlight.Remove(job.id);
                string msg = e.Message;
                log?.Invoke($"Import failed: {msg}");
                ReportJobResult(job, false, msg);
                finished?.Invoke($"Import failed: {msg}", false);
                return true;
            }
        }

        /// <summary>
        /// Writes the source tags next to the imported asset so the information
        /// survives inside the project (Assets/.../polyvault.tags.json).
        /// </summary>
        private static void WriteTagsFile(string destAssetRoot, List<string> tags)
        {
            if (tags == null || tags.Count == 0) return;
            try
            {
                if (!Directory.Exists(destAssetRoot)) return;
                var sb = new System.Text.StringBuilder("{\"tags\":[");
                for (int i = 0; i < tags.Count; i++)
                {
                    if (i > 0) sb.Append(",");
                    sb.Append(JsonString(tags[i]));
                }
                sb.Append("]}");
                File.WriteAllText(Path.Combine(destAssetRoot, "polyvault.tags.json"), sb.ToString());
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[Poly Vault] Could not write tags file: {e.Message}");
            }
        }

        private static string JsonString(string s)
        {
            if (string.IsNullOrEmpty(s)) return "\"\"";
            return "\"" + s.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }

        public static void ReportJobStatus(ImportJobDto job, string status, string note)
        {
            if (job == null || string.IsNullOrEmpty(job.id)) return;
            string url = $"{AssetVaultSettings.ServerUrl}/api/unity/import-jobs/{job.id}/{status}";
            string body = "{\"note\":" + JsonUtility.ToJson(note) + "}";
            AssetVaultWeb.PostJson(url, body, (ok, text) =>
            {
                if (!ok) Debug.LogWarning($"[Poly Vault] Failed to report job status to server: {text}");
            });
        }

        /// <summary>
        /// Reports a job as imported or failed back to the Poly Vault server so
        /// it leaves the pending queue. Best effort; async.
        /// </summary>
        public static void ReportJobResult(ImportJobDto job, bool success, string note)
        {
            ReportJobStatus(job, success ? "complete" : "failed", note);
        }
    }
}