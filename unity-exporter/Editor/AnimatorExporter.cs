using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;
using VRC.SDK3.Avatars.Components;
using VRC.SDK3.Avatars.ScriptableObjects;
using Object = UnityEngine.Object;

namespace VRCAvatarTools.Exporter
{
    /// <summary>
    /// Writes &lt;name&gt;.vavmeta.json version 2: Expression Parameters / Menu (with icons) and the avatar's
    /// Gesture, Action and FX playable layers as state machines (transitions, blend trees, State Behaviours)
    /// with every clip they use, so the viewer can run them like VRChat does. Format: docs/vavmeta.md.
    /// Collect() runs on the built copy before inactive objects are switched on for the VRM export (it
    /// records the scene defaults); Write() runs after materials were converted and humanoid clips baked.
    /// </summary>
    internal sealed class AnimatorExporter
    {
        public const int FormatVersion = 2;

        static readonly VRCAvatarDescriptor.AnimLayerType[] PlayableTypes =
        {
            VRCAvatarDescriptor.AnimLayerType.Gesture,
            VRCAvatarDescriptor.AnimLayerType.Action,
            VRCAvatarDescriptor.AnimLayerType.FX,
        };

        sealed class Playable
        {
            public string Type;
            public AnimatorController Controller;
            public AnimatorOverrideController Overrides;
        }

        readonly Transform _root;
        readonly VRCAvatarDescriptor _descriptor;
        readonly ExportResult _result;
        readonly List<Playable> _playables = new List<Playable>();
        readonly HashSet<string> _parameterNames = new HashSet<string>();

        public readonly List<AnimationClip> Clips = new List<AnimationClip>();
        readonly Dictionary<AnimationClip, int> _clipIndex = new Dictionary<AnimationClip, int>();
        /// <summary>Materials referenced by material-swap curves; the exporter puts them in the VRM (carrier mesh).</summary>
        public readonly List<Material> Materials = new List<Material>();
        readonly Dictionary<Material, int> _materialIndex = new Dictionary<Material, int>();
        /// <summary>Humanoid clips of the Action / Gesture layers, baked per avatar by HumanoidBaker.</summary>
        public readonly HashSet<AnimationClip> HumanoidClips = new HashSet<AnimationClip>();
        public Dictionary<AnimationClip, HumanoidBaker.Baked> Baked = new Dictionary<AnimationClip, HumanoidBaker.Baked>();
        /// <summary>Names of the converted materials, in the carrier mesh's slot order.</summary>
        public List<string> MaterialNames = new List<string>();
        /// <summary>glTF material index of each carrier slot (filled by the VRM export).</summary>
        public readonly List<int> MaterialIndices = new List<int>();

        readonly List<string> _inactive = new List<string>();
        readonly List<string> _disabledRenderers = new List<string>();
        readonly List<(string Path, string Shape, float Weight)> _shapes = new List<(string, string, float)>();
        readonly List<string> _icons = new List<string>();
        readonly Dictionary<Texture, int> _iconIndex = new Dictionary<Texture, int>();
        int _ignoredCurves, _ignoredBehaviours, _materialCurves;

        public AnimatorExporter(Transform root, VRCAvatarDescriptor descriptor, ExportResult result)
        {
            _root = root;
            _descriptor = descriptor;
            _result = result;
        }

        // ------------------------------------------------------------------ collect

        public void Collect()
        {
            if (_descriptor.customizeAnimationLayers && _descriptor.baseAnimationLayers != null)
            {
                foreach (var type in PlayableTypes)
                {
                    foreach (var layer in _descriptor.baseAnimationLayers)
                    {
                        if (layer.type != type || layer.isDefault || layer.animatorController == null) continue;
                        var p = new Playable { Type = type.ToString() };
                        RuntimeAnimatorController rac = layer.animatorController;
                        p.Overrides = rac as AnimatorOverrideController;
                        if (p.Overrides != null) rac = p.Overrides.runtimeAnimatorController;
                        p.Controller = rac as AnimatorController;
                        if (p.Controller != null) _playables.Add(p);
                        break;
                    }
                }
            }
            if (!_playables.Any(p => p.Type == "FX")) _result.Warnings.Add("FX 레이어가 없어 토글·제스처 표정은 동작하지 않습니다.");

            foreach (var p in _playables)
            {
                foreach (var param in p.Controller.parameters) _parameterNames.Add(param.name);
            }
            foreach (var p in _playables)
            {
                var layers = p.Controller.layers;
                foreach (var layer in layers)
                {
                    var synced = layer.syncedLayerIndex >= 0 && layer.syncedLayerIndex < layers.Length;
                    var sm = synced ? layers[layer.syncedLayerIndex].stateMachine : layer.stateMachine;
                    foreach (var s in States(sm)) RegisterMotion(synced ? layer.GetOverrideMotion(s) : s.motion, p, 0);
                }
            }
            CaptureDefaults();
        }

