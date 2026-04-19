import fitz  # PyMuPDF
import os

pdf_path = r"C:\Users\han75\OneDrive\Desktop\Sentinel\2026년 하수기반감염병감시주간분석보고_10주차.pdf"
output_dir = r"C:\Users\han75\.gemini\antigravity\brain\faa7f9e0-1ec4-4a5b-a388-662d09939077\pdf_images"

os.makedirs(output_dir, exist_ok=True)

doc = fitz.open(pdf_path)
for i in range(len(doc)):
    page = doc.load_page(i)
    pix = page.get_pixmap(matrix=fitz.Matrix(2, 2)) # higher resolution
    output_path = os.path.join(output_dir, f"page_{i+1}.png")
    pix.save(output_path)
    print(f"Saved {output_path}")

doc.close()
