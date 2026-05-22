'use client'

import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'

pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

type OcrChar = { char: string; left: number; top: number; width: number; height: number }
type OcrWord = { text: string; left: number; top: number; width: number; height: number; chars: OcrChar[] }

type PageLayer = {
  textDivs: HTMLElement[]
  itemStrs: string[]
  headerIndices: Set<number>
  pageStr: string
  offsets: { start: number; end: number; itemIndex: number }[]
  ocrWords: OcrWord[]
}

type PageDimension = { width: number; height: number; scale: number }

// pdfjs-dist does not re-export TextItem from its main entry point
type TextItem = { str: string; dir: string; width: number; height: number; transform: number[]; fontName: string; hasEOL: boolean }

function buildOffsets(itemStrs: string[], headerIndices: Set<number>) {
  const offsets: { start: number; end: number; itemIndex: number }[] = []
  let pos = 0
  for (let i = 0; i < itemStrs.length; i++) {
    if (headerIndices.has(i)) continue
    offsets.push({ start: pos, end: pos + itemStrs[i].length, itemIndex: i })
    pos += itemStrs[i].length
  }
  return offsets
}

async function detectHeaderLineY(page: pdfjs.PDFPageProxy): Promise<number | null> {
  const { width: pageWidth } = page.getViewport({ scale: 1 })
  const ops = await page.getOperatorList()
  const { fnArray, argsArray } = ops

  // Track CTM through save/restore/transform ops so bbox coords can be
  // converted to PDF user space (same system as text item transform[5]).
  let ctm = [1, 0, 0, 1, 0, 0]
  const ctmStack: number[][] = []

  function applyCtm(x: number, y: number): [number, number] {
    return [
      ctm[0]*x + ctm[2]*y + ctm[4],
      ctm[1]*x + ctm[3]*y + ctm[5],
    ]
  }

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    if (fn === pdfjs.OPS.save) {
      ctmStack.push([...ctm])
    } else if (fn === pdfjs.OPS.restore) {
      if (ctmStack.length) ctm = ctmStack.pop()!
    } else if (fn === pdfjs.OPS.transform) {
      const [a2,b2,c2,d2,e2,f2] = argsArray[i] as number[]
      const [a1,b1,c1,d1,e1,f1] = ctm
      ctm = [
        a1*a2+c1*b2, b1*a2+d1*b2,
        a1*c2+c1*d2, b1*c2+d1*d2,
        a1*e2+c1*f2+e1, b1*e2+d1*f2+f1,
      ]
    } else if (fn === pdfjs.OPS.constructPath) {
      const bbox = argsArray[i][2]
      if (!bbox) continue
      const [x1, y1] = applyCtm(bbox[0], bbox[1])
      const [x2, y2] = applyCtm(bbox[2], bbox[3])
      const lineWidth = Math.abs(x2 - x1)
      const lineHeight = Math.abs(y2 - y1)
      // A header separator is a wide (>50% page width), hairline (<3pt) horizontal rule.
      // Form-section borders are taller (typically 14+ pt) and are filtered by lineHeight.
      if (lineWidth > pageWidth * 0.5 && lineHeight < 3) {
        return Math.min(y1, y2)
      }
    }
  }
  return null
}

function buildHeaderIndices(textItems: TextItem[], separatorY: number | null): Set<number> {
  if (separatorY === null) return new Set()
  return new Set(
    textItems
      .map((item, i) => ({ y: item.transform[5], i }))
      .filter(({ y }) => y > separatorY)
      .map(({ i }) => i)
  )
}

