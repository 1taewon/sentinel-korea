import pdfplumber

pdf_path = r"C:\Users\han75\OneDrive\Desktop\Sentinel\2026년 하수기반감염병감시주간분석보고_10주차.pdf"
out_path = r"pdf_output.txt"

with open(out_path, "w", encoding="utf-8") as f:
    try:
        with pdfplumber.open(pdf_path) as pdf:
            f.write(f"Total pages: {len(pdf.pages)}\n")
            for i, page in enumerate(pdf.pages[:4]):
                f.write(f"\n--- Page {i+1} ---\n")
                
                # Extract text
                f.write("Text:\n")
                f.write(page.extract_text() + "\n")
                
                # Extract tables
                tables = page.extract_tables()
                if tables:
                    f.write(f"Found {len(tables)} tables on this page:\n")
                    for j, t in enumerate(tables):
                        f.write(f"Table {j+1}:\n")
                        for row in t[:10]:  # print first 10 rows
                            f.write(str(row) + "\n")
    except Exception as e:
        f.write(f"Error reading PDF: {e}\n")
