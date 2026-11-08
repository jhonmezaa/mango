---
name: xlsx
description: "This skill should be used when the user asks for \"an Excel\", \"a spreadsheet\", \"a .xlsx\", \"a financial model\" or \"a table in Excel\", or attaches a .xlsx to edit: openpyxl with live formulas and native charts, rendered with render_document to check the values."
metadata:
  mango-release: "true"
---

# Excel workbooks (.xlsx)

Write it with **openpyxl** in `run_python` (pandas only to compute or to load data, then write cells with openpyxl). Do not use the docx or pdf skills for spreadsheets.

## The loop: create → render → look → fix

1. **Plan** the sheets: inputs, calculations, outputs, charts. One table per area, a header row, no blank rows inside a table.
2. **Create** it in `/mnt/data` with a short name (`budget-2027.xlsx`); keep the name in every iteration.
3. **Render** it with `render_document` (its id from the `run_python` output, or its name). The renderer opens the workbook and **recalculates every formula**, so the pages show the values a user will see.
4. **Look** at it with code (the pages cannot be seen directly):
   ```python
   import mango_docs

   print(mango_docs.inspect_xlsx("budget-2027.xlsx"))
   print(mango_docs.inspect_render(".renders/<folder named by render_document>"))
   ```
   `inspect_xlsx` lists formulas with functions Excel versions may not have, hard-coded totals, odd characters and sheets without a header. `inspect_render` lists the error values the renderer computed (`#REF!`, `#NAME?`, `#DIV/0!`, `#VALUE!`, `#N/A`) and columns too narrow for their numbers (`###`).
5. **Fix** and go back to 2 until both reports are clean, or after three rounds (then say what is left).

## Quality rules

- **Formulas, not values:** every total, ratio or derived number is a formula on the cells it comes from (`=SUM(B2:B13)`, `=C5/C4`), so the user can change an input and see the effect. Compute with Python only what is not a calculation of the sheet (loaded data).
- **No dynamic array functions:** never `FILTER`, `SORT`, `SORTBY`, `UNIQUE`, `SEQUENCE`, `RANDARRAY`, `XLOOKUP`, `XMATCH`, `LET`, `LAMBDA`, `TEXTSPLIT`, `VSTACK`, `HSTACK`, `TAKE`, `DROP`, nor `=TABLE()`. Use `SUMIFS`, `COUNTIFS`, `INDEX`/`MATCH`, `VLOOKUP`. openpyxl writes them without their array metadata and many versions show errors.
- **Formats:** number formats on every numeric column (`#,##0`, `#,##0.00`, `0.0%`, dates `yyyy-mm-dd`); bold header row with a fill, frozen below the header (`ws.freeze_panes = "A2"`); column widths that fit their content; no merged cells inside tables.
- **Colors that say what a cell is:** blue font for inputs, black for formulas, green for links to other sheets. A short notes block (or cell comments) says where the data came from, as plain text.
- **Charts:** native ones (`openpyxl.chart`: `BarChart`, `LineChart`, `PieChart`, `ScatterChart`) on the data range, with title and axis titles, never pasted images, so the user can edit them.
- **Characters:** pass labels through `mango_docs.clean_text()`.
- **Attached workbooks:** open with `load_workbook(path)` (never `data_only=True` when saving: it drops the formulas), keep the existing sheets and styles, save under `<name>-edited.xlsx`. A workbook with macros (.xlsm) is refused by the chat.

## Handing it out

Only .xlsx (and .csv when the user wants raw data). Never macros, HTML or executables. Name the file in the answer, say which sheets it has and which cells are the inputs.
