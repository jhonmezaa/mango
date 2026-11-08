---
name: pptx
description: "This skill should be used when the user asks for \"a presentation\", \"slides\", \"a deck\", \"a PowerPoint\" or \"a .pptx\", or attaches a .pptx to edit: python-pptx with native charts and text that fits, rendered with render_document and fixed before it is handed out."
metadata:
  mango-release: "true"
---

# PowerPoint presentations (.pptx)

Write it with **python-pptx** in `run_python`.

## The loop: create → render → look → fix

1. **Plan** the deck: one message per slide, a title slide, at most about six bullets per slide, a closing slide only if useful. 16:9 (`prs.slide_width = Inches(13.333)`, `prs.slide_height = Inches(7.5)`) unless the user asks otherwise.
2. **Create** it in `/mnt/data` with a short name (`q3-review.pptx`); keep the name in every iteration.
3. **Render** it with `render_document` (its id from the `run_python` output, or its name): one PNG per slide.
4. **Look** at it with code (the slides cannot be seen directly):
   ```python
   import mango_docs

   print(mango_docs.inspect_pptx("q3-review.pptx"))
   print(mango_docs.inspect_render(".renders/<folder named by render_document>"))
   ```
   `inspect_pptx` lists, per slide, shapes outside the slide, text boxes that probably overflow, text smaller than 12 pt, fonts and odd characters. `inspect_render` lists blank slides, content touching the edges and text the renderer could not draw.
5. **Fix** and go back to 2 until both reports are clean, or after three rounds (then say what is left).

## Quality rules

- **Layout:** the same margins on every slide (at least 0.5 in), titles in the same place and size, left-aligned body text. Use the layouts of the presentation (`slide_layouts[1]` "Title and Content") or one consistent grid; never place shapes by trial.
- **Text that fits:** titles 28–40 pt, body 16–24 pt, never below 12 pt. If a box overflows, shorten the text or split the slide; do not shrink the font to fit. Turn word wrap on (`text_frame.word_wrap = True`).
- **Fonts:** one family for the deck: Calibri, Arial or Noto Sans (the renderer has them or metric-compatible ones). No CJK text: the renderer shows boxes.
- **Characters:** pass every text through `mango_docs.clean_text()`.
- **Charts:** native PowerPoint charts for bar, line, pie and scatter (`slide.shapes.add_chart` with `CategoryChartData`/`XyChartData`), with a title and readable labels, so the user can edit them. A matplotlib PNG (`dpi=200`) only for what a native chart cannot draw.
- **Images and tables:** keep the aspect ratio; tables of at most about 7 rows × 6 columns per slide.
- **Speaker notes** (`slide.notes_slide.notes_text_frame.text`) when the user will present it.
- **Attached decks:** open with `Presentation(path)`, keep its masters and layouts, save under `<name>-edited.pptx`. A deck with macros (.pptm) is refused by the chat.

## Handing it out

Only .pptx (and, when asked, a .pdf of it). Never macros, HTML, SVG or executables. Name the file in the answer and list the slides in one line each.
