# `.vavmeta.json` 형식 (VRChat 아바타 사이드카)

Unity 익스포터(`unity-exporter/`)가 `<이름>.vrm` 옆에 `<이름>.vavmeta.json` 으로 씁니다. 뷰어는 아바타를 열 때 같은 폴더·같은 이름의 이 파일이 있으면 읽습니다.

- **version 2** (익스포터 0.2 이상): 빌드된 아바타의 Gesture·Action·FX 애니메이터 전체. 뷰어의 `src/viewer/vrcAnimator.ts` 가 VRChat처럼 실행합니다.
- **version 1** (익스포터 0.1): FX 토글·제스처 맵만. `src/viewer/vrcMeta.ts` 의 `VrcFx` 가 근사로 평가합니다. 손으로 쓴 예: [test/vavmeta/SampleAvatar.vavmeta.json](../test/vavmeta/SampleAvatar.vavmeta.json)

`path` 는 Unity 애니메이션 경로(아바타 루트 기준, 예 `Armature/Hips/Head/Hat`)이고, VRM의 노드 이름과 같습니다(익스포터가 업로드 빌드 후의 계층을 그대로 내보냄).

## 공통 (v1 · v2)

| 키 | 내용 |
|---|---|
| `format` | `"vav-vrchat-meta"` (필수) |
| `version` | `1` 또는 `2` (필수) |
| `generator`, `unity`, `avatar`, `vrm` | 정보용 |
| `parameters` | Expression Parameters: `{ name, type: "bool"\|"int"\|"float", default, saved, synced }` |
| `menu` | Expression Menu 트리 (아래) 또는 `null` |
| `defaults` | 씬 기본값 (아래) |
| `warnings` | 익스포터가 남긴 경고 문자열 |

### Expression Menu

```jsonc
{ "name": "Main Menu", "controls": [
  { "name": "Hat", "type": "toggle", "parameter": "Hat", "value": 1, "icon": 0 },
  { "name": "Outfit", "type": "subMenu", "value": 1, "menu": { "name": "...", "controls": [ ... ] } },
  { "name": "Cheek", "type": "radialPuppet", "subParameters": ["Cheek"] }
] }
```

`type`: `button` · `toggle` · `subMenu` · `twoAxisPuppet` · `fourAxisPuppet` · `radialPuppet`. `labels` 는 퍼펫 축 이름, `icon` / `labelIcons` 는 최상위 `icons`(v2, 64×64 PNG data URL)의 번호.

### defaults

```jsonc
{ "objects": [{ "path": "Hat", "active": false }],          // 꺼진 오브젝트
  "renderers": [{ "path": "Body", "enabled": false }],       // 꺼진 렌더러 (v2)
  "blendShapes": [{ "path": "Body", "shape": "cheek", "weight": 0.3 }] }  // 0이 아닌 블렌드셰이프 (0~1)
```

VRM에는 꺼진 오브젝트도 켠 상태로 들어가므로(애니메이션으로 켤 수 있게) 뷰어가 이 값으로 처음 모습을 맞춥니다. UniVRM은 블렌드셰이프 기본값을 저장하지 않으므로 이것도 여기서 줍니다.

## version 2

| 키 | 내용 |
|---|---|
| `icons` | 메뉴 아이콘 data URL 배열 |
| `animator.parameters` | 모든 애니메이터 파라미터 `{ name, type: "bool"\|"int"\|"float"\|"trigger", default }` (Expression Parameter 기본값 반영) |
| `animator.playables` | `[{ type: "Gesture"\|"Action"\|"FX", layers: [Layer] }]` — 디스크립터의 커스텀 레이어 순서 |
| `clips` | 모든 레이어가 쓰는 클립 배열 (모션의 `clip` 이 번호) |
| `materials` | 머티리얼 교체 애니메이션이 쓰는 머티리얼: `{ index, name }` — `index` 는 VRM(glTF)의 머티리얼 번호 |

### Layer

```jsonc
{ "name": "Hat", "weight": 1, "additive": false,
  "mask": { "humanoid": ["LeftFingers"], "transforms": ["Hat"] },   // 아바타 마스크 (있으면)
  "synced": 2,                                                       // Synced Layer면 원본 레이어 번호
  "machines": [{ "name": "Hat", "parent": -1, "default": 0,
                 "entry": [Transition], "any": [Transition],
                 "exits": [{ "from": 1, "t": [Transition] }] }],     // 하위 스테이트 머신에서 나갈 때의 트랜지션
  "states": [{ "name": "On", "m": 0, "motion": Motion, "wd": true,
               "speed": 1, "speedParam": "...", "timeParam": "...", "cycleOffset": 0,
               "behaviours": [Behaviour], "transitions": [Transition] }] }
```

