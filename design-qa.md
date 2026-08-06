# Design QA — compact task table

## Comparison target

- Source visual truth: `output/design-qa/reference-table.png`
- Browser-rendered implementation: `output/design-qa/implementation-table.png`
- Full-view comparison: `output/design-qa/full-comparison.png`
- Focused table comparison: `output/design-qa/focused-comparison.png`
- Viewport: `2048 × 651` CSS px, desktop, device scale factor `1`
- State: default light table view with five QA tasks, filters reset, no dialog open
- Source pixels: `2942 × 950`; normalized to `2048 × 662` for comparison
- Implementation pixels: `2048 × 651`; centered on a `2048 × 662` comparison canvas
- Density normalization: source downscaled proportionally to the implementation width; no device frame or browser chrome included

## Findings

- No actionable P0, P1, or P2 differences remain for the requested table treatment.
- The implementation intentionally keeps the existing GBA QA Desk header, footer, Ukrainian copy, simplified filters, attachments, and inline edit action. The reference is used for table density and hierarchy rather than for its lead-management content.
- P3: implementation rows are `52 px` high versus roughly `48 px` after source normalization. The extra height preserves a readable second line for bug ID and description while still showing substantially more rows than the previous `76 px` layout.

## Required fidelity surfaces

- Fonts and typography: Onest remains the primary UI face; JetBrains Mono is used for IDs, compact status labels, priorities, notes, and system metadata. Task titles stay visually dominant and truncate safely.
- Spacing and layout rhythm: header is `40 px`, data rows are `52 px`, task column is `719 px` at the target viewport, and all eight columns fit without horizontal overflow (`1998 px` client and scroll width).
- Colors and visual tokens: existing white/gray GBA palette is preserved; semantic priority and status colors match the compact outlined-pill treatment in the reference.
- Image quality and asset fidelity: the supplied GBA logo remains the only branded raster/vector asset in this view. Attachment thumbnails continue using their real uploaded image/video content; no placeholder art was introduced.
- Copy and content: Ukrainian QA labels and task data are preserved. The standalone number column was removed, but every `BUG-…` identifier remains visible directly under its task title.

## Full-view comparison evidence

`output/design-qa/full-comparison.png` shows the source and implementation at the same desktop width. Both use a white full-width data surface, compact toolbar, pale table header, thin row separators, small outlined state pills, and dense single-record rows.

## Focused comparison evidence

`output/design-qa/focused-comparison.png` confirms that the table row rhythm, pill scale, header hierarchy, thin dividers, and full-width data layout match the selected direction. The implementation gives the task column more space than the source because task readability is the stated product goal.

## Interaction and runtime checks

- Search reduced the table from five rows to one and restored all five rows after clearing.
- Quick edit opened for `BUG-1051`; Escape closed it without saving.
- Long task content remains inside the task column with ellipsis behavior.
- Browser console errors checked: none.
- Production build passed.

## Comparison history

- Initial browser comparison: no P0/P1/P2 findings. No corrective visual iteration was required after the first rendered comparison.

## Implementation checklist

- [x] Make the task the first and widest column.
- [x] Move bug number and Codex state into compact task metadata.
- [x] Reduce ordinary row and header height.
- [x] Compact priority, status, attachment, and edit controls.
- [x] Preserve inline editing and mobile cards.
- [x] Verify at the source desktop viewport.

## Follow-up polish

- Optional P3: reduce rows to `48–50 px` if the team later prefers maximum density over the visible description line.

final result: passed
