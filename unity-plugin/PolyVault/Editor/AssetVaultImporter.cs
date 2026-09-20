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
    public static class AssetVaultImporter
    {
        public const string ImportRoot = "Assets/PolyVaultImports";

        private static readonly HashSet<string> InFlight = new HashSet<string>();

        private static bool IsInFlight(string jobId) => InFlight.Contains(jobId);

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
            try
            {
                int imported = 0;
                int skippedPackages = 0;

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
                            log?.Invoke($"Missing file: {item.path}");
                        }
                        continue;
                    }

                    if (!File.Exists(item.path))
                    {
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
                        log?.Invoke($"Copy failed for {item.name}: {e.Message}");
                    }
                }

                AssetDatabase.Refresh();
                WriteTagsFile(destAssetRoot, job.tags);

                if (imported == 0 && skippedPackages > 0)
                {
                    finished?.Invoke("Only unitypackage files pending manual import.", false);
                    return true;
                }

                ReportJobResult(job, true, $"Imported {imported} file(s).");
                finished?.Invoke($"Imported {imported} file(s).", true);
                return true;
            }
            catch (Exception e)
            {
                string msg = e.Message;
                log?.Invoke($"Import failed: {msg}");
                ReportJobResult(job, false, msg);
                finished?.Invoke($"Import failed: {msg}", false);
                return true;
            }
            finally
            {
                InFlight.Remove(job.id);
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

        /// <summary>
        /// Reports a job as imported or failed back to the Poly Vault server so
        /// it leaves the pending queue. Best effort; async.
        /// </summary>
        public static void ReportJobResult(ImportJobDto job, bool success, string note)
        {
            string url = $"{AssetVaultSettings.ServerUrl}/api/unity/import-jobs/{job.id}/{(success ? "complete" : "failed")}";
            string body = "{\"note\":" + JsonUtility.ToJson(note) + "}";
            AssetVaultWeb.PostJson(url, body, (ok, text) =>
            {
                if (!ok) Debug.LogWarning($"[Poly Vault] Failed to report job result to server: {text}");
            });
        }
    }
}