        static List<AnimatorState> States(AnimatorStateMachine root)
        {
            var states = new List<AnimatorState>();
            var machines = new List<AnimatorStateMachine>();
            var parents = new List<int>();
            var owners = new List<int>();
            Flatten(root, -1, machines, parents, states, owners);
            return states;
        }

        static void Flatten(AnimatorStateMachine sm, int parent, List<AnimatorStateMachine> machines, List<int> parents,
            List<AnimatorState> states, List<int> owners)
        {
            if (sm == null || machines.Count > 512 || machines.Contains(sm)) return;
            var index = machines.Count;
            machines.Add(sm);
            parents.Add(parent);
            foreach (var child in sm.states)
            {
                if (child.state == null || states.Contains(child.state)) continue;
                states.Add(child.state);
                owners.Add(index);
            }
            foreach (var child in sm.stateMachines) Flatten(child.stateMachine, index, machines, parents, states, owners);
        }

        static Motion Resolve(Playable p, Motion m)
        {
            return p.Overrides != null && m is AnimationClip clip && p.Overrides[clip] != null ? p.Overrides[clip] : m;
        }

        void RegisterMotion(Motion motion, Playable p, int depth)
        {
            motion = Resolve(p, motion);
            if (motion is AnimationClip clip)
            {
                RegisterClip(clip);
                // VRChat ignores muscle curves in the FX layer.
                if (p.Type != "FX" && clip.humanMotion) HumanoidClips.Add(clip);
            }
            else if (motion is BlendTree tree && depth < 16)
            {
                foreach (var child in tree.children) RegisterMotion(child.motion, p, depth + 1);
            }
        }

        int RegisterClip(AnimationClip clip)
        {
            if (_clipIndex.TryGetValue(clip, out var index)) return index;
            index = Clips.Count;
            Clips.Add(clip);
            _clipIndex[clip] = index;
            foreach (var b in AnimationUtility.GetObjectReferenceCurveBindings(clip))
            {
                if (!IsMaterialSlot(b)) continue;
                foreach (var k in AnimationUtility.GetObjectReferenceCurve(clip, b))
                {
                    if (k.value is Material m) MaterialIndex(m);
                }
            }
            return index;
        }

        static bool IsMaterialSlot(EditorCurveBinding b)
        {
            return typeof(Renderer).IsAssignableFrom(b.type) && b.propertyName.StartsWith("m_Materials.Array.data[", StringComparison.Ordinal);
        }

        int MaterialIndex(Material m)
        {
            if (_materialIndex.TryGetValue(m, out var index)) return index;
            index = Materials.Count;
            Materials.Add(m);
            _materialIndex[m] = index;
            return index;
        }

        /// <summary>Scene state the animator starts from (Write Defaults values): inactive objects, disabled renderers, blendshape weights.</summary>
        void CaptureDefaults()
        {
            foreach (var t in _root.GetComponentsInChildren<Transform>(true))
            {
                if (t == _root) continue;
                var path = PathUtil.Relative(t, _root);
                if (!t.gameObject.activeSelf) _inactive.Add(path);
                var renderer = t.GetComponent<Renderer>();
                if (renderer != null && !renderer.enabled) _disabledRenderers.Add(path);
                if (renderer is SkinnedMeshRenderer smr && smr.sharedMesh != null)
                {
                    var mesh = smr.sharedMesh;
                    for (var i = 0; i < mesh.blendShapeCount; i++)
                    {
                        var weight = smr.GetBlendShapeWeight(i);
                        if (Mathf.Abs(weight) >= 0.01f) _shapes.Add((path, mesh.GetBlendShapeName(i), weight / 100f));
                    }
                }
            }
        }

