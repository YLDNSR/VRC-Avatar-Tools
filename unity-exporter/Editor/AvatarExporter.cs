using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using UniGLTF;
using UnityEditor;
using UniVRM10;
using UnityEngine;
using VRC.SDK3.Avatars.Components;
using Object = UnityEngine.Object;

namespace VRCAvatarTools.Exporter
{
    public sealed class ExportOptions
    {
        public string Author = "";
        public bool MakeTPose = true;
        public bool ConvertPhysBones = true;
        /// <summary>Export inactive meshes too (hidden again by the sidecar) so animations can show them.</summary>
        public bool IncludeInactive = true;
        /// <summary>Run the VRChat SDK upload preprocessing (NDMF: Modular Avatar, Avatar Optimizer, …) on the copy.</summary>
        public bool UploadBuild = true;
        /// <summary>lilToon and other non-glTF shaders → VRM MToon.</summary>
        public bool ConvertMaterials = true;
    }

    public sealed class ExportResult
    {
        public string VrmPath;
        public string SidecarPath;
        public bool Success;
        public readonly List<string> Info = new List<string>();
        public readonly List<string> Warnings = new List<string>();
    }

    /// <summary>
    /// VRChat avatar → VRM 1.0 (UniVRM) + &lt;name&gt;.vavmeta.json for VRC Avatar Tools.
    /// The source avatar is never modified: the VRM is built from a temporary copy.
    /// </summary>
    public static class AvatarExporter
    {
        public const string Version = "0.3.0";
        public const string SidecarSuffix = ".vavmeta.json";

        public static GameObject FindAvatarRoot(GameObject go)
        {
            for (var t = go != null ? go.transform : null; t != null; t = t.parent)
            {
                if (t.GetComponent<VRCAvatarDescriptor>() != null) return t.gameObject;
            }
            return null;
        }

        public static string SidecarPathFor(string vrmPath)
        {
            return Path.Combine(Path.GetDirectoryName(vrmPath) ?? "", Path.GetFileNameWithoutExtension(vrmPath) + SidecarSuffix);
        }

        public static string SafeFileName(string name)
        {
            foreach (var c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
            return name.Replace(':', '_');
        }

        public static ExportResult Export(GameObject avatar, string vrmPath, ExportOptions options)
        {
            var result = new ExportResult { VrmPath = vrmPath, SidecarPath = SidecarPathFor(vrmPath) };
            if (EditorApplication.isPlayingOrWillChangePlaymode)
                throw new InvalidOperationException("플레이 모드에서는 내보낼 수 없습니다. 애니메이터가 바꾼 상태(머티리얼·오브젝트)가 그대로 굳기 때문입니다. 플레이 모드를 끄고 다시 내보내세요. (Modular Avatar 등은 내보내기가 직접 적용합니다)");
            if (avatar.GetComponent<VRCAvatarDescriptor>() == null) throw new InvalidOperationException("VRC Avatar Descriptor가 없습니다: " + avatar.name);
            var animator = avatar.GetComponent<Animator>();
            if (animator == null || animator.avatar == null || !animator.avatar.isHuman)
                throw new InvalidOperationException("아바타 루트에 Humanoid Animator(Rig: Humanoid)가 필요합니다.");

            var temporary = new List<Object>();
            var built = false;
            // Everything happens on a temporary copy; the source avatar is never modified.
            var copy = Object.Instantiate(avatar);
            try
            {
                copy.name = avatar.name;
                copy.SetActive(true);
                copy.transform.SetPositionAndRotation(Vector3.zero, Quaternion.identity);
                if (options.UploadBuild) built = UploadBuild.Process(copy, result);
                var descriptor = copy.GetComponent<VRCAvatarDescriptor>();
                if (descriptor == null) throw new InvalidOperationException("빌드 후 VRC Avatar Descriptor가 사라졌습니다.");

                BakeRootScale(copy.transform, result);
                RemoveEditorOnly(copy, result);
                // The sidecar describes the built avatar: its playable layers, menu and the scene state
                // before inactive objects are switched on for the VRM.
                var animatorData = new AnimatorExporter(copy.transform, descriptor, result);
                animatorData.Collect();

                var materials = new MaterialConverter(temporary, result);
                if (options.ConvertMaterials) materials.ConvertRenderers(copy);
                animatorData.MaterialNames = options.ConvertMaterials || animatorData.Materials.Count > 0
                    ? materials.AddCarrier(copy, animatorData.Materials)
                    : new List<string>();
                materials.Report();

                ActivateHierarchy(copy, options.IncludeInactive, result);
                if (options.MakeTPose) MakeTPose(copy, result);
                animatorData.Baked = HumanoidBaker.Bake(copy, animatorData.HumanoidClips, result);

                var bytes = ExportVrm(copy, descriptor, options, temporary, result, animatorData.MaterialIndices);
                var sidecar = animatorData.Write(Path.GetFileName(vrmPath));
                File.WriteAllBytes(vrmPath, bytes);
                // Written right after the .vrm so the viewer's file watcher reloads both together.
                File.WriteAllText(result.SidecarPath, sidecar, new UTF8Encoding(false));
                result.Success = true;
                result.Info.Add($"VRM: {vrmPath} ({bytes.Length / 1024f / 1024f:0.0} MB)");
                result.Info.Add($"Sidecar: {result.SidecarPath} ({sidecar.Length / 1024f:0} KB)");
                return result;
            }
            finally
            {
                Object.DestroyImmediate(copy);
                foreach (var o in temporary)
                {
                    if (o != null) Object.DestroyImmediate(o);
                }
                if (built) UploadBuild.Cleanup();
            }
        }

        static byte[] ExportVrm(GameObject copy, VRCAvatarDescriptor descriptor, ExportOptions options, List<Object> temporary, ExportResult result,
            List<int> carrierMaterials)
        {
            // Vrm10Instance requires a Humanoid; add it first so its bones come from the Animator.
            var humanoid = copy.GetComponent<UniHumanoid.Humanoid>();
            if (humanoid == null) humanoid = copy.AddComponent<UniHumanoid.Humanoid>();
            if (!humanoid.AssignBonesFromAnimator())
                throw new InvalidOperationException("Animator에서 휴머노이드 본을 읽지 못했습니다.");

            var instance = copy.GetComponent<Vrm10Instance>();
            if (instance == null) instance = copy.AddComponent<Vrm10Instance>();
            var vrm = ScriptableObject.CreateInstance<VRM10Object>();
            temporary.Add(vrm);
            vrm.name = copy.name;
            vrm.Meta.Name = copy.name;
            vrm.Meta.Authors = new List<string> { string.IsNullOrWhiteSpace(options.Author) ? "Unknown" : options.Author.Trim() };
            instance.Vrm = vrm;
            instance.SpringBone = new Vrm10InstanceSpringBone();

            ExpressionBuilder.Build(copy, descriptor, copy, vrm, temporary, result);
            if (options.ConvertPhysBones) SpringBoneConverter.Convert(copy, instance, result);

            var settings = new GltfExportSettings
            {
                UseSparseAccessorForMorphTarget = true,
                ExportOnlyBlendShapePosition = true,
                DivideVertexBuffer = true,
            };
            // Same steps as Vrm10Exporter.Export, plus detaching the material carrier before writing.
            using (var arrayManager = new NativeArrayManager())
            {
                var converter = new ModelExporter();
                var model = converter.Export(settings, arrayManager, copy);
                model.ConvertCoordinate(VrmLib.Coordinates.Vrm1);
                using (var exporter = new Vrm10Exporter(settings, null, new AssetPreservingTextureSerializer()))
                {
                    exporter.Export(copy, model, converter, new VrmLib.ExportArgs(), vrm.Meta);
                    carrierMaterials.AddRange(DetachCarrier(exporter.Storage.Gltf));
                    return exporter.Storage.ToGlbBytes();
                }
            }
        }

        /// <summary>
        /// UniGLTF's EditorTextureSerializer, except that it never touches the texture assets. The original switches
        /// every exported texture's import setting to Uncompressed and reimports it (ModifyTextureAssetBeforeExporting),
        /// which leaves the project's .meta files changed and inflates VRChat's texture memory on the next upload.
        /// PNG/JPG files are still copied as they are; other textures are read from the imported (compressed) texture,
        /// as VRChat shows them.
        /// </summary>
        sealed class AssetPreservingTextureSerializer : ITextureSerializer
        {
            readonly EditorTextureSerializer _editor = new EditorTextureSerializer();

            public bool CanExportAsEditorAssetFile(Texture texture, UniGLTF.ColorSpace exportColorSpace) =>
                _editor.CanExportAsEditorAssetFile(texture, exportColorSpace);

            public (byte[] bytes, string mime) ExportBytesWithMime(Texture2D texture, UniGLTF.ColorSpace exportColorSpace) =>
                _editor.ExportBytesWithMime(texture, exportColorSpace);

            public void ModifyTextureAssetBeforeExporting(Texture texture) { }
        }

        /// <summary>
        /// Removes the "__vav_materials" node from the scene graph. Its materials stay in the file, unreferenced by
        /// visible meshes, so glTF loaders skip them until the viewer asks for one (material-swap animations).
        /// </summary>
        static List<int> DetachCarrier(glTF gltf)
        {
            var materials = new List<int>();
            var index = gltf.nodes.FindIndex(n => n.name == MaterialConverter.CarrierName);
            if (index < 0) return materials;
            var node = gltf.nodes[index];
            if (node.mesh >= 0 && node.mesh < gltf.meshes.Count)
            {
                foreach (var p in gltf.meshes[node.mesh].primitives) materials.Add(p.material ?? -1);
            }
            foreach (var scene in gltf.scenes)
            {
                if (scene.nodes != null) scene.nodes = scene.nodes.Where(n => n != index).ToArray();
            }
            foreach (var n in gltf.nodes)
            {
                if (n.children != null && n.children.Contains(index)) n.children = n.children.Where(c => c != index).ToArray();
            }
            return materials;
        }

        /// <summary>The avatar root is not a glTF node in UniVRM's output, so its scale is moved into its children.</summary>
        static void BakeRootScale(Transform root, ExportResult result)
        {
            var s = root.localScale;
            if (Mathf.Approximately(s.x, 1f) && Mathf.Approximately(s.y, 1f) && Mathf.Approximately(s.z, 1f)) return;
            if (!Mathf.Approximately(s.x, s.y) || !Mathf.Approximately(s.x, s.z))
                result.Warnings.Add($"아바타 루트 스케일이 균일하지 않습니다 ({s}). X 값만 적용합니다.");
            var k = s.x;
            foreach (Transform child in root)
            {
                child.localPosition *= k;
                child.localScale *= k;
            }
            root.localScale = Vector3.one;
            result.Info.Add($"루트 스케일 {k:0.###} 을(를) 자식에 적용");
        }

        static void RemoveEditorOnly(GameObject copy, ExportResult result)
        {
            var removed = 0;
            foreach (var t in copy.GetComponentsInChildren<Transform>(true))
            {
                // Children of an object destroyed earlier in this loop are already gone.
                if (t == null || t == copy.transform) continue;
                if (t.CompareTag("EditorOnly"))
                {
                    Object.DestroyImmediate(t.gameObject);
                    removed++;
                }
            }
            if (removed > 0) result.Info.Add($"EditorOnly 오브젝트 {removed}개 제외");
        }

        static void ActivateHierarchy(GameObject copy, bool includeInactive, ExportResult result)
        {
            var activated = 0;
            foreach (var t in copy.GetComponentsInChildren<Transform>(true))
            {
                if (!includeInactive || t.gameObject.activeSelf) continue;
                t.gameObject.SetActive(true);
                activated++;
            }
            foreach (var r in copy.GetComponentsInChildren<Renderer>(true))
            {
                var isMesh = r is SkinnedMeshRenderer || r is MeshRenderer;
                // UniVRM only exports enabled mesh renderers; particles / trails / lines are not exported.
                if (!isMesh) r.enabled = false;
                else if (includeInactive && !r.enabled) { r.enabled = true; activated++; }
            }
            if (activated > 0) result.Info.Add($"꺼진 오브젝트/렌더러 {activated}개 포함 (뷰어에서 처음엔 숨김)");
        }

        static void MakeTPose(GameObject copy, ExportResult result)
        {
            try
            {
                if (InternalTPose.TryMakePoseValid(copy)) result.Info.Add("T포즈로 맞춤");
                else result.Warnings.Add("T포즈를 자동으로 만들지 못했습니다. 아바타가 T포즈가 아니면 뷰어에서 팔 각도가 어긋날 수 있습니다.");
            }
            catch (Exception e)
            {
                result.Warnings.Add("T포즈 변환 실패: " + e.Message);
            }
        }
    }
}