- 스테이트 머신은 평탄화되어 있습니다. `m` 은 스테이트가 속한 `machines` 번호, 0이 루트.
- Transition: `{ to?: 스테이트 번호, toM?: 머신 번호, exit?: true, c: [[파라미터, 모드, 임계값]], et?: Exit Time, d: 길이, fixed?: 초 단위, o?: 오프셋, self?: Can Transition To Self }`. 모드는 Unity 값(1 If, 2 IfNot, 3 Greater, 4 Less, 6 Equals, 7 NotEqual). Mute된 트랜지션은 빠지고, Solo가 있으면 Solo만 남습니다.
- Motion: `null` · `{ "clip": n }` · `{ "tree": { type: "1d"|"2d"|"direct", p, p2, children: [{ m: Motion, th?, pos?: [x, y], dp?, ts? }] } }`
- Behaviour:
  - `{ type: "driver", local, ops: [{ t: "set"|"add"|"random"|"copy", n, s, v, min, max, ch, range?: [srcMin, srcMax, dstMin, dstMax] }] }`
  - `{ type: "playable", layer: "Action"|"FX"|…, goal, dur }` (VRC Playable Layer Control)
  - `{ type: "layer", playable, layer: 번호, goal, dur }` (VRC Animator Layer Control)
  - `{ type: "tracking", head: "animation"|"tracking", … }`, `{ type: "locomotion", disable }`

### Clip

```jsonc
{ "name": "Hat On", "length": 1, "loop": false,
  "curves": [{ "p": "Hat", "k": "active", "v": [t, value, inSlope, outSlope, ...] }],
  "materials": [{ "p": "Body", "slot": 0, "v": [t, materials 번호, ...] }],
  "humanoid": { "rate": 30, "frames": 233, "bones": ["hips", ...], "rot": "<base64 Float32>", "hips": "<base64 Float32>" } }
```

- `k`: `shape`(블렌드셰이프, 0~1, `n` = 이름) · `active`(m_IsActive) · `enabled`(Renderer.m_Enabled) · `mat`(머티리얼 속성, `n` = `_Color.r` 등) · `pos` · `rot` · `euler` · `scale`(Transform, `c` = x/y/z/w) · `param`(애니메이션되는 애니메이터 파라미터)
- 값은 glTF/three.js 기준으로 바꿔 둡니다: 위치 X 반전, 쿼터니언 (x, -y, -z, w). `euler` 는 Unity 각도(도) 그대로.
- 키는 Unity 키프레임(시간, 값, 접선) — Hermite 보간. 무한 접선(계단)은 ±1e9. 값이 일정한 커브는 키 하나.
- `humanoid`: Unity가 이 아바타에 리타기팅한 결과를 `rate` fps로 샘플링한 three-vrm **정규화 본** 회전(프레임 × 본 × xyzw)과 엉덩이 위치(프레임 × xyz, 아바타 루트 기준). 클립이 움직이는 본만 들어갑니다. Gesture·Action 레이어의 클립만 굽습니다(VRChat은 FX의 머슬 커브를 무시).

### 뷰어의 실행 방식 (`vrcAnimator.ts`)

1. 파라미터: 애니메이터 기본값 → Expression Parameter 기본값 → VRChat 내장 파라미터(IsLocal=1, Grounded=1, TrackingType=3, VRMode=0, AFK, GestureLeft/Right …)
2. 매 프레임 플레이어블(Gesture → Action → FX) · 레이어 순서로 스테이트 머신을 진행: Any State → 현재 스테이트의 트랜지션, Exit Time, 크로스페이드, 트리거 소비, 스테이트 진입 시 Behaviour 실행
3. 출력: 매 프레임 씬 기본값에서 시작해 레이어 가중치(× 플레이어블 가중치)로 덮어씀. 현재 스테이트가 움직이는 속성만 쓰고, Write Defaults OFF 스테이트는 레이어의 나머지 속성에 마지막 값을 계속 씀(ON이면 아래 레이어·기본값이 보임). 모션이 없는 스테이트는 아무것도 쓰지 않음
4. 적용: 블렌드셰이프 → 아바타 레이어 `vrc-fx`, 오브젝트·렌더러 → `visible`, 머티리얼 번호 → 해당 슬롯(처음 쓸 때 VRM에서 로드), Transform → 노드, 휴머노이드 → Action(전신)·Gesture(손가락) 결과를 뷰어의 포즈 위에 가중치로 블렌드
5. Action 플레이어블은 가중치 0에서 시작합니다(VRChat과 같음). Playable Layer Control로 1이 되면 춤 등이 몸 전체를 움직입니다.

## version 1 (구 형식)

| 키 | 내용 |
|---|---|
| `localParameters` | FX Animator에만 있는 파라미터: `{ name, type, default }` |
| `gestures` | `{ left: [8], right: [8] }` — GestureLeft/GestureRight 0~7 의 Effect 또는 `null` |
| `toggles` | 제스처 이외의 FX 레이어: `{ layer, states: [{ name, default?, when: [[조건]], motion: Effect }] }` |

```jsonc
// Effect: 클립을 한 시점에서 샘플링한 값
{ "clip": "Smile", "blendShapes": [{ "path": "Body", "shape": "eye_smile", "weight": 1 }], "objects": [{ "path": "FX Heart", "active": true }] }
// 1D 블렌드 트리 / Motion Time
{ "blend": "Cheek", "children": [{ "threshold": 0, "motion": Effect }, { "threshold": 1, "motion": Effect }] }
// Direct 블렌드 트리
{ "direct": [{ "parameter": "One", "motion": Motion }] }
```

평가: 각 레이어에서 조건이 모두 맞는 스테이트 중 조건 수가 가장 많은 것(없으면 `default`)을 골라 `defaults` 위에 레이어 순서대로 덮어씁니다(Write Defaults ON 근사).