function mergeRanges(ranges: [number, number][]): [number, number][] {
  if (!ranges.length) return []
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: [number, number][] = [sorted[0]]
  for (const [s, e] of sorted.slice(1)) {
    const last = out[out.length - 1]
    if (s <= last[1]) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

async function extractImageOcrWords(
  page: pdfjs.PDFPageProxy,
  canvas: HTMLCanvasElement,
  viewport: pdfjs.PageViewport,
): Promise<OcrWord[]> {
  const ops = await page.getOperatorList()
  const { fnArray, argsArray } = ops
  const ctx = canvas.getContext('2d')
  if (!ctx) return []

  let ctm = [1, 0, 0, 1, 0, 0]
  const ctmStack: number[][] = []
  const words: OcrWord[] = []

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    if (fn === pdfjs.OPS.save) {
      ctmStack.push([...ctm])
    } else if (fn === pdfjs.OPS.restore) {
      if (ctmStack.length) ctm = ctmStack.pop()!
    } else if (fn === pdfjs.OPS.transform) {
      const [a2, b2, c2, d2, e2, f2] = argsArray[i] as number[]
      const [a1, b1, c1, d1, e1, f1] = ctm
      ctm = [
        a1*a2+c1*b2, b1*a2+d1*b2,
        a1*c2+c1*d2, b1*c2+d1*d2,
        a1*e2+c1*f2+e1, b1*e2+d1*f2+f1,
      ]
    } else if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject) {
      // Image occupies unit square in current coordinate space; CTM maps it to PDF user space.
      const pdfCorners: [number, number][] = [
        [ctm[4],              ctm[5]],
        [ctm[0]+ctm[4],       ctm[1]+ctm[5]],
        [ctm[2]+ctm[4],       ctm[3]+ctm[5]],
        [ctm[0]+ctm[2]+ctm[4], ctm[1]+ctm[3]+ctm[5]],
      ]
      const vpPts = pdfCorners.map(([x, y]) => viewport.convertToViewportPoint(x, y))
      const xs = vpPts.map(p => p[0])
      const ys = vpPts.map(p => p[1])
      const x0 = Math.max(0, Math.round(Math.min(...xs)))
      const y0 = Math.max(0, Math.round(Math.min(...ys)))
      const x1 = Math.min(canvas.width, Math.round(Math.max(...xs)))
      const y1 = Math.min(canvas.height, Math.round(Math.max(...ys)))
      if (x1 <= x0 || y1 <= y0) continue

      const imageData = ctx.getImageData(x0, y0, x1 - x0, y1 - y0)
      const tmpCanvas = document.createElement('canvas')
      tmpCanvas.width = x1 - x0
      tmpCanvas.height = y1 - y0
      tmpCanvas.getContext('2d')!.putImageData(imageData, 0, 0)

      const { createWorker } = await import('tesseract.js')
      const worker = await createWorker('eng')
      try {
        const { data } = await worker.recognize(tmpCanvas, {}, { blocks: true })
        const ocrWordList = (data.blocks ?? []).flatMap(b =>
          b.paragraphs.flatMap(p => p.lines.flatMap(l => l.words))
        )
        for (const word of ocrWordList) {
          if (!word.text.trim()) continue
          const chars: OcrChar[] = (word.symbols ?? []).map(sym => ({
            char: sym.text,
            left: x0 + sym.bbox.x0,
            top: y0 + sym.bbox.y0,
            width: sym.bbox.x1 - sym.bbox.x0,
            height: sym.bbox.y1 - sym.bbox.y0,
          }))
          words.push({
            text: word.text,
            left: x0 + word.bbox.x0,
            top: y0 + word.bbox.y0,
            width: word.bbox.x1 - word.bbox.x0,
            height: word.bbox.y1 - word.bbox.y0,
            chars,
          })
        }
      } finally {
        await worker.terminate()
      }
    }
  }

  return words
}

