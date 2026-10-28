# VRC Avatar Tools

VRChat 아바타(VRM으로 내보낸 것)를 macOS 데스크톱에 띄우고, 웹캠/iPhone으로 움직이며, **Syphon**으로 OBS에 방송할 수 있는 앱입니다.

- 사용법: [docs/GUIDE.ko.md](docs/GUIDE.ko.md) (앱 메뉴 「도움말 → 맥 사용 가이드」)
- 빌드 결과물: macOS `release/VRC-Avatar-Tools-<버전>-mac-arm64.dmg` / `.zip`, Windows `release/VRC-Avatar-Tools-<버전>-win-x64-setup.exe` / `.zip`
- **Windows 판**(0.3.0~, 시험판): 같은 뷰어·캡처 앱을 Windows x64로도 빌드합니다. Syphon(macOS 전용)은 빠지고 OBS는 「윈도우 캡처」로 잡습니다. 차이는 가이드의 「Windows 판」을 보세요.

## 주요 기능

**뷰어**
- `.vrm`(0.x/1.0) · `.glb` · `.gltf` 표시 (MToon, SpringBone, 표정, 시선) — 드래그 앤 드롭 / 파일 열기 / 폴더 썸네일 목록·검색, 파일 덮어쓰기 시 자동 재로드
- 회전·이동·줌·초기화, 방향키·단축키, 하단 자동 툴바, 정보 오버레이(I)
- 애니메이션 플레이어: `.vrma`, Unity `.anim`(휴머노이드 근사 변환, 블렌드셰이프·오브젝트 ON/OFF 커브), 단일/재생목록/세트(10×10), 받침대 크기·Y 오프셋
- 조명 프리셋·방향·높이·밝기·색온도·월드/아바타 고정·마커
- Shift+F1～F8 제스처(손가락 포즈+표정), 전역 단축키 옵션(입력 모니터링 권한)
- 커서 시선 모드, 받침대, 표정·파라미터 패널 / VRChat 아바타 메뉴
- 원형 메뉴: 아바타 오른쪽 클릭 → 커서 주위에 아바타 메뉴(아이콘·토글·서브메뉴·퍼펫 다이얼/스틱)와 앱 기능(창 이동·투명 끄기 등). 배경 투명 모드에서는 하단 툴바 대신 이 메뉴를 씁니다
- 위치·크기·회전: 아바타 위치·회전·크기와 카메라를 숫자로 조정, 아바타별 저장(열 때 자동 적용), 고정(마우스·키보드 잠금), 초기화
- 시작: 로그인 시 자동 실행(macOS 로그인 항목), 시작할 때 마지막 아바타·배경 투명 상태로 열기
- 아바타별 기억: 아바타 메뉴 값(의상·헤어·색·토글·춤·AFK)과 재생 중인 모션, 일반 VRM의 표정·오브젝트 표시를 자동 저장해 다음에 열 때 적용
- **VRChat 아바타 익스포터** (`unity-exporter/`, Unity 에디터 확장): 업로드와 같은 빌드(Modular Avatar·NDMF 등)를 적용해 VRM 1.0(lilToon → MToon) + `<이름>.vavmeta.json`(Expression Menu·Gesture/Action/FX 애니메이터·클립·구운 휴머노이드 애니메이션)을 한 번에 내보내고, 뷰어가 VRChat처럼 애니메이터를 실행(옷·헤어·색 교체, 제스처 표정, 춤·AFK)
- 배경 투명 모드(항상 위·클릭 통과·해제 키), 아바타 투과 모드, 유휴 FPS 낮추기, 6개 언어
- 스트리밍 모드: VMC 수신(39539), VRChat OSC/VRCFT 수신(9000), 페이스 트래킹 타입(VRM 기본/Perfect Sync/VRCFT), IK 팔 보정, 시야각·줌 강조, 카메라 저장/복원, 모션 스무딩, 아바타 프로필(TOML), **Syphon 출력**(투명 배경, 최대 4K)

**캡처 앱** (⌘⇧C)
- 웹캠: MediaPipe 얼굴(ARKit 52종)·몸·손가락 추정 → VMC 송신, 미러, 캘리브레이션(카운트다운), 동작 조정 슬라이더, 전송 부위, 마이크 립싱크
- iFacialMocap 수신(UDP 49983, v1/v2 형식)
- 표정 형식: VRM 표준 / Perfect Sync / VRCFT(VRChat OSC `/avatar/parameters/v2/*`), VRChat 직접 송신 버튼

## 구조

```
electron/            메인 프로세스(창·파일·설정·Syphon 헬퍼 관리), preload(UDP·공유 메모리)
src/viewer/          뷰어 (three.js + @pixiv/three-vrm)
src/capture/         캡처 앱 (MediaPipe Tasks Vision)
src/shared/          OSC 인코더/디코더, 본/표정 이름표, i18n, UI 헬퍼
native/src/addon.mm  N-API 애드온: Syphon용 공유 메모리 쓰기, 보조키 상태, 전역 키 모니터
native/helper/       "VRC Avatar Tools Syphon" 헬퍼 (Syphon-Framework 소스를 정적으로 포함)
native/vendor/       Syphon-Framework (BSD-2)
resources/           avatar_profiles/sample.toml
unity-exporter/      Unity 에디터 확장 (VPM 패키지): VRChat 아바타 → VRM 1.0 + .vavmeta.json
test/vavmeta/        사이드카 샘플 (자동 테스트용)
scripts/             네이티브 빌드, MediaPipe 모델 다운로드, 아이콘 생성
```

Syphon은 별도 헬퍼 프로세스에서 돌립니다. 뷰어는 오프스크린으로 렌더링(UI·마커 제외)한 프레임을 비동기로 읽어 공유 메모리에 쓰고, 헬퍼가 IOSurface로 복사해 Syphon으로 발행합니다.

## 빌드

필요: macOS 12+, Xcode Command Line Tools, Node.js 20+

```bash
npm install
```

```bash
npm run fetch-models
```

```bash
npm run dev
```

배포용 `.app` / `.dmg` (Apple Silicon, ad-hoc 서명):

```bash
npm run dist        # macOS (= npm run dist:mac)
npm run dist:win    # Windows x64 (NSIS 설치 파일 + zip). 맥에서 크로스 빌드 가능, Wine 불필요
```

Apple Silicon에 Rosetta가 없으면(예: macOS 27) electron-builder의 Intel용 `makensis`가 실행되지 않으므로, `scripts/dist-win.js` 가 Homebrew의 네이티브 `makensis` 로 대신 빌드합니다: `brew install makensis` 를 한 번 해 두세요.

- `npm run build:native` — 애드온 + Syphon 헬퍼 + 테스트용 `native/test/build/syphon-probe` 빌드
- `npm run typecheck` — TypeScript 검사
- Intel Mac용은 `VAV_ARCH=x64 npm run build:native` 후 `package.json`의 `mac.target` arch를 `x64`로 바꿔 빌드하세요.

### 개발용 자동 테스트

`VAV_TEST_SCRIPT=steps.json`(+ `VAV_USER_DATA=<임시 폴더>`)로 실행하면 JSON 단계(`eval`, `shot`, `wait`, `openCapture`, `exec`, `quit`)를 차례로 실행합니다. 예: 아바타 로드 → 스크린샷 → Syphon 프로브.

`npm run test:vavmeta` — glTF 테스트 아바타와 [샘플 사이드카(v1)](test/vavmeta/SampleAvatar.vavmeta.json)로 FX 토글·제스처·아바타 메뉴 패널을 확인합니다 (임시 userData 사용, 스크린샷 경로 출력). 사이드카 형식: [docs/vavmeta.md](docs/vavmeta.md)

## 라이선스

Copyright © 2026 NOOK. All rights reserved.

소스는 공개되어 있지만 오픈 소스 라이선스로 배포하지 않습니다. 저작권자의 허락 없이 복제·수정·재배포할 수 없습니다.

사용한 오픈 소스 (각자의 라이선스를 따름):

- three.js (MIT), @pixiv/three-vrm (MIT), MediaPipe Tasks Vision (Apache-2.0, 모델은 Google 배포), Syphon-Framework (BSD-2), smol-toml (BSD-3), yaml (ISC), Electron (MIT)
- 라이선스 전문: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (배포 앱의 Resources 폴더에도 들어 있음). 의존성을 바꾸면 `npm run notices` 로 다시 만듭니다.
