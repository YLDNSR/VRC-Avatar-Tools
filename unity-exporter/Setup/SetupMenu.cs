#if !VAV_UNIVRM10
using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEditor.PackageManager;

namespace VRCAvatarTools.Exporter.Setup
{
    /// <summary>
    /// Shown only while UniVRM (com.vrmc.vrm 0.128–0.131) is missing, so the exporter assembly
    /// (which needs it) never causes compile errors in the avatar project.
    /// </summary>
    static class SetupMenu
    {
        const string DefaultTag = "v0.131.3";
        const string Repo = "https://github.com/vrm-c/UniVRM.git?path=/Packages/";

        [MenuItem("GameObject/VRC Avatar Tools/Export", false, 10)]
        static void Export(MenuCommand command) => Install();

        [MenuItem("Tools/VRC Avatar Tools/Install UniVRM (VRM 1.0)")]
        static void Install()
        {
#if VAV_UNIVRM10_ANY
            EditorUtility.DisplayDialog("VRC Avatar Tools",
                "설치된 UniVRM(com.vrmc.vrm) 버전은 지원하지 않습니다. 0.128.0 ~ 0.131.x 를 사용하세요.", "OK");
#else
            var gltf = UnityEditor.PackageManager.PackageInfo.FindForAssetPath("Packages/com.vrmc.gltf/package.json");
            var tag = DefaultTag;
            if (gltf != null)
            {
                // com.vrmc.vrm must match the installed com.vrmc.gltf exactly.
                if (!Version.TryParse(gltf.version, out var v) || v < new Version(0, 128, 0) || v >= new Version(0, 132, 0))
                {
                    EditorUtility.DisplayDialog("VRC Avatar Tools",
                        $"com.vrmc.gltf {gltf.version} 이(가) 설치되어 있습니다. 0.128.0 ~ 0.131.x 로 맞춘 뒤 다시 시도하세요.", "OK");
                    return;
                }
                tag = "v" + gltf.version;
            }
            if (!EditorUtility.DisplayDialog("VRC Avatar Tools",
                    $"내보내기에는 UniVRM {tag} (VRM 1.0)이 필요합니다. Package Manager로 GitHub에서 설치할까요?", "설치", "취소")) return;
            var add = new List<string>();
            if (gltf == null) add.Add(Repo + "UniGLTF#" + tag);
            add.Add(Repo + "VRM10#" + tag);
            Client.AddAndRemove(add.ToArray(), null);
#endif
        }
    }
}
#endif
