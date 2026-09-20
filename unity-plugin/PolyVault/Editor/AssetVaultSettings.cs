using UnityEngine;
using UnityEditor;

namespace AssetVault.EditorTools
{
    /// <summary>
    /// Editor-pref backed settings for the Asset Vault bridge.
    /// </summary>
    public static class AssetVaultSettings
    {
        private const string UrlPref = "AssetVault.ServerUrl";
        private const string AutoSyncPref = "AssetVault.AutoSync";
        private const string AutoImportPref = "AssetVault.AutoImport";
        private const string IntervalPref = "AssetVault.SyncIntervalSec";

        public const string DefaultUrl = "http://127.0.0.1:7100";

        public static string ServerUrl
        {
            get => EditorPrefs.GetString(UrlPref, DefaultUrl);
            set => EditorPrefs.SetString(UrlPref, value);
        }

        public static bool AutoSync
        {
            get => EditorPrefs.GetBool(AutoSyncPref, true);
            set => EditorPrefs.SetBool(AutoSyncPref, value);
        }

        public static bool AutoImport
        {
            get => EditorPrefs.GetBool(AutoImportPref, true);
            set => EditorPrefs.SetBool(AutoImportPref, value);
        }

        public static float SyncIntervalSeconds
        {
            get => Mathf.Clamp(EditorPrefs.GetFloat(IntervalPref, 10f), 2f, 120f);
            set => EditorPrefs.SetFloat(IntervalPref, value);
        }
    }
}