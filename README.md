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

## Also
Add text, whiteout, text-aware highlight, freehand, shapes, arrows, images, signatures (draw/type/saved),
find & replace, page rotate/delete/duplicate/reorder, blank pages, merge PDFs, undo/redo, zoom.
