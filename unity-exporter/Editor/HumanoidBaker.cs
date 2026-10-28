using System;
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Animations;
using UnityEngine.Playables;

namespace VRCAvatarTools.Exporter
{
    /// <summary>
    /// Samples humanoid clips on the export copy with Unity's own retargeting (PlayableGraph) and stores
    /// three-vrm normalized bone rotations, so the viewer plays them exactly like Unity does on this avatar.
    /// Must run after the copy is in its export rest pose (T-pose): rotations are relative to that pose.
    ///   normalized = parentWorldRest · local · restLocal⁻¹ · parentWorldRest⁻¹, then (x, -y, -z, w) for glTF.
    /// Only bones the clip animates are stored (a hand-pose clip stores fingers only).
    /// </summary>
    internal static class HumanoidBaker
    {
        public const int Rate = 30;

        public sealed class Baked
        {
            public int Rate, Frames;
            public string[] Bones;
            /// <summary>Frames × bones × (x, y, z, w), glTF space.</summary>
            public float[] Rotations;
            /// <summary>Frames × (x, y, z): hips position relative to the avatar root, glTF space (null without root motion curves).</summary>
            public float[] Hips;
        }

        static Dictionary<string, int> _muscles;

        /// <summary>Clip attribute ("LeftHand.Index.1 Stretched", "Spine Front-Back") → muscle index.</summary>
        static int MuscleIndex(string attribute)
        {
            if (_muscles == null)
            {
                _muscles = new Dictionary<string, int>();
                for (var i = 0; i < HumanTrait.MuscleCount; i++) _muscles[HumanTrait.MuscleName[i]] = i;
            }
            var name = attribute;
            if (name.StartsWith("LeftHand.", StringComparison.Ordinal)) name = "Left " + name.Substring(9).Replace('.', ' ');
            else if (name.StartsWith("RightHand.", StringComparison.Ordinal)) name = "Right " + name.Substring(10).Replace('.', ' ');
            return _muscles.TryGetValue(name, out var index) ? index : -1;
        }

        /// <summary>VRM 1.0 bone name (UniVRM maps Unity's thumb Proximal/Intermediate to VRM Metacarpal/Proximal).</summary>
        public static string VrmName(HumanBodyBones bone)
        {
            var name = bone.ToString();
            if (name.EndsWith("ThumbProximal", StringComparison.Ordinal)) name = name.Replace("ThumbProximal", "ThumbMetacarpal");
            else if (name.EndsWith("ThumbIntermediate", StringComparison.Ordinal)) name = name.Replace("ThumbIntermediate", "ThumbProximal");
            return char.ToLowerInvariant(name[0]) + name.Substring(1);
        }

        static HashSet<HumanBodyBones> AnimatedBones(AnimationClip clip, out bool body)
        {
            body = false;
            var bones = new HashSet<HumanBodyBones>();
            foreach (var b in AnimationUtility.GetCurveBindings(clip))
            {
                if (b.type != typeof(Animator)) continue;
                var name = b.propertyName;
                if (name.StartsWith("RootT.", StringComparison.Ordinal) || name.StartsWith("RootQ.", StringComparison.Ordinal)) { body = true; continue; }
                var muscle = MuscleIndex(name);
                if (muscle < 0) continue;
                var bone = HumanTrait.BoneFromMuscle(muscle);
                if (bone >= 0) bones.Add((HumanBodyBones)bone);
            }
            if (body) bones.Add(HumanBodyBones.Hips);
            return bones;
        }