        // ------------------------------------------------------------------ write

        public string Write(string vrmFileName)
        {
            var w = new VavJsonWriter(true);
            w.BeginObject();
            w.Prop("format", "vav-vrchat-meta").Prop("version", FormatVersion);
            w.Prop("generator", "VRC Avatar Tools Exporter " + AvatarExporter.Version);
            w.Prop("unity", Application.unityVersion).Prop("avatar", _root.name).Prop("vrm", vrmFileName);

            var expression = WriteExpressionParameters(w, _descriptor.expressionParameters);
            w.Key("menu");
            WriteMenu(w, _descriptor.expressionsMenu, new HashSet<VRCExpressionsMenu>(), 0);
            w.Key("icons").BeginArray();
            foreach (var icon in _icons) w.Value(icon);
            w.EndArray();

            w.Key("animator").BeginObject();
            WriteAnimatorParameters(w, expression);
            w.Key("playables").BeginArray();
            foreach (var p in _playables) WritePlayable(w, p);
            w.EndArray();
            w.EndObject();

            w.Key("clips").BeginArray();
            foreach (var clip in Clips) WriteClip(w, clip);
            w.EndArray();

            w.Key("materials").BeginArray();
            for (var i = 0; i < Materials.Count; i++)
            {
                w.BeginObject().Prop("index", i < MaterialIndices.Count ? MaterialIndices[i] : -1)
                    .Prop("name", i < MaterialNames.Count ? MaterialNames[i] : Materials[i].name).EndObject();
            }
            w.EndArray();

            WriteDefaults(w);

            if (_materialCurves > 0) _result.Warnings.Add($"머티리얼 속성 애니메이션 {_materialCurves}개는 뷰어에서 일부(색)만 재현됩니다.");
            if (_ignoredCurves > 0) _result.Info.Add($"뷰어가 쓰지 않는 애니메이션 커브 {_ignoredCurves}개(PhysBone·라이트 등)는 제외했습니다.");
            if (_ignoredBehaviours > 0) _result.Info.Add($"뷰어가 쓰지 않는 State Behaviour {_ignoredBehaviours}개는 제외했습니다.");
            _result.Info.Add($"애니메이터: 레이어 {string.Join(", ", _playables.Select(p => p.Type + " " + p.Controller.layers.Length))}, 클립 {Clips.Count}개, 휴머노이드 {Baked.Count}개, 교체 머티리얼 {Materials.Count}개");
            w.Key("warnings").BeginArray();
            foreach (var warning in _result.Warnings) w.Value(warning);
            w.EndArray();
            w.EndObject();
            return w.ToString();
        }

        // ------------------------------------------------------------------ parameters / menu

        static Dictionary<string, VRCExpressionParameters.Parameter> WriteExpressionParameters(VavJsonWriter w, VRCExpressionParameters asset)
        {
            var map = new Dictionary<string, VRCExpressionParameters.Parameter>();
            w.Key("parameters").BeginArray();
            if (asset != null && asset.parameters != null)
            {
                foreach (var p in asset.parameters)
                {
                    if ((object)p == null || string.IsNullOrEmpty(p.name) || map.ContainsKey(p.name)) continue;
                    map[p.name] = p;
                    w.BeginObject()
                        .Prop("name", p.name)
                        .Prop("type", p.valueType.ToString().ToLowerInvariant())
                        .Prop("default", p.defaultValue)
                        .Prop("saved", p.saved)
                        .Prop("synced", p.networkSynced)
                        .EndObject();
                }
            }
            w.EndArray();
            return map;
        }

        void WriteAnimatorParameters(VavJsonWriter w, Dictionary<string, VRCExpressionParameters.Parameter> expression)
        {
            var seen = new HashSet<string>();
            w.Key("parameters").BeginArray();
            foreach (var p in _playables)
            {
                foreach (var param in p.Controller.parameters)
                {
                    if (!seen.Add(param.name)) continue;
                    string type;
                    float value;
                    switch (param.type)
                    {
                        case AnimatorControllerParameterType.Bool: type = "bool"; value = param.defaultBool ? 1 : 0; break;
                        case AnimatorControllerParameterType.Int: type = "int"; value = param.defaultInt; break;
                        case AnimatorControllerParameterType.Float: type = "float"; value = param.defaultFloat; break;
                        default: type = "trigger"; value = 0; break;
                    }
                    // VRChat starts the animator from the Expression Parameter default.
                    if (expression.TryGetValue(param.name, out var e)) value = e.defaultValue;
                    w.BeginObject().Prop("name", param.name).Prop("type", type).Prop("default", value).EndObject();
                }
            }
            w.EndArray();
        }