export default function PDFViewer() {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [pageDimensions, setPageDimensions] = useState<PageDimension[]>([])
  const [renderedPages, setRenderedPages] = useState<Set<number>>(new Set())
  const [pageLayersMap, setPageLayersMap] = useState<Map<number, PageLayer>>(new Map())
  const [matchCount, setMatchCount] = useState(0)

  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([])
  const textLayerRefs = useRef<(HTMLDivElement | null)[]>([])
  const pageRefs = useRef<(HTMLDivElement | null)[]>([])
  const blobUrlRef = useRef<string | null>(null)
  const renderQueueRef = useRef<number[]>([])
  const renderingRef = useRef<boolean>(false)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const textIndexAbortRef = useRef<AbortController | null>(null)
  // Mirrors of state for reading inside async closures without stale captures
  const pageDimensionsRef = useRef<PageDimension[]>([])
  const pageLayersMapRef = useRef<Map<number, PageLayer>>(new Map())
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  async function prefetchDimensions(doc: PDFDocumentProxy) {
    const containerWidth = containerRef.current?.clientWidth ?? 800
    const dims: PageDimension[] = []
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum)
      const baseViewport = page.getViewport({ scale: 1 })
      const scale = containerWidth / baseViewport.width
      const viewport = page.getViewport({ scale })
      dims.push({ width: viewport.width, height: viewport.height, scale })
    }
    pageDimensionsRef.current = dims
    setPageDimensions(dims)
  }

  async function startBackgroundTextIndex(doc: PDFDocumentProxy, abort: AbortController) {
    const BATCH_SIZE = 50
    let pendingBatch = 0

    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      if (abort.signal.aborted) return
      const pageIndex = pageNum - 1

      const page = await doc.getPage(pageNum)
      const textContent = await page.getTextContent()
      if (abort.signal.aborted) { page.cleanup(); return }

      const textItems = textContent.items.filter(
        (item): item is TextItem => 'str' in item
      )
      const separatorY = await detectHeaderLineY(page)
      if (abort.signal.aborted) { page.cleanup(); return }

      const headerIndices = buildHeaderIndices(textItems, separatorY)
      const itemStrs = textItems.map(item => item.str)
      const pageStr = itemStrs.filter((_, i) => !headerIndices.has(i)).join('')
      const offsets = buildOffsets(itemStrs, headerIndices)

      const layer: PageLayer = {
        textDivs: [],
        itemStrs,
        headerIndices,
        pageStr,
        offsets,
        ocrWords: [],
      }

      // Skip if renderPage already populated real textDivs for this page (atomic check+write)
      if (!pageLayersMapRef.current.get(pageIndex)?.textDivs.length) {
        pageLayersMapRef.current.set(pageIndex, layer)
        pendingBatch++
      }

      page.cleanup()

      if (pendingBatch >= BATCH_SIZE || pageNum === doc.numPages) {
        setPageLayersMap(new Map(pageLayersMapRef.current))
        pendingBatch = 0
      }
    }
  }

  async function renderPage(pageIndex: number, doc: PDFDocumentProxy) {
    const dim = pageDimensionsRef.current[pageIndex]
    if (!dim) return

    const canvas = canvasRefs.current[pageIndex]
    const tlDiv = textLayerRefs.current[pageIndex]
    if (!canvas || !tlDiv) return

    const pageNum = pageIndex + 1
    const page = await doc.getPage(pageNum)
    const viewport = page.getViewport({ scale: dim.scale })

    canvas.width = viewport.width
    canvas.height = viewport.height
    await page.render({ canvas, viewport }).promise

    tlDiv.innerHTML = ''
    tlDiv.style.setProperty('--total-scale-factor', String(dim.scale))
    pdfjs.setLayerDimensions(tlDiv, viewport)

    const textContent = await page.getTextContent()
    const tl = new pdfjs.TextLayer({
      textContentSource: textContent,
      container: tlDiv,
      viewport,
    })
    await tl.render()

    const textItems = textContent.items.filter(
      (item): item is TextItem => 'str' in item
    )
    // Reuse headerIndices from background indexer to skip a redundant getOperatorList call
    const existing = pageLayersMapRef.current.get(pageIndex)
    const headerIndices = existing?.headerIndices ?? buildHeaderIndices(
      textItems,
      await detectHeaderLineY(page)
    )
    const itemStrs = [...tl.textContentItemsStr]
    const layer: PageLayer = {
      textDivs: tl.textDivs as HTMLElement[],
      itemStrs,
      headerIndices,
      pageStr: itemStrs.filter((_, i) => !headerIndices.has(i)).join(''),
      offsets: buildOffsets(itemStrs, headerIndices),
      ocrWords: existing?.ocrWords ?? [],
    }

    const newMap = new Map(pageLayersMapRef.current)
    newMap.set(pageIndex, layer)
    pageLayersMapRef.current = newMap
    setPageLayersMap(new Map(newMap))
    setRenderedPages(prev => new Set(prev).add(pageIndex))

    const ocrWords = await extractImageOcrWords(page, canvas, viewport)
    if (ocrWords.length > 0) {
      const withOcr = { ...layer, ocrWords }
      const mapWithOcr = new Map(pageLayersMapRef.current)
      mapWithOcr.set(pageIndex, withOcr)
      pageLayersMapRef.current = mapWithOcr
      setPageLayersMap(new Map(mapWithOcr))
    }

    page.cleanup()
  }

  function unloadPage(pageIndex: number) {
    renderQueueRef.current = renderQueueRef.current.filter(i => i !== pageIndex)

    const canvas = canvasRefs.current[pageIndex]
    if (canvas) {
      canvas.width = 0
      canvas.height = 0
    }
    const tlDiv = textLayerRefs.current[pageIndex]
    if (tlDiv) tlDiv.innerHTML = ''

    pageRefs.current[pageIndex]?.querySelectorAll('[data-highlight]').forEach(el => el.remove())

    // Clear textDivs from the layer so search effect skips overlay creation for this page.
    // pageStr/offsets are kept so match counting continues to work.
    const existing = pageLayersMapRef.current.get(pageIndex)
    if (existing && existing.textDivs.length > 0) {
      pageLayersMapRef.current.set(pageIndex, { ...existing, textDivs: [] })
      // No setState here — renderedPages removal is the trigger for the search effect.
    }

    setRenderedPages(prev => {
      const next = new Set(prev)
      next.delete(pageIndex)
      return next
    })
  }

  function enqueueRender(pageIndex: number, doc: PDFDocumentProxy) {
    if (renderQueueRef.current.includes(pageIndex)) return
    renderQueueRef.current.push(pageIndex)
    if (!renderingRef.current) {
      processRenderQueue(doc)
    }
  }

  async function processRenderQueue(doc: PDFDocumentProxy) {
    if (renderingRef.current) return
    renderingRef.current = true
    while (renderQueueRef.current.length > 0) {
      const pageIndex = renderQueueRef.current.shift()!
      await renderPage(pageIndex, doc)
    }
    renderingRef.current = false
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    // Cleanup previous document state
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
    }
    textIndexAbortRef.current?.abort()
    textIndexAbortRef.current = null
    observerRef.current?.disconnect()
    observerRef.current = null
    renderQueueRef.current = []
    renderingRef.current = false
    if (resizeTimerRef.current) {
      clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = null
    }

    setLoading(true)
    setError(null)
    setPdfDoc(null)
    setPageDimensions([])
    pageDimensionsRef.current = []
    setRenderedPages(new Set())
    const emptyMap = new Map<number, PageLayer>()
    setPageLayersMap(emptyMap)
    pageLayersMapRef.current = emptyMap
    setSearchQuery('')
    setMatchCount(0)

    try {
      const url = URL.createObjectURL(file)
      blobUrlRef.current = url
      const doc = await pdfjs.getDocument({ url }).promise
      setPdfDoc(doc)
    } catch {
      setError('Failed to load PDF. Make sure the file is a valid PDF.')
    } finally {
      setLoading(false)
    }
  }

  // Dimension pre-fetch, then fire-and-forget background text indexing
  useEffect(() => {
    if (!pdfDoc) return

    let cancelled = false

    async function init() {
      await prefetchDimensions(pdfDoc!)
      if (cancelled) return
      const abort = new AbortController()
      textIndexAbortRef.current = abort
      startBackgroundTextIndex(pdfDoc!, abort)
    }

    init()
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc])

  // IntersectionObserver setup — runs after placeholder divs are mounted in DOM
  useEffect(() => {
    if (!pdfDoc || pageDimensions.length === 0) return

    observerRef.current?.disconnect()

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageIndex = Number((entry.target as HTMLElement).dataset.pageIndex)
          if (isNaN(pageIndex)) continue
          if (entry.isIntersecting) {
            enqueueRender(pageIndex, pdfDoc)
          } else {
            unloadPage(pageIndex)
          }
        }
      },
      {
        root: null,
        rootMargin: '800px 0px 800px 0px',
        threshold: 0,
      }
    )

    observerRef.current = observer
    pageRefs.current.forEach(div => { if (div) observer.observe(div) })

    return () => {
      observer.disconnect()
      observerRef.current = null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, pageDimensions])

  // Resize observer — re-fetch dimensions and re-render at new scale
  useEffect(() => {
    if (!pdfDoc || !containerRef.current) return

    const el = containerRef.current
    const ro = new ResizeObserver(() => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current)
      resizeTimerRef.current = setTimeout(() => {
        prefetchDimensions(pdfDoc)
        setRenderedPages(new Set())
        renderQueueRef.current = []
      }, 300)
    })

    ro.observe(el)
    return () => ro.disconnect()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc])

  // Unmount cleanup
  useEffect(() => {
    return () => {
      observerRef.current?.disconnect()
      textIndexAbortRef.current?.abort()
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current)
    }
  }, [])

  // Search + highlight overlays
  useEffect(() => {
    pageRefs.current.forEach(pg => {
      pg?.querySelectorAll('[data-highlight]').forEach(el => el.remove())
    })

    let total = 0

    for (const [pageIndex, { textDivs, itemStrs, pageStr, offsets, ocrWords }] of pageLayersMap.entries()) {
      textDivs.forEach((div, i) => {
        div.textContent = itemStrs[i]
      })

      const query = searchQuery.trim().toLowerCase()
      if (!query) continue

      const text = pageStr.toLowerCase()
      const itemRanges = new Map<number, [number, number][]>()
      let idx = 0

      while (true) {
        const found = text.indexOf(query, idx)
        if (found === -1) break

        const matchEnd = found + query.length
        const overlapping = offsets.filter(o => o.start < matchEnd && o.end > found)

        if (overlapping.length > 0) {
          total++
          for (const { itemIndex, start, end } of overlapping) {
            const localStart = Math.max(found, start) - start
            const localEnd = Math.min(matchEnd, end) - start
            if (!itemRanges.has(itemIndex)) itemRanges.set(itemIndex, [])
            itemRanges.get(itemIndex)!.push([localStart, localEnd])
          }
        }

        idx = found + 1
      }

      // DOM overlays only for rendered pages with live textDivs
      if (!renderedPages.has(pageIndex) || textDivs.length === 0) {
        if (query) {
          for (const word of ocrWords) {
            const wordLower = word.text.toLowerCase()
            let charIdx = 0
            while (true) {
              const found = wordLower.indexOf(query, charIdx)
              if (found === -1) break
              total++
              charIdx = found + 1
            }
          }
        }
        continue
      }

      const pageDiv = pageRefs.current[pageIndex]
      if (!pageDiv) continue
      const pageRect = pageDiv.getBoundingClientRect()

      for (const [itemIdx, ranges] of itemRanges) {
        const div = textDivs[itemIdx]
        if (!div) continue
        const textNode = div.firstChild
        if (!textNode || textNode.nodeType !== Node.TEXT_NODE) continue
        const textLen = (textNode as Text).length

        for (const [localStart, localEnd] of mergeRanges(ranges)) {
          const clampedEnd = Math.min(localEnd, textLen)
          if (localStart >= clampedEnd) continue

          const range = document.createRange()
          range.setStart(textNode, localStart)
          range.setEnd(textNode, clampedEnd)

          const rect = range.getBoundingClientRect()
          if (rect.width === 0 && rect.height === 0) continue

          const overlay = document.createElement('div')
          overlay.dataset.highlight = ''
          overlay.style.cssText = `position:absolute;left:${rect.left - pageRect.left}px;top:${rect.top - pageRect.top}px;width:${rect.width}px;height:${rect.height}px;background:rgba(255,200,0,0.45);border-radius:4px;pointer-events:none;`
          pageDiv.appendChild(overlay)
        }
      }

      if (query) {
        for (const word of ocrWords) {
          const wordLower = word.text.toLowerCase()
          let charIdx = 0
          while (true) {
            const found = wordLower.indexOf(query, charIdx)
            if (found === -1) break
            total++
            const matchChars = word.chars.slice(found, found + query.length)
            let left: number, top: number, width: number, height: number
            if (matchChars.length === query.length) {
              left   = Math.min(...matchChars.map(c => c.left))
              top    = Math.min(...matchChars.map(c => c.top))
              width  = Math.max(...matchChars.map(c => c.left + c.width)) - left
              height = Math.max(...matchChars.map(c => c.top + c.height)) - top
            } else {
              const s = found / word.text.length
              const e = (found + query.length) / word.text.length
              left = word.left + s * word.width
              top = word.top
              width = (e - s) * word.width
              height = word.height
            }
            const overlay = document.createElement('div')
            overlay.dataset.highlight = ''
            overlay.style.cssText = `position:absolute;left:${left}px;top:${top}px;width:${width}px;height:${height}px;background:rgba(255,200,0,0.45);border-radius:4px;pointer-events:none;`
            pageDiv.appendChild(overlay)
            charIdx = found + 1
          }
        }
      }
    }

    setMatchCount(total)
  }, [searchQuery, pageLayersMap, renderedPages])

  return (
    <div className="flex flex-col items-center gap-6 w-full">
      <label className="flex flex-col items-center gap-2 cursor-pointer">
        <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
          Select a PDF file
        </span>
        <input
          type="file"
          accept=".pdf,application/pdf"
          onChange={handleFileChange}
          className="block text-sm text-zinc-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-zinc-900 file:text-white hover:file:bg-zinc-700 dark:file:bg-zinc-100 dark:file:text-black dark:hover:file:bg-zinc-300"
        />
      </label>

      {pageDimensions.length > 0 && (
        <div className="sticky top-0 z-10 w-full bg-zinc-50 dark:bg-zinc-950 py-3 border-b border-zinc-200 dark:border-zinc-800 flex flex-col items-center gap-2">
          <div className="w-full max-w-md px-6">
            <input
              type="text"
              placeholder="Search in PDF…"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full px-4 py-2 rounded-full border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-sm text-zinc-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-400"
            />
            {searchQuery.trim() && (
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 text-center">
                {matchCount === 0
                  ? 'No matches found'
                  : `${matchCount} match${matchCount === 1 ? '' : 'es'} found`}
              </p>
            )}
          </div>
        </div>
      )}

      {loading && (
        <p className="text-zinc-500 dark:text-zinc-400 animate-pulse">Loading PDF…</p>
      )}

      {pdfDoc && pageDimensions.length === 0 && !loading && (
        <p className="text-zinc-500 dark:text-zinc-400 animate-pulse">Preparing pages…</p>
      )}

      {error && (
        <p className="text-red-500">{error}</p>
      )}

      {/* Always-rendered container so containerRef.clientWidth is available for dimension pre-fetch */}
      <div ref={containerRef} className="flex flex-col gap-4 w-full">
        {pageDimensions.map((dim, i) => (
          <div
            key={i}
            ref={el => { pageRefs.current[i] = el }}
            data-page-index={i}
            style={{ position: 'relative', width: dim.width, height: dim.height, flexShrink: 0 }}
          >
            <canvas
              ref={el => { canvasRefs.current[i] = el }}
              className="shadow-md rounded"
              style={{ display: 'block' }}
            />
            <div
              ref={el => { textLayerRefs.current[i] = el }}
              className="textLayer"
            />
          </div>
        ))}
      </div>
    </div>
  )
}
