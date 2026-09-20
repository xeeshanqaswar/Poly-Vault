using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace AssetVault.EditorTools
{
    /// <summary>
    /// Background queue. Polls the Asset Vault bridge for pending import jobs
    /// while <see cref="AssetVaultSettings.AutoSync"/> is enabled and, when
    /// auto-import is enabled, imports jobs that do not need an interactive
    /// dialog (everything except .unitypackage files).
    /// </summary>
    [InitializeOnLoad]
    public static class AssetVaultQueue
    {
        private static readonly List<ImportJobDto> LastJobs = new List<ImportJobDto>();
        private static readonly HashSet<string> SeenJobs = new HashSet<string>();
        private static float _lastPolledAt;
        private static bool _requestInFlight;

        public static IReadOnlyList<ImportJobDto> Jobs => LastJobs;
        public static string LastError { get; private set; }
        public static DateTime LastPollAt { get; private set; }
        public static event Action JobsChanged;

        static AssetVaultQueue()
        {
            EditorApplication.update -= Tick;
            EditorApplication.update += Tick;
        }

        public static void PollNow()
        {
            RequestJobs(force: true);
        }

        public static void RefreshLocalList()
        {
            JobsChanged?.Invoke();
        }

        private static void Tick()
        {
            if (!AssetVaultSettings.AutoSync) return;

            float interval = AssetVaultSettings.SyncIntervalSeconds;
            float now = (float)EditorApplication.timeSinceStartup;
            if (now - _lastPolledAt < interval) return;

            RequestJobs(force: false);
        }

        private static void RequestJobs(bool force)
        {
            if (_requestInFlight && !force) return;
            if (string.IsNullOrEmpty(AssetVaultSettings.ServerUrl)) return;

            _requestInFlight = true;
            string url = $"{AssetVaultSettings.ServerUrl}/api/unity/import-jobs";
            AssetVaultWeb.GetJson(url, (ok, text) =>
            {
                _requestInFlight = false;
                _lastPolledAt = (float)EditorApplication.timeSinceStartup;
                LastPollAt = DateTime.Now;

                if (!ok)
                {
                    LastError = text;
                    JobsChanged?.Invoke();
                    return;
                }

                LastError = null;
                try
                {
                    var envelope = JsonUtility.FromJson<ImportJobsEnvelope>(text);
                    LastJobs.Clear();
                    if (envelope != null && envelope.jobs != null)
                        LastJobs.AddRange(envelope.jobs);
                }
                catch (Exception e)
                {
                    LastError = "Could not parse server response: " + e.Message;
                }

                JobsChanged?.Invoke();
                MaybeAutoImport();
            });
        }

        private static void MaybeAutoImport()
        {
            if (!AssetVaultSettings.AutoImport) return;
            if (string.IsNullOrEmpty(AssetVaultSettings.ServerUrl)) return;

            foreach (var job in LastJobs)
            {
                if (job == null || string.IsNullOrEmpty(job.id)) continue;
                if (!SeenJobs.Add(job.id)) continue; // already handled once

                bool onlyPackages = true;
                if (job.importables != null)
                {
                    foreach (var imp in job.importables)
                        if (!string.Equals(imp?.kind, "unitypackage", StringComparison.OrdinalIgnoreCase))
                            onlyPackages = false;
                }

                if (onlyPackages)
                {
                    // Needs the interactive dialog: leave it for the window.
                    continue;
                }

                AssetVaultImporter.TryImport(job, interactive: false,
                    log: msg => Debug.Log($"[Poly Vault] {msg}"),
                    finished: (msg, ok) => Debug.Log($"[Poly Vault] Job {job.assetName}: {msg}"));
            }
        }
    }
}