        public static Dictionary<AnimationClip, Baked> Bake(GameObject root, ICollection<AnimationClip> clips, ExportResult result)
        {
            var output = new Dictionary<AnimationClip, Baked>();
            var animator = root.GetComponent<Animator>();
            if (clips.Count == 0 || animator == null || animator.avatar == null || !animator.avatar.isHuman) return output;

            var transforms = root.GetComponentsInChildren<Transform>(true);
            var saved = transforms.Select(t => (t, t.localPosition, t.localRotation, t.localScale)).ToArray();
            var bones = new List<(HumanBodyBones Id, Transform T, Quaternion RestLocal, Quaternion ParentWorld)>();
            for (var b = HumanBodyBones.Hips; b < HumanBodyBones.LastBone; b++)
            {
                var t = animator.GetBoneTransform(b);
                if (t != null) bones.Add((b, t, t.localRotation, t.parent != null ? t.parent.rotation : Quaternion.identity));
            }
            var hips = animator.GetBoneTransform(HumanBodyBones.Hips);

            var controller = animator.runtimeAnimatorController;
            var applyRootMotion = animator.applyRootMotion;
            var enabled = animator.enabled;
            var culling = animator.cullingMode;
            animator.runtimeAnimatorController = null;
            animator.applyRootMotion = false;
            animator.enabled = true;
            // VRChat avatars use "Cull Update Transforms"; nothing is on screen here, so it would skip every sample.
            animator.cullingMode = AnimatorCullingMode.AlwaysAnimate;
            // The build (Avatar Optimizer merging bones, EditorOnly removal) and switching objects on
            // invalidate the Animator's transform bindings; without a rebind the samples are never written.
            animator.Rebind();
            var graph = PlayableGraph.Create("VRC Avatar Tools bake");
            graph.SetTimeUpdateMode(DirectorUpdateMode.Manual);
            var playableOutput = AnimationPlayableOutput.Create(graph, "pose", animator);
            try
            {
                foreach (var clip in clips)
                {
                    var animated = AnimatedBones(clip, out var body);
                    var list = bones.Where(b => animated.Contains(b.Id)).ToList();
                    if (list.Count == 0) continue;
                    var playable = AnimationClipPlayable.Create(graph, clip);
                    playable.SetApplyFootIK(false);
                    playable.SetApplyPlayableIK(false);
                    playableOutput.SetSourcePlayable(playable);
                    graph.Play();

                    var frames = clip.length > 0f ? Mathf.CeilToInt(clip.length * Rate - 0.001f) + 1 : 1;
                    var rotations = new float[frames * list.Count * 4];
                    var hipsPositions = body && hips != null ? new float[frames * 3] : null;
                    for (var f = 0; f < frames; f++)
                    {
                        playable.SetTime(Mathf.Min(clip.length, f / (float)Rate));
                        graph.Evaluate();
                        for (var i = 0; i < list.Count; i++)
                        {
                            var (_, t, restLocal, parentWorld) = list[i];
                            var q = parentWorld * t.localRotation * Quaternion.Inverse(restLocal) * Quaternion.Inverse(parentWorld);
                            var o = (f * list.Count + i) * 4;
                            rotations[o] = q.x;
                            rotations[o + 1] = -q.y;
                            rotations[o + 2] = -q.z;
                            rotations[o + 3] = q.w;
                        }
                        if (hipsPositions != null)
                        {
                            var p = root.transform.InverseTransformPoint(hips.position);
                            hipsPositions[f * 3] = -p.x;
                            hipsPositions[f * 3 + 1] = p.y;
                            hipsPositions[f * 3 + 2] = p.z;
                        }
                    }
                    playable.Destroy();
                    output[clip] = new Baked
                    {
                        Rate = Rate,
                        Frames = frames,
                        Bones = list.Select(b => VrmName(b.Id)).ToArray(),
                        Rotations = rotations,
                        Hips = hipsPositions,
                    };
                    Restore(saved);
                }
            }
            catch (Exception e)
            {
                result.Warnings.Add("휴머노이드 애니메이션 굽기 실패: " + e.Message);
                Debug.LogException(e);
            }
            finally
            {
                graph.Destroy();
                animator.runtimeAnimatorController = controller;
                animator.applyRootMotion = applyRootMotion;
                animator.enabled = enabled;
                animator.cullingMode = culling;
                Restore(saved);
            }
            return output;
        }

        static void Restore((Transform T, Vector3 P, Quaternion R, Vector3 S)[] saved)
        {
            foreach (var (t, p, r, s) in saved)
            {
                if (t == null) continue;
                t.localPosition = p;
                t.localRotation = r;
                t.localScale = s;
            }
        }
    }
}