        void WriteMenu(VavJsonWriter w, VRCExpressionsMenu menu, HashSet<VRCExpressionsMenu> open, int depth)
        {
            // Menus may reference themselves; stop on cycles.
            if (menu == null || depth > 16 || open.Contains(menu)) { w.Null(); return; }
            open.Add(menu);
            w.BeginObject().Prop("name", menu.name).Key("controls").BeginArray();
            if (menu.controls != null)
            {
                foreach (var c in menu.controls)
                {
                    if ((object)c == null) continue;
                    var type = c.type.ToString();
                    w.BeginObject().Prop("name", c.name ?? "").Prop("type", char.ToLowerInvariant(type[0]) + type.Substring(1));
                    var parameter = (object)c.parameter != null ? c.parameter.name : null;
                    if (!string.IsNullOrEmpty(parameter)) w.Prop("parameter", parameter);
                    w.Prop("value", c.value);
                    var icon = IconIndex(c.icon);
                    if (icon >= 0) w.Prop("icon", icon);
                    if (c.subParameters != null && c.subParameters.Length > 0)
                    {
                        w.Key("subParameters").BeginArray();
                        foreach (var sp in c.subParameters) w.Value((object)sp != null && sp.name != null ? sp.name : "");
                        w.EndArray();
                    }
                    if (c.labels != null && c.labels.Length > 0)
                    {
                        w.Key("labels").BeginArray();
                        foreach (var label in c.labels) w.Value(label.name ?? "");
                        w.EndArray();
                        w.Key("labelIcons").BeginArray();
                        foreach (var label in c.labels) w.Value(IconIndex(label.icon));
                        w.EndArray();
                    }
                    if (type == "SubMenu")
                    {
                        w.Key("menu");
                        WriteMenu(w, c.subMenu, open, depth + 1);
                    }
                    w.EndObject();
                }
            }
            w.EndArray().EndObject();
            open.Remove(menu);
        }

