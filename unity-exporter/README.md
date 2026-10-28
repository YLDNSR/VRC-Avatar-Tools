# VRC Avatar Tools Exporter (Unity 에디터 확장)

VRChat 아바타를 **한 번에** Mac 뷰어용으로 내보냅니다. 임시 복사본에 **업로드할 때와 같은 빌드**(VRChat SDK 전처리: Modular Avatar·NDMF·Avatar Optimizer·VRCFury 등)를 적용한 뒤 내보내므로, 뷰어에서 메뉴·의상·초기 모습이 VRChat과 같습니다. 원본 아바타는 바뀌지 않습니다.

- `<이름>.vrm` — VRM 1.0 (UniVRM)
  - lilToon(및 기타 셰이더) → MToon: 색 조정(HSVG·그라데이션)·2nd/3rd 텍스처는 lilToon의 베이커로, 알파 마스크는 알파 채널에, 그림자 강도 마스크는 그림자 텍스처에 굽고, 그림자색·경계, 림, MatCap(마스크 포함, 1st·2nd 중 강한 쪽), 발광, 노멀맵, 아웃라인을 옮김
  - PhysBone → SpringBone(근사), 비셈 `vrc.v_aa/ih/ou/e/oh` → `aa/ih/ou/ee/oh`, 눈 깜빡임 → `blink/blinkLeft/blinkRight`
  - 머티리얼 교체 애니메이션이 쓰는 머티리얼(헤어색·의상 색 등)도 들어감 (씬에 붙지 않은 상태라 뷰어가 처음 쓸 때만 로드)
- `<이름>.vavmeta.json` (v2) — Expression Menu(아이콘 포함)·Parameters, Gesture·Action·FX 애니메이터(스테이트 머신·블렌드 트리·Parameter Driver·레이어 제어 등), 모든 클립, 이 아바타에 맞춰 구운 휴머노이드 애니메이션(춤·AFK·손 모양), 씬 기본값. 형식: [docs/vavmeta.md](../docs/vavmeta.md)

> 플레이 모드에서는 내보낼 수 없습니다(애니메이터가 바꾼 상태가 굳기 때문). Gesture Manager 등을 끄고 에디터 상태에서 내보내세요.

## 대상 버전

| 항목 | 버전 |
|---|---|
| Unity | 2022.3 LTS (VRChat 권장 2022.3.22f1) |
| VRChat SDK - Avatars | 3.7.0 이상 (3.10.5 API 기준으로 작성) |
| UniVRM (`com.vrmc.gltf` + `com.vrmc.vrm`) | 0.128.0 ~ 0.131.x (0.131.3 소스 기준) |

lilToon은 있으면 그 베이커 셰이더(`Hidden/ltsother_baker`)를 씁니다. Modular Avatar·NDMF 등은 프로젝트에 있으면 VRChat SDK 전처리로 함께 적용됩니다.

UniVRM이 없거나 버전이 범위를 벗어나면 내보내기 코드는 **컴파일되지 않고 건너뜁니다**(프로젝트에 컴파일 에러를 만들지 않음). 대신 메뉴가 UniVRM 설치를 안내합니다.

## 설치

1. 이 `unity-exporter` 폴더를 아바타 프로젝트의 `Packages/local.vrcavatartools.exporter/` 로 복사합니다.
   (또는 VCC → Settings → Packages → **Add Package**(User Package)로 이 폴더를 추가한 뒤 프로젝트에 추가)
2. UniVRM 설치: `Tools → VRC Avatar Tools → Install UniVRM (VRM 1.0)` (Package Manager가 GitHub에서 받습니다).
   직접 설치하려면 Package Manager → + → Add package from git URL:
   - `https://github.com/vrm-c/UniVRM.git?path=/Packages/UniGLTF#v0.131.3`
   - `https://github.com/vrm-c/UniVRM.git?path=/Packages/VRM10#v0.131.3`
   - VRM Converter for VRChat 등으로 `com.vrmc.gltf` 가 이미 있으면 **같은 버전**의 `com.vrmc.vrm` 을 설치하세요.

## 사용법

1. 플레이 모드가 아닌 상태에서 Hierarchy의 아바타 루트(VRC Avatar Descriptor가 있는 오브젝트)를 우클릭 → **VRC Avatar Tools → Export**
2. 작성자 입력, 옵션 확인 → 「내보내기」 → 저장 위치 선택 (큰 아바타는 1분 정도 걸립니다)
3. 만들어진 `.vrm` 을 Mac 뷰어에 드래그합니다. 같은 폴더의 `.vavmeta.json` 은 자동으로 읽힙니다.

옵션: T포즈 맞춤, PhysBone 변환, 꺼진 오브젝트 포함, **업로드와 같은 빌드 적용**(기본 켬), **lilToon 등 → MToon 변환**(기본 켬). EditorOnly 태그 오브젝트는 제외됩니다.

## 확인한 환경

Unity 2022.3.22f1, VRChat SDK 3.10.5, UniVRM 0.131.3, Modular Avatar 1.15, NDMF, Avatar Optimizer 1.8, lilToon 1.10, OneClickInventory 아바타(시나노)로 내보내기 → 뷰어에서 초기 모습, 메뉴, 의상·헤어·색 교체, 제스처 표정, 춤(Action 레이어), AFK를 확인했습니다.

## 제한

- PhysBone → SpringBone은 근사: `stiffness = pull×4`, `drag = lerp(0.7, 0.2, spring)`, `gravityPower = |gravity|`. 각도 제한·Immobile·Stretch·Grab은 변환하지 않습니다.
- MToon은 lilToon의 근사입니다: 2nd 그림자, 반사(스페큘러), 머티리얼 속성 애니메이션(뷰어는 색 정도만), Poiyomi 등 lilToon 이외 셰이더의 고급 기능은 옮기지 않습니다.
- MToon은 MatCap과 림라이트가 마스크 하나를 같이 씁니다. lilToon에서 둘의 마스크가 다르면 빛을 더 많이 더하는 쪽만 남기고(예: 단추에만 쓰는 금색 MatCap보다 재킷 전체의 림), 결과 창에 개수를 표시합니다.
- Base·Additive 레이어와 VRChat 기본(SDK 기본값) 레이어는 넣지 않습니다. 뷰어의 Idle·애니메이션을 씁니다.
- 색 변형이 많은 아바타는 VRM이 커집니다(교체 머티리얼의 구운 텍스처 포함). 시나노 예: 약 160MB.
