# Feature spotlight screenshots

Drop screenshots here to replace the placeholder illustrations in the dashboard
"what's new" modal (`client/src/app/components/FeatureSpotlightModal.tsx`).

Expected files (16:9 recommended, e.g. 1280×720 PNG/JPG):

- `editor-edit.png` — clicking a slide/block and typing an edit instruction
- `editor-delegate.png` — examples of edits you can hand to AI (text/color/chart/layout)
- `editor-consistent.png` — single-page / rebuild keeping a consistent style (+ theme picker)
- `ai-assistant.png` — the "AI 助手" persistent assistant workspace
- `ai-team.png` — building an "AI 團隊" (multi-agent team) in the assistant

Until a file exists, the modal shows a clean illustrative placeholder for that step.
To re-show the spotlight to everyone after updating it, bump `SPOTLIGHT_VERSION`
in `FeatureSpotlightModal.tsx`.