        /// <summary>Menu icons as 64×64 PNG data URLs (index into "icons").</summary>
        int IconIndex(Texture icon)
        {
            if (icon == null) return -1;
            if (_iconIndex.TryGetValue(icon, out var index)) return index;
            index = -1;
            try
            {
                const int size = 64;
                var rt = RenderTexture.GetTemporary(size, size, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
                var previous = RenderTexture.active;
                Graphics.Blit(icon, rt);
                RenderTexture.active = rt;
                var tex = new Texture2D(size, size, TextureFormat.RGBA32, false);
                tex.ReadPixels(new Rect(0, 0, size, size), 0, 0);
                tex.Apply();
                RenderTexture.active = previous;
                RenderTexture.ReleaseTemporary(rt);
                var png = tex.EncodeToPNG();
                Object.DestroyImmediate(tex);
                index = _icons.Count;
                _icons.Add("data:image/png;base64," + Convert.ToBase64String(png));
            }
            catch (Exception e)
            {
                Debug.LogWarning("[VRC Avatar Tools Exporter] icon " + icon.name + ": " + e.Message);
            }
            _iconIndex[icon] = index;
            return index;
        }

        // ------------------------------------------------------------------ playables / layers

        void WritePlayable(VavJsonWriter w, Playable p)
        {
            w.BeginObject().Prop("type", p.Type).Key("layers").BeginArray();
            var layers = p.Controller.layers;
            for (var i = 0; i < layers.Length; i++) WriteLayer(w, layers, i, p);
            w.EndArray().EndObject();
        }

        void WriteLayer(VavJsonWriter w, AnimatorControllerLayer[] layers, int index, Playable p)
        {
            var layer = layers[index];
            w.BeginObject().Prop("name", layer.name).Prop("weight", index == 0 ? 1f : layer.defaultWeight);
            if (layer.blendingMode == AnimatorLayerBlendingMode.Additive) w.Prop("additive", true);
            WriteMask(w, layer.avatarMask);

            var synced = layer.syncedLayerIndex >= 0 && layer.syncedLayerIndex < layers.Length && layer.syncedLayerIndex != index;
            var sm = synced ? layers[layer.syncedLayerIndex].stateMachine : layer.stateMachine;
            if (synced) w.Prop("synced", layer.syncedLayerIndex);

            var machines = new List<AnimatorStateMachine>();
            var parents = new List<int>();
            var states = new List<AnimatorState>();
            var owners = new List<int>();
            Flatten(sm, -1, machines, parents, states, owners);
            var stateIndex = new Dictionary<AnimatorState, int>();
            for (var i = 0; i < states.Count; i++) stateIndex[states[i]] = i;
            var machineIndex = new Dictionary<AnimatorStateMachine, int>();
            for (var i = 0; i < machines.Count; i++) machineIndex[machines[i]] = i;

            w.Key("machines").BeginArray();
            for (var i = 0; i < machines.Count; i++)
            {
                var m = machines[i];
                w.BeginObject().Prop("name", m.name).Prop("parent", parents[i]);
                w.Prop("default", m.defaultState != null && stateIndex.TryGetValue(m.defaultState, out var d) ? d : -1);
                if (!synced)
                {
                    w.Key("entry");
                    WriteTransitions(w, m.entryTransitions, stateIndex, machineIndex);
                    w.Key("any");
                    WriteTransitions(w, m.anyStateTransitions, stateIndex, machineIndex);
                    // Transitions out of child state machines, taken when one of them exits.
                    w.Key("exits").BeginArray();
                    foreach (var child in m.stateMachines)
                    {
                        if (child.stateMachine == null || !machineIndex.TryGetValue(child.stateMachine, out var from)) continue;
                        var list = m.GetStateMachineTransitions(child.stateMachine);
                        if (list == null || list.Length == 0) continue;
                        w.BeginObject().Prop("from", from).Key("t");
                        WriteTransitions(w, list, stateIndex, machineIndex);
                        w.EndObject();
                    }
                    w.EndArray();
                }
                w.EndObject();
            }
            w.EndArray();

            w.Key("states").BeginArray();
            for (var i = 0; i < states.Count; i++)
            {
                var s = states[i];
                w.BeginObject().Prop("name", s.name).Prop("m", owners[i]);
                w.Key("motion");
                WriteMotion(w, synced ? layer.GetOverrideMotion(s) : s.motion, p, 0);
                if (Math.Abs(s.speed - 1f) > 1e-5f) w.Prop("speed", s.speed);
                if (s.speedParameterActive && !string.IsNullOrEmpty(s.speedParameter)) w.Prop("speedParam", s.speedParameter);
                if (s.timeParameterActive && !string.IsNullOrEmpty(s.timeParameter)) w.Prop("timeParam", s.timeParameter);
                if (Math.Abs(s.cycleOffset) > 1e-5f) w.Prop("cycleOffset", s.cycleOffset);
                if (s.cycleOffsetParameterActive && !string.IsNullOrEmpty(s.cycleOffsetParameter)) w.Prop("cycleOffsetParam", s.cycleOffsetParameter);
                w.Prop("wd", s.writeDefaultValues);
                WriteBehaviours(w, synced ? layer.GetOverrideBehaviours(s) : s.behaviours);
                if (!synced)
                {
                    w.Key("transitions");
                    WriteTransitions(w, s.transitions, stateIndex, machineIndex);
                }
                w.EndObject();
            }
            w.EndArray();
            w.EndObject();
        }

        static void WriteMask(VavJsonWriter w, AvatarMask mask)
        {
            if (mask == null) return;
            w.Key("mask").BeginObject();
            w.Key("humanoid").BeginArray();
            for (var i = 0; i < (int)AvatarMaskBodyPart.LastBodyPart; i++)
            {
                if (mask.GetHumanoidBodyPartActive((AvatarMaskBodyPart)i)) w.Value(((AvatarMaskBodyPart)i).ToString());
            }
            w.EndArray();
            if (mask.transformCount > 0)
            {
                w.Key("transforms").BeginArray();
                for (var i = 0; i < mask.transformCount; i++)
                {
                    if (mask.GetTransformActive(i)) w.Value(mask.GetTransformPath(i));
                }
                w.EndArray();
            }
            w.EndObject();
        }

        static void WriteTransitions(VavJsonWriter w, AnimatorTransitionBase[] transitions,
            Dictionary<AnimatorState, int> states, Dictionary<AnimatorStateMachine, int> machines)
        {
            w.BeginArray();
            var list = (transitions ?? Array.Empty<AnimatorTransitionBase>()).Where(t => t != null && !t.mute).ToList();
            if (list.Any(t => t.solo)) list = list.Where(t => t.solo).ToList();
            foreach (var t in list)
            {
                var to = -1;
                var toMachine = -1;
                if (t.destinationState != null) { if (!states.TryGetValue(t.destinationState, out to)) continue; }
                else if (t.destinationStateMachine != null) { if (!machines.TryGetValue(t.destinationStateMachine, out toMachine)) continue; }
                else if (!t.isExit) continue;

                w.BeginObject();
                if (to >= 0) w.Prop("to", to);
                else if (toMachine >= 0) w.Prop("toM", toMachine);
                else w.Prop("exit", true);
                w.Key("c").BeginArray();
                foreach (var c in t.conditions)
                {
                    w.BeginArray().Value(c.parameter).Value((int)c.mode).Value(c.threshold).EndArray();
                }
                w.EndArray();
                if (t is AnimatorStateTransition st)
                {
                    if (st.hasExitTime) w.Prop("et", st.exitTime);
                    w.Prop("d", st.duration);
                    if (st.hasFixedDuration) w.Prop("fixed", true);
                    if (Math.Abs(st.offset) > 1e-5f) w.Prop("o", st.offset);
                    if (st.canTransitionToSelf) w.Prop("self", true);
                }
                w.EndObject();
            }
            w.EndArray();
        }

        void WriteMotion(VavJsonWriter w, Motion motion, Playable p, int depth)
        {
            motion = Resolve(p, motion);
            if (motion is AnimationClip clip)
            {
                w.BeginObject().Prop("clip", RegisterClip(clip)).EndObject();
                return;
            }
            if (motion is BlendTree tree && depth < 16)
            {
                string type;
                switch (tree.blendType)
                {
                    case BlendTreeType.Simple1D: type = "1d"; break;
                    case BlendTreeType.Direct: type = "direct"; break;
                    default: type = "2d"; break;
                }
                w.BeginObject().Key("tree").BeginObject().Prop("type", type);
                if (type != "direct") w.Prop("p", tree.blendParameter ?? "");
                if (type == "2d") w.Prop("p2", tree.blendParameterY ?? "");
                w.Key("children").BeginArray();
                foreach (var c in tree.children)
                {
                    w.BeginObject().Key("m");
                    WriteMotion(w, c.motion, p, depth + 1);
                    if (type == "1d") w.Prop("th", c.threshold);
                    else if (type == "2d") w.Key("pos").BeginArray().Value(c.position.x).Value(c.position.y).EndArray();
                    else w.Prop("dp", c.directBlendParameter ?? "");
                    if (Math.Abs(c.timeScale - 1f) > 1e-5f) w.Prop("ts", c.timeScale);
                    w.EndObject();
                }
                w.EndArray().EndObject().EndObject();
                return;
            }
            w.Null();
        }

        // ------------------------------------------------------------------ state behaviours

        static object Field(object o, string name)
        {
            return o?.GetType().GetField(name, BindingFlags.Public | BindingFlags.Instance)?.GetValue(o);
        }

        static float FloatField(object o, string name, float fallback = 0f)
        {
            var v = Field(o, name);
            if (v is float f) return f;
            if (v is int i) return i;
            if (v is bool b) return b ? 1 : 0;
            return fallback;
        }

        static string EnumField(object o, string name) => Field(o, name)?.ToString() ?? "";

        void WriteBehaviours(VavJsonWriter w, StateMachineBehaviour[] behaviours)
        {
            if (behaviours == null || behaviours.Length == 0) return;
            var started = false;
            void Begin()
            {
                if (started) return;
                started = true;
                w.Key("behaviours").BeginArray();
            }
            foreach (var b in behaviours)
            {
                if (b == null) continue;
                switch (b.GetType().Name)
                {
                    case "VRCAvatarParameterDriver":
                    {
                        Begin();
                        w.BeginObject().Prop("type", "driver").Prop("local", FloatField(b, "localOnly") > 0).Key("ops").BeginArray();
                        if (Field(b, "parameters") is IEnumerable list)
                        {
                            foreach (var op in list)
                            {
                                if (op == null) continue;
                                w.BeginObject()
                                    .Prop("t", EnumField(op, "type").ToLowerInvariant())
                                    .Prop("n", Field(op, "name") as string ?? "")
                                    .Prop("s", Field(op, "source") as string ?? "")
                                    .Prop("v", FloatField(op, "value"))
                                    .Prop("min", FloatField(op, "valueMin"))
                                    .Prop("max", FloatField(op, "valueMax", 1))
                                    .Prop("ch", FloatField(op, "chance", 1));
                                if (FloatField(op, "convertRange") > 0)
                                {
                                    w.Key("range").BeginArray()
                                        .Value(FloatField(op, "sourceMin")).Value(FloatField(op, "sourceMax"))
                                        .Value(FloatField(op, "destMin")).Value(FloatField(op, "destMax")).EndArray();
                                }
                                w.EndObject();
                            }
                        }
                        w.EndArray().EndObject();
                        break;
                    }
                    case "VRCPlayableLayerControl":
                        Begin();
                        w.BeginObject().Prop("type", "playable").Prop("layer", EnumField(b, "layer"))
                            .Prop("goal", FloatField(b, "goalWeight")).Prop("dur", FloatField(b, "blendDuration")).EndObject();
                        break;
                    case "VRCAnimatorLayerControl":
                        Begin();
                        w.BeginObject().Prop("type", "layer").Prop("playable", EnumField(b, "playable")).Prop("layer", (int)FloatField(b, "layer"))
                            .Prop("goal", FloatField(b, "goalWeight")).Prop("dur", FloatField(b, "blendDuration")).EndObject();
                        break;
                    case "VRCAnimatorTrackingControl":
                        Begin();
                        w.BeginObject().Prop("type", "tracking");
                        foreach (var part in new[] { "Head", "LeftHand", "RightHand", "Hip", "LeftFoot", "RightFoot", "LeftFingers", "RightFingers", "Eyes", "Mouth" })
                        {
                            var v = EnumField(b, "tracking" + part);
                            if (v == "Tracking" || v == "Animation") w.Prop(char.ToLowerInvariant(part[0]) + part.Substring(1), v.ToLowerInvariant());
                        }
                        w.EndObject();
                        break;
                    case "VRCAnimatorLocomotionControl":
                        Begin();
                        w.BeginObject().Prop("type", "locomotion").Prop("disable", FloatField(b, "disableLocomotion") > 0).EndObject();
                        break;
                    default:
                        _ignoredBehaviours++;
                        break;
                }
            }
            if (started) w.EndArray();
        }

        // ------------------------------------------------------------------ clips

        void WriteClip(VavJsonWriter w, AnimationClip clip)
        {
            w.BeginObject().Prop("name", clip.name).Prop("length", clip.length);
            if (AnimationUtility.GetAnimationClipSettings(clip).loopTime) w.Prop("loop", true);

            w.Key("curves").BeginArray();
            foreach (var b in AnimationUtility.GetCurveBindings(clip))
            {
                if (!Classify(b, out var kind, out var prop, out var component, out var scale)) continue;
                var curve = AnimationUtility.GetEditorCurve(clip, b);
                if (curve == null || curve.length == 0) continue;
                w.BeginObject().Prop("p", b.path).Prop("k", kind);
                if (prop != null) w.Prop("n", prop);
                if (component != null) w.Prop("c", component);
                w.Key("v").BeginArray();
                var keys = curve.keys;
                var constant = keys.All(k => Math.Abs(k.value - keys[0].value) < 1e-6f);
                foreach (var k in constant ? new[] { keys[0] } : keys)
                {
                    w.Value(constant ? 0f : k.time).Value(k.value * scale);
                    w.Slope(constant ? 0f : k.inTangent * scale).Slope(constant ? 0f : k.outTangent * scale);
                }
                w.EndArray().EndObject();
            }
            w.EndArray();

            var started = false;
            foreach (var b in AnimationUtility.GetObjectReferenceCurveBindings(clip))
            {
                if (!IsMaterialSlot(b)) { _ignoredCurves++; continue; }
                if (!int.TryParse(b.propertyName.Substring("m_Materials.Array.data[".Length).TrimEnd(']'), out var slot)) continue;
                if (!started) { w.Key("materials").BeginArray(); started = true; }
                w.BeginObject().Prop("p", b.path).Prop("slot", slot).Key("v").BeginArray();
                foreach (var k in AnimationUtility.GetObjectReferenceCurve(clip, b))
                {
                    w.Value(k.time).Value(k.value is Material m ? MaterialIndex(m) : -1);
                }
                w.EndArray().EndObject();
            }
            if (started) w.EndArray();

            if (Baked.TryGetValue(clip, out var baked))
            {
                w.Key("humanoid").BeginObject().Prop("rate", baked.Rate).Prop("frames", baked.Frames);
                w.Key("bones").BeginArray();
                foreach (var bone in baked.Bones) w.Value(bone);
                w.EndArray();
                w.Prop("rot", Base64(baked.Rotations));
                if (baked.Hips != null) w.Prop("hips", Base64(baked.Hips));
                w.EndObject();
            }
            w.EndObject();
        }

        static string Base64(float[] values)
        {
            var bytes = new byte[values.Length * 4];
            Buffer.BlockCopy(values, 0, bytes, 0, bytes.Length);
            return Convert.ToBase64String(bytes);
        }

        /// <summary>
        /// Curve kinds the viewer understands. Values are converted to glTF / three.js conventions:
        /// blendshapes 0..1, positions with X mirrored, quaternions (x, -y, -z, w). Euler angles stay in Unity degrees.
        /// </summary>
        bool Classify(EditorCurveBinding b, out string kind, out string prop, out string component, out float scale)
        {
            kind = prop = component = null;
            scale = 1f;
            var name = b.propertyName;
            if (b.type == typeof(Animator))
            {
                // Muscles / root motion are baked (HumanoidBaker); animated animator parameters are kept.
                if (_parameterNames.Contains(name)) { kind = "param"; prop = name; return true; }
                return false;
            }
            if (b.type == typeof(SkinnedMeshRenderer) && name.StartsWith("blendShape.", StringComparison.Ordinal))
            {
                kind = "shape"; prop = name.Substring("blendShape.".Length); scale = 0.01f; return true;
            }
            if (b.type == typeof(GameObject) && name == "m_IsActive") { kind = "active"; return true; }
            if (typeof(Renderer).IsAssignableFrom(b.type))
            {
                if (name == "m_Enabled") { kind = "enabled"; return true; }
                if (name.StartsWith("material.", StringComparison.Ordinal))
                {
                    _materialCurves++;
                    kind = "mat"; prop = name.Substring("material.".Length); return true;
                }
            }
            if (b.type == typeof(Transform))
            {
                var dot = name.LastIndexOf('.');
                if (dot > 0)
                {
                    var head = name.Substring(0, dot);
                    component = name.Substring(dot + 1);
                    switch (head)
                    {
                        case "m_LocalPosition": kind = "pos"; if (component == "x") scale = -1f; return true;
                        case "m_LocalRotation": kind = "rot"; if (component == "y" || component == "z") scale = -1f; return true;
                        case "m_LocalScale": kind = "scale"; return true;
                        case "localEulerAnglesRaw":
                        case "localEulerAngles":
                        case "localEulerAnglesBaked": kind = "euler"; return true;
                    }
                    component = null;
                }
            }
            _ignoredCurves++;
            return false;
        }

        // ------------------------------------------------------------------ defaults

        void WriteDefaults(VavJsonWriter w)
        {
            w.Key("defaults").BeginObject();
            w.Key("objects").BeginArray();
            foreach (var path in _inactive) w.BeginObject().Prop("path", path).Prop("active", false).EndObject();
            w.EndArray();
            w.Key("renderers").BeginArray();
            foreach (var path in _disabledRenderers) w.BeginObject().Prop("path", path).Prop("enabled", false).EndObject();
            w.EndArray();
            w.Key("blendShapes").BeginArray();
            foreach (var (path, shape, weight) in _shapes) w.BeginObject().Prop("path", path).Prop("shape", shape).Prop("weight", weight).EndObject();
            w.EndArray();
            w.EndObject();
        }
    }
}
