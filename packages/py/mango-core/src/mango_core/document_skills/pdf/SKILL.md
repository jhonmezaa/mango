---
name: pdf
description: "This skill should be used when the user asks for \"a PDF\", \"a report as PDF\", \"a one-pager\" or \"a printable document\", or attaches a PDF to read, split, merge or fill: ReportLab and pypdf in the code sandbox, pages rendered and checked before it is handed out."
metadata:
  mango-release: "true"
---

# PDF documents

Create it with **ReportLab** (Platypus: `SimpleDocTemplate`, `Paragraph`, `Table`, `Image`) in `run_python`; read and edit existing ones with **pypdf**, extract text and tables with **pdfplumber**. If the user wants an editable document, make a .docx instead (skill `docx`) and a PDF only if asked.

## The loop: create → render → look → fix

1. **Plan** the pages: title, sections, tables, figures, page size (A4 unless the user is in the US or asks for Letter).
2. **Create** it in `/mnt/data` with a short, meaningful name (`invoice-summary.pdf`); keep the name in every iteration.
3. **Render and look** in the sandbox itself (a PDF needs no `render_document`):
   ```python
   import mango_docs

   folder = mango_docs.render_pdf("invoice-summary.pdf")
   print(mango_docs.inspect_render(folder))
   ```
   The pages cannot be seen directly: the report lists per page blank pages, content touching the edges, how full each page is, the fonts and any text that could not be drawn.
4. **Fix** and go back to 2, until the report is clean or after three rounds (then say what is left).

## Quality rules

- **Fonts:** the 14 standard PDF fonts (Helvetica, Times) have no glyphs outside basic Latin-1: accented or special letters beyond that come out as black boxes. Register a TrueType font first and use it everywhere:
  ```python
  sans = mango_docs.pdf_font(
      "sans"
  )  # also "serif", "mono"; bold: mango_docs.pdf_font("sans", bold=True)
  ```
  It returns a font name already registered with ReportLab (Noto or DejaVu from the sandbox). Body 10–11 pt, leading about 1.3 × size.
- **Characters:** pass every text through `mango_docs.clean_text()` (rare dashes and spaces, zero-width characters). In `Paragraph`, escape `&`, `<` and `>` of data (`xml.sax.saxutils.escape`): the text is markup.
- **Layout:** margins of 2 cm; tables with `repeatRows=1`, column widths that add up to the frame width, and long cells as `Paragraph` so they wrap. Page numbers in the footer (`onPage`) when there is more than one page.
- **Figures:** matplotlib PNG at `dpi=200` with `bbox_inches="tight"`, scaled to the frame width keeping the aspect ratio.
- **Attached PDFs:** never overwrite the original; write `<name>-edited.pdf`. A scanned PDF has no text layer: say so instead of guessing its content.
- **Content:** no placeholders in the deliverable; numbers come from the computed data.

## Handing it out

Only .pdf (plus .png, .csv or .xlsx if they help). Never HTML, SVG or executables. Name the file in the answer, summarize it in two or three lines and mention anything left unfixed.
