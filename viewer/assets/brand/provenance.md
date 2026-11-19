# UI Review Agent 브랜드 표식

- 변경일: 2026-11-16
- 현재 방향: 흰색·흑연과 네 개의 짧은 모서리로 된 단색 초점 표식.
- 선택 근거: 사용자가 눈·웹페이지를 결합한 이전 PNG의 복잡성과 네이비·리넨 팔레트를 거부하고 비교안의 `초점 표식`을 선택.
- 헤더: 설치된 `lucide-react` 0.468.0의 `Scan` SVG, `currentColor`, 28px, stroke 2.5. 별도 타일이나 두 번째 상징 없음.
- favicon: `viewer/public/ui-review-agent-icon.svg`. 같은 Lucide Scan path를 사용하며 투명 배경 유지. 밝은 브라우저에서는 `#18181B`, 어두운 브라우저에서는 `#FAFAFA` 한 색으로 표시. 앱의 라이트 테마와 독립적임.
- 출처: 설치된 `node_modules/lucide-react/dist/esm/icons/scan.js`.
- 라이선스: ISC. [전문](./LICENSE.lucide)을 보존하고 배포 SVG에도 포함.
- 이번 변경은 기존 SVG 경로를 사용한 코드 자산 작업이며 이미지 생성 모델을 호출하지 않음.
- 이전 PNG는 런타임에서 제거했고 생성 경위와 프롬프트는 아래 이력으로 보존.

---

# 이전 PNG 생성 기록

- 생성일: 2026-11-16
- 이전 자산(현재 삭제됨): `viewer/public/ui-review-agent-icon.png`
- 형식: 1254 × 1254 PNG, RGBA. 타일 바깥 투명 배경 유지.
- 생성 도구: 내장 `image_gen` (CLI/API fallback 사용 안 함).
- 목적: UI 화면을 나타내는 프레임과 관찰하는 눈을 결합한 제품 아이콘. 네이비·리넨 화면 팔레트에 맞춰 헤더와 favicon에서 사용.
- 선택: 아래 최초 생성 후 색상 표면만 정리하도록 한 차례 편집한 결과. 생성 PNG를 코드로 다시 그리거나 원본 픽셀을 임의 보정하지 않음.
- 확인: 문자·체크 표시·별·로봇·외부 그림자 없음. 원본 크기에서 미세한 색상 변화가 남아 있으므로 정확한 단색 SVG로 간주하지 않음.

## 최초 생성 프롬프트

```text
Use case: logo-brand.
Asset type: one finished square application icon for UI Review Agent, a professional tool for reviewing user interfaces.
Primary request: create a distinctive, exceptionally simple flat brand mark combining a UI screen frame and a focused reviewing eye into one coherent geometric symbol.
Composition: one centered navy rounded-square tile, occupying about 92 percent of the square canvas. Inside, a bold warm-white mark: a clean rectangular screen/frame with softly rounded corners, integrated with a simple eye or focus aperture. Use generous negative space, a few strong shapes, and consistent thick strokes so the mark reads clearly at 32px and 16px. Balance the mark optically in the tile.
Palette: navy tile #3e587a; warm-white/linen mark #f5f0e7. Strict flat solid colors.
Background: actual alpha transparency outside the rounded tile; tile interior fully opaque. Crisp anti-aliased edges.
Constraints: only ONE icon, front-facing, no contact sheet, no text or letters, no wordmark, no check mark, no AI sparkle/star, no magnifying-glass handle, no robot, no gradients, no shadows, no 3D, no mockup, no surrounding objects. Produce a polished production-ready raster icon.
```

## 최종 편집 프롬프트

```text
Use case: precise-object-edit. Edit this application icon by changing only the surface colors: remove all mottled texture, lighting, grain, shading, and gradient from both the navy tile and cream symbol. Render the navy tile as a single perfectly uniform solid color #3e587a and the symbol as a single perfectly uniform solid color #f5f0e7, with antialiasing only on shape boundaries. Preserve exactly the existing composition, browser-window frame, eye shape, three dots, stroke thickness, rounded corners, proportions, and genuine transparent alpha outside the tile. This is a completely flat two-color UI brand icon, not a photo or a physical object. Do not add anything, do not resize the shapes, no text, no shadows.
```
