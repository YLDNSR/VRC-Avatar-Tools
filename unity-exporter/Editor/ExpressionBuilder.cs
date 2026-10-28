using System;
using System.Collections.Generic;
using UniVRM10;
using UnityEngine;
using VRC.SDK3.Avatars.Components;
using Object = UnityEngine.Object;

namespace VRCAvatarTools.Exporter
{
    /// <summary>VRChat visemes / eyelids → VRM 1.0 expressions (aa ih ou ee oh, blink, blinkLeft, blinkRight).</summary>
    internal static class ExpressionBuilder
    {
        // Index into VRC_AvatarDescriptor.VisemeBlendShapes: sil PP FF TH DD kk CH SS nn RR aa E ih oh ou
        static readonly (ExpressionPreset Preset, int Viseme, string[] Names)[] Visemes =
        {
            (ExpressionPreset.aa, 10, new[] { "vrc.v_aa", "v_aa" }),
            (ExpressionPreset.ee, 11, new[] { "vrc.v_e", "v_e" }),
            (ExpressionPreset.ih, 12, new[] { "vrc.v_ih", "v_ih" }),
            (ExpressionPreset.oh, 13, new[] { "vrc.v_oh", "v_oh" }),
            (ExpressionPreset.ou, 14, new[] { "vrc.v_ou", "v_ou" }),
        };

        static readonly string[] BlinkNames = { "vrc.blink", "blink", "blink_both", "eye_close", "eyes_closed", "まばたき" };
        static readonly string[] BlinkLeftNames = { "vrc.blink_left", "blink_l", "blink_left", "blinkleft", "eye_close_l", "eyeblinkleft", "wink_l", "ウィンク" };
        static readonly string[] BlinkRightNames = { "vrc.blink_right", "blink_r", "blink_right", "blinkright", "eye_close_r", "eyeblinkright", "wink_r", "ウィンク右" };

        public static void Build(GameObject avatar, VRCAvatarDescriptor d, GameObject copy, VRM10Object vrm, List<Object> temporary, ExportResult result)
        {
            var face = d.VisemeSkinnedMesh;
            var visemes = d.lipSync == VRC.SDKBase.VRC_AvatarDescriptor.LipSyncStyle.VisemeBlendShape ? d.VisemeBlendShapes : null;
            foreach (var (preset, viseme, names) in Visemes)
            {
                var shape = visemes != null && viseme < visemes.Length ? visemes[viseme] : null;
                var mesh = face;
                if (ShapeIndex(mesh, shape) < 0)
                {
                    (mesh, shape) = FindShape(avatar, face, names);
                }
                Add(vrm, preset, avatar, copy, mesh, shape, temporary, result);
            }

            var eye = d.customEyeLookSettings;
            SkinnedMeshRenderer lids = null;
            string blink = null;
            if (eye.eyelidType == VRCAvatarDescriptor.EyelidType.Blendshapes && eye.eyelidsSkinnedMesh != null
                && eye.eyelidsSkinnedMesh.sharedMesh != null && eye.eyelidsBlendshapes != null && eye.eyelidsBlendshapes.Length > 0
                && eye.eyelidsBlendshapes[0] >= 0 && eye.eyelidsBlendshapes[0] < eye.eyelidsSkinnedMesh.sharedMesh.blendShapeCount)
            {
                lids = eye.eyelidsSkinnedMesh;
                blink = lids.sharedMesh.GetBlendShapeName(eye.eyelidsBlendshapes[0]);
            }
            var prefer = lids != null ? lids : face;
            if (blink == null)
            {
                (lids, blink) = FindShape(avatar, prefer, BlinkNames);
            }
            Add(vrm, ExpressionPreset.blink, avatar, copy, lids, blink, temporary, result);
            var (leftMesh, left) = FindShape(avatar, prefer, BlinkLeftNames);
            Add(vrm, ExpressionPreset.blinkLeft, avatar, copy, leftMesh, left, temporary, result);
            var (rightMesh, right) = FindShape(avatar, prefer, BlinkRightNames);
            Add(vrm, ExpressionPreset.blinkRight, avatar, copy, rightMesh, right, temporary, result);
        }

        static int ShapeIndex(SkinnedMeshRenderer smr, string shape)
        {
            return smr != null && smr.sharedMesh != null && !string.IsNullOrEmpty(shape) ? smr.sharedMesh.GetBlendShapeIndex(shape) : -1;
        }

        /// <summary>Case-insensitive search, preferred mesh first, then every skinned mesh of the avatar.</summary>
        static (SkinnedMeshRenderer, string) FindShape(GameObject avatar, SkinnedMeshRenderer prefer, string[] names)
        {
            var meshes = new List<SkinnedMeshRenderer>();
            if (prefer != null) meshes.Add(prefer);
            foreach (var smr in avatar.GetComponentsInChildren<SkinnedMeshRenderer>(true))
            {
                if (smr != prefer) meshes.Add(smr);
            }
            foreach (var name in names)
            {
                foreach (var smr in meshes)
                {
                    var mesh = smr.sharedMesh;
                    if (mesh == null) continue;
                    for (var i = 0; i < mesh.blendShapeCount; i++)
                    {
                        var shape = mesh.GetBlendShapeName(i);
                        if (string.Equals(shape, name, StringComparison.OrdinalIgnoreCase)) return (smr, shape);
                    }
                }
            }
            return (null, null);
        }

        static void Add(VRM10Object vrm, ExpressionPreset preset, GameObject avatar, GameObject copy, SkinnedMeshRenderer smr, string shape,
            List<Object> temporary, ExportResult result)
        {
            var index = ShapeIndex(smr, shape);
            if (index < 0) return;
            var path = PathUtil.Relative(smr.transform, avatar.transform);
            // UniVRM resolves the binding against the copy and throws if the path is missing.
            var target = PathUtil.Find(copy.transform, path);
            if (target == null || target.GetComponent<SkinnedMeshRenderer>() == null)
            {
                result.Warnings.Add($"표정 {preset}: {path} 를 내보낼 메시에서 찾지 못했습니다 (EditorOnly?)");
                return;
            }
            var expression = ScriptableObject.CreateInstance<VRM10Expression>();
            temporary.Add(expression);
            expression.name = preset.ToString();
            expression.MorphTargetBindings = new[] { new MorphTargetBinding(path, index, 1.0f) };
            vrm.Expression.AddClip(preset, expression);
            result.Info.Add($"표정 {preset} ← {path} / {shape}");
        }
    }
}
