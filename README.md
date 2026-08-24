# 가계도 메이커

브라우저에서 바로 그리고 편집하는 가계도(family tree) 웹앱. 빌드 도구 없이 순수
HTML/CSS/JavaScript로 만들어져 있어 GitHub Pages에 파일 그대로 올리면 동작한다.

## 로컬에서 실행하기

`src/main.js`가 ES 모듈이라 `index.html`을 **파일로 그냥 더블클릭해서 열면 CORS 때문에
동작하지 않는다.** 아래 중 한 가지 방법으로 로컬 웹서버를 띄워서 열어야 한다.

```bash
# Node.js가 있다면
npx serve .
# 또는
python -m http.server 8080
```

VS Code를 쓴다면 "Live Server" 확장으로 열어도 된다.

## GitHub Pages 배포

1. 이 폴더를 그대로 GitHub 저장소에 push (빌드 과정 없음, 파일 그대로 커밋).
2. 저장소 Settings → Pages → Branch를 `main` / `root`로 지정하고 저장.
3. `https://<username>.github.io/<repo>/` 로 접속.

## 조작법 (화면 팬/줌)

[Adv_Sudoku_Maker](https://github.com/nuclyee72/Adv_Sudoku_Maker)의 화면 조작 방식을 그대로 따른다.

| 동작 | 방법 |
| --- | --- |
| 화면 이동(팬) | 빈 배경을 드래그 |
| 확대/축소 | 마우스 휠 (커서 위치를 기준으로 확대/축소) |
| 확대/축소(터치) | 두 손가락 핀치 |
| 인물 이동 | 카드를 드래그 |
| 인물 정보 편집 | 카드를 클릭(드래그 아님) |
| 확대/축소 리셋·전체보기 | 툴바의 100% / 전체보기 버튼 |

## 기능

- **인물(사람) 추가**: 툴바 "+ 인물 추가" → 화면 중앙에 카드 생성 → 클릭해서 편집.
- **사진 업로드**: 인물 정보 패널에서 사진 업로드(브라우저 내에서 자동 리사이즈 후 저장,
  서버로 전송하지 않음).
- **속성(태그)**: 인물 정보 패널에서 자유 텍스트 태그를 추가/삭제. 자동완성으로 기존 태그 제안.
- **관계 설정**: 툴바 "🔗 관계 연결" 모드 → 인물 A 클릭 → 인물 B 클릭 → 관계 유형(부모-자식 /
  배우자 / 형제자매 / 기타) 선택. 관계선을 클릭하면 삭제할 수 있다.
- **실행취소/다시실행**: 툴바 버튼 또는 연속 동작을 하나의 단위로 묶어 되돌릴 수 있다.
- **저장/백업**: 모든 데이터는 브라우저 IndexedDB에 자동 저장된다(별도 서버 없음).
  - "내보내기": 사진 포함 전체 가계도를 JSON 파일로 다운로드.
  - "가져오기": 내보낸 JSON 파일을 불러와 복원(현재 가계도는 덮어써짐).
  - ⚠️ IndexedDB는 브라우저의 사이트 데이터를 지우거나 시크릿 모드를 쓰면 사라질 수 있으므로,
    "내보내기"로 주기적인 백업을 권장한다.

## 폴더 구조

```
index.html / style.css        진입점, 스타일
src/core/Tree.js               데이터 모델(Person/Relationship) + CRUD
src/core/db.js                 IndexedDB 저장/불러오기, JSON 내보내기·가져오기
src/core/UndoManager.js        실행취소/다시실행
src/view/Camera.js             화면 팬/줌(휠 앵커링 줌, 핀치 줌)
src/view/DragController.js     포인터 드래그 vs 클릭 판별(팬/카드이동 공용)
src/view/TreeRenderer.js       모델 변경 → DOM 카드 + SVG 관계선 동기화
src/ui/PersonCard.js           사람 카드 DOM
src/ui/RelationshipLine.js     관계선 SVG
src/ui/InspectorPanel.js       인물 편집 패널(이름/사진/태그/메모)
src/ui/Toolbar.js              상단 툴바
src/utils/                     uuid, 이미지 리사이즈, 좌표 계산 유틸
assets/default-avatar.svg      기본 아바타
```
