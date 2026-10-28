import { useEffect, useRef, useState } from "react";
import type { OcrDocumentDetail, OcrPageData } from "./ocrTypes";
import { Button } from "./components/ui/button";
import { Copy, ZoomIn, ZoomOut, Maximize } from "lucide-react";

function OcrScanPreview({ name, pageNumber, sourceImage, sourceError }: {
  name: string;
  pageNumber: number;
  sourceImage: string;
  sourceError: string;
}) {
  const [zoom, setZoom] = useState(100);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (viewport.current) {
      viewport.current.scrollTop = 0;
      viewport.current.scrollLeft = 0;
    }
  }, [pageNumber]);
  function fitWidth() {
    setZoom(100);
    if (viewport.current) {
      viewport.current.scrollTop = 0;
      viewport.current.scrollLeft = 0;
    }
  }
  return (
    <section className="ocr-source" aria-label="扫描件预览">
      <div className="ocr-pane-heading">
        <div className="ocr-pane-title">
          <h3>原扫描件</h3>
          <span className="ocr-muted" title={name}>{name} · 第 {pageNumber} 页</span>
        </div>
      </div>
      <div className="ocr-preview-controls" role="group" aria-label="扫描件缩放">
        <Button size="icon-sm" variant="ghost" aria-label="缩小扫描件" title="缩小" disabled={!sourceImage || zoom <= 50}
          onClick={() => setZoom(value => Math.max(50, value - 25))}><ZoomOut /></Button>
        <output aria-label="扫描件缩放比例" aria-live="polite">{zoom}%</output>
        <Button size="icon-sm" variant="ghost" aria-label="放大扫描件" title="放大" disabled={!sourceImage || zoom >= 400}
          onClick={() => setZoom(value => Math.min(400, value + 25))}><ZoomIn /></Button>
        <Button size="sm" variant="ghost" onClick={fitWidth} disabled={!sourceImage}><Maximize />适应宽度</Button>
      </div>
      <div className="ocr-pane-body ocr-preview-viewport" ref={viewport} role="region" aria-label="扫描件图片" tabIndex={0}>
        {sourceImage ? (
          <div className="ocr-preview-canvas" style={{ width: `${zoom}%` }}>
            <img src={sourceImage} alt={`${name} 第 ${pageNumber} 页`} draggable={false} />
          </div>
        ) : <p className="ocr-muted">{sourceError || "正在加载扫描页…"}</p>}
      </div>
    </section>
  );
}

export function OcrReadingView({
  documents,
  current,
  pageNumber,
  sourceImage,
  sourceError,
  fullText,
  busy,
  onLocate,
  onCopy,
}: {
  documents: OcrDocumentDetail[];
  current: OcrDocumentDetail;
  pageNumber: number;
  sourceImage: string;
  sourceError: string;
  fullText: boolean;
  busy: boolean;
  onLocate: (documentId: string, page: number) => void;
  onCopy: (text: string) => void;
}) {
  const page = current.pages.find((item) => item.page === pageNumber);
  function textContent(item?: OcrPageData) {
    return item ? (
      <>
        <div className="ocr-original-text">
          {item.originalText || "本页未识别到正文。"}
        </div>
        {item.warnings.map((warning, index) => (
          <p className="ocr-warning" key={index}>
            {warning}
          </p>
        ))}
        {item.text !== item.originalText && (
          <details className="ocr-corrected-text">
            <summary>
              查看此前保存的校对正文（导出和摘录继续使用此版本）
            </summary>
            <div className="ocr-original-text">{item.text}</div>
          </details>
        )}
      </>
    ) : (
      <p className="ocr-muted">本页尚未扫描，扫描后将显示原文。</p>
    );
  }
  return (
    <div className={`ocr-comparison ${fullText ? "ocr-fulltext-view" : ""}`}>
      {!fullText && (
        <OcrScanPreview key={current.document.id} name={current.document.name} pageNumber={pageNumber}
          sourceImage={sourceImage} sourceError={sourceError} />
      )}
      <section className="ocr-original">
        <div className="ocr-pane-heading">
          <div className="ocr-pane-title">
            <h3>{fullText ? "全篇原文" : "本页原文"}</h3>
            <span
              className="ocr-muted"
              title={fullText ? undefined : current.document.name}
            >
              {fullText
                ? `已选 ${documents.length} 份文件 · 已扫描 ${documents.reduce((sum, doc) => sum + doc.pages.length, 0)} 页`
                : `${current.document.name} · 第 ${pageNumber} 页`}
            </span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            disabled={
              fullText ? !documents.some((doc) => doc.pages.length) : !page
            }
            onClick={() =>
              onCopy(
                fullText
                  ? documents
                      .map(
                        (doc) =>
                          `${doc.document.name}\n${[...doc.pages]
                            .sort((a, b) => a.page - b.page)
                            .map(
                              (item) =>
                                `第 ${item.page} 页\n${item.originalText}`,
                            )
                            .join("\n\n")}`,
                      )
                      .join("\n\n")
                  : (page?.originalText ?? ""),
              )
            }
          >
            <Copy />
            {fullText ? "复制全部原文" : "复制本页原文"}
          </Button>
        </div>
        <div
          className="ocr-pane-body ocr-document-text"
          role="region"
          aria-label={fullText ? "全篇初始原文" : "本页初始原文"}
          tabIndex={0}
        >
          {fullText
            ? documents.map((doc) => (
                <section
                  key={doc.document.id}
                  className="ocr-text-document"
                  aria-label={`${doc.document.name}原文`}
                >
                  <h3>{doc.document.name}</h3>
                  {Array.from(
                    {
                      length: Math.max(
                        1,
                        doc.document.totalPages,
                        ...doc.pages.map((item) => item.page),
                      ),
                    },
                    (_, index) => {
                      const number = index + 1;
                      return (
                        <article
                          key={number}
                          className="ocr-text-page"
                          aria-label={`第 ${number} 页原文`}
                        >
                          <div className="ocr-text-page-heading">
                            <h4>第 {number} 页</h4>
                            <Button
                              size="xs"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => onLocate(doc.document.id, number)}
                            >
                              定位扫描页
                            </Button>
                          </div>
                          {textContent(
                            doc.pages.find((item) => item.page === number),
                          )}
                        </article>
                      );
                    },
                  )}
                </section>
              ))
            : textContent(page)}
        </div>
      </section>
    </div>
  );
}
