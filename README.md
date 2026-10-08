# Folio PDF Editor

A local PDF editor. Nothing is uploaded anywhere.

## Run
Double-click **Start Folio.bat** (or run `npm start`). It opens http://localhost:5317.

## Editing existing text (E)
Click any line and type. Edits are exact:
- The PDF's own embedded font is reused. Characters missing from the embedded subset come from the
  full version of the same font installed in Windows.
- Colour, size, character/word spacing and position come from the PDF's drawing commands.
- The old glyphs are removed from the page content (not covered with a white box), and unchanged
  characters keep their exact positions.

## Deleting text and table rows
- **Delete text**: click a line in Edit mode and press *Delete text* in the side panel (or clear it and press Enter).
  Repeated text such as a watermark gets a *Delete all matching* button that removes every copy in the document.
  Deleted text leaves nothing behind; *Restore deleted text* in the Document panel or Ctrl+Z brings it back.
- **Delete row (X)**: click a table row to remove its text and cell borders and move everything below up.
  Drag to mark any horizontal strip instead; untick *Close the gap* to leave the space empty.

## Signing with real-looking ink
Signature (S) > Draw: sign with the mouse, a finger or a stylus. Pick **Ballpoint** or **Marker**, any colour and a tip size.
The line passes through every point your hand makes, so waves and sharp corners are kept. A slower hand leaves a
slightly wider, denser line; crossings come out darker. A stylus uses its real pressure, and a resting palm or
second finger is ignored. The signature blends into the page like ink.

**Steady line** (on by default) removes the small wobbles of drawing on a screen while keeping corners and the
shape of your writing; untick it to get the line exactly as drawn. It also re-applies to what is already on the board.
Zoom the board with the − / + buttons, a two-finger pinch or Ctrl + wheel to write larger or finer; two fingers also move it.

## Filters
**B&W** and **Scanned** in the top bar are independent switches.
- **B&W**: clean greyscale.
- **Scanned**: the page sits a fraction of a degree off square on clean white paper; print is softened and slightly,
  unevenly faded, with fine noise. Colours are kept.
- **Both**: a black & white scan. Every ink, whatever its colour, comes back as the same black, and faint tints
  drop out to white.

The view shows an approximation; the real effect is applied on save. Filtered pages are saved as 200 dpi images,
like a real scan, so their text is no longer selectable.

## Also
Add text, whiteout, text-aware highlight, freehand, shapes, arrows, images, signatures (draw/type/saved),
find & replace, page rotate/delete/duplicate/reorder, blank pages, merge PDFs, undo/redo, zoom.
