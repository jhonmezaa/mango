---
name: docx
description: "This skill should be used when the user asks for \"a Word document\", \"a .docx\", \"a report in Word\", \"a memo\" or \"a letter\", or attaches a .docx to edit: python-docx in the code sandbox, rendered with render_document and fixed before it is handed out."
metadata:
  mango-release: "true"
---

# Word documents (.docx)

Write it with **python-docx** in `run_python`; never as HTML, never as an image of text.

## The loop: create → render → look → fix

1. **Plan** the structure first: title, headings, sections, tables, figures. Ask the user only if the content itself is unclear.
2. **Create** it in one cell and save it in `/mnt/data` with a short, meaningful name (`quarterly-report.docx`). Keep the same name in every iteration: the user sees each saved version, and the last one is the deliverable.
3. **Render** it: call `render_document` with the file (its id from the `run_python` output, or its name). It answers with the number of pages and the paths of a PDF and one PNG per page in the sandbox.
4. **Look** at it with code (the pages cannot be seen directly):
   ```python
   import mango_docs

   print(mango_docs.inspect_docx("quarterly-report.docx"))
   print(mango_docs.inspect_render(".renders/<folder named by render_document>"))
   ```
   `inspect_render` reports per page: blank pages, content touching the edges (cut off), how full the page is, the fonts the renderer used and any text it could not draw. `inspect_docx` reports fonts, odd characters, empty paragraphs and the heading outline.
5. **Fix** every problem and go back to 2. Stop when the report is clean, or after three rounds (then say what is left). Render again after every meaningful batch of edits, not after each line.

## Quality rules

- **Fonts:** set them in the styles (`Normal`, `Heading 1`…), not run by run. Use Calibri, Cambria, Arial, Times New Roman or Noto Sans/Serif: the renderer has these or metric-compatible ones. Body 10.5–12 pt; headings clearly larger. No Chinese, Japanese or Korean text: the renderer has no CJK fonts and shows boxes (say so if the user needs it).
- **Characters:** pass every text through `mango_docs.clean_text()`. It replaces the non-breaking hyphen (U+2011) and other rare dashes and spaces that many fonts do not draw, and removes zero-width characters.
- **Structure:** real headings (`doc.add_heading`), real lists (`style="List Bullet"`/`"List Number"`), real tables (`doc.add_table` with a table style such as `"Light Grid Accent 1"`, header row repeated). No manual numbering, no tabs or spaces for layout, no empty paragraphs as spacing (use `paragraph_format.space_after`).
- **Page:** set margins (2–2.5 cm) and orientation on the section; landscape only for wide tables. Add page numbers in the footer when the document has more than two pages.
- **Figures:** charts as PNG from matplotlib (`dpi=200`, `bbox_inches="tight"`), inserted with a width that fits the text column (`Cm(15)` on A4 portrait). Every figure and table gets a short caption.
- **Editing an attached .docx:** open it with `Document(path)`, keep its styles and save under a new name (`<name>-edited.docx`); never rebuild it from scratch unless asked.
- **Content:** no placeholder text ("Lorem ipsum", "TBD") in the deliverable; numbers come from the computed data, not typed by hand.

## Handing it out

Only .docx (and, when asked, a .pdf made from it). Never HTML, SVG, macros (.docm) or executables: the chat refuses them. In the answer, name the file, summarize what it contains in two or three lines and mention anything left unfixed.
