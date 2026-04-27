# Live Validation Checklist

This checklist is the deliverable for tasks 8.1 and 8.1a. The live Pi session steps must be run manually by the user.

## Setup

1. From the repo root, run `npm install` if needed.
2. Build the extension with `npm run build`.
3. Launch Pi with the local extension loaded: `pi -e ./dist/index.js`.
4. In Pi, run `/typos on`.
5. Work through the checks below in a fresh prompt buffer.

## End-to-end checks (task 8.1)

- [ ] Type `teh ` → expect `the `.
- [ ] Type `modle ` → expect `model `.
- [ ] Type `atuhorization ` → expect `authorization `.
- [ ] Type `nginx ` → expect `nginx ` (tech dictionary preserved).
- [ ] Type `src/foo.ts ` → expect `src/foo.ts ` (non-alphabetic token preserved).
- [ ] Type `teh `, let it correct, then press Backspace immediately → expect `teh` restored; reject the same correction a second time and expect a `Learned: teh` notification after the second rejection.
- [ ] Type `TEH ` → expect `THE ` (case preserved).
- [ ] Run `/typos off` → expect corrections to stop.
- [ ] Run `/typos on` → expect corrections to resume.
- [ ] Run `/typos dict` → expect the learned dictionary list to render.
- [ ] Run `/typos dict add foo` → expect `foo` to be added.
- [ ] Run `/typos dict search f` → expect matching results.
- [ ] Run `/typos dict remove foo` → expect `foo` to be removed.
- [ ] Run `/typos dict clear` → expect a confirmation prompt before clearing.

## Runtime-sensitive behaviors (task 8.1a)

- [ ] Programmatic word replacement preserves the cursor at the end of the corrected word.
- [ ] Immediate Backspace undoes the full correction.
- [ ] Autocomplete guard:
  - [ ] Type `/` and verify the slash-command menu opens without autocorrect interference.
  - [ ] Type `@` and verify file-reference autocomplete opens without autocorrect interference.
  - [ ] Type `/typos ` and press Tab to verify `getArgumentCompletions` suggestions appear.
- [ ] Editor swap on `/typos on` / `/typos off`:
  - [ ] Type draft text, toggle on, and verify the text is preserved. Cursor moving to the end is acceptable in v1.
  - [ ] Toggle off and verify the same draft text is preserved.
- [ ] Status-line feedback shows `✓ teh → the` for about 500ms, then clears.
- [ ] `/typos dict` multi-line notify output renders correctly.

## Reload loop

After each rebuild, run `/reload` inside Pi to reload the extension before testing again.
