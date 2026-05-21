'use client'

import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'

pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

type PageLayer = {
  textDivs: HTMLElement[]
  itemStrs: string[]
  headerIndices: Set<number>
  pageStr: string
  offsets: { start: number; end: number; itemIndex: number }[]
}

function buildOffsets(itemStrs: string[], headerIndices: Set<number>) {
  const offsets: { start: number; end: number; itemIndex: number }[] = []
  let pos = 0
  for (let i = 0; i < itemStrs.length; i++) {
    if (headerIndices.has(i)) continue
    offsets.push({ start: pos, end: pos + itemStrs[i].length, itemIndex: i })
    pos += itemStrs[i].length + 1
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

function buildHeaderIndices(textItems: pdfjs.TextItem[], separatorY: number | null): Set<number> {
  if (separatorY === null) return new Set()
  return new Set(
    textItems
      .map((item, i) => ({ y: item.transform[5], i }))
      .filter(({ y }) => y > separatorY)
      .map(({ i }) => i)
  )
}

function escapeHTML(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function buildHighlightedHTML(text: string, ranges: [number, number][]): string {
  let html = ''
  let pos = 0
  for (const [start, end] of ranges) {
    html += escapeHTML(text.slice(pos, start))
    html += `<span class="highlight">${escapeHTML(text.slice(start, end))}</span>`
    pos = end
  }
  return html + escapeHTML(text.slice(pos))
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

export default function PDFViewer() {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [pageLayers, setPageLayers] = useState<PageLayer[]>([])
  const [matchCount, setMatchCount] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([])
  const textLayerRefs = useRef<(HTMLDivElement | null)[]>([])

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    setLoading(true)
    setError(null)
    setPdfDoc(null)
    setPageLayers([])
    setSearchQuery('')
    setMatchCount(0)

    try {
      const data = await file.arrayBuffer()
      const doc = await pdfjs.getDocument({ data }).promise
      setPdfDoc(doc)
    } catch {
      setError('Failed to load PDF. Make sure the file is a valid PDF.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!pdfDoc) return

    const containerWidth = containerRef.current?.clientWidth ?? 800

    async function renderPages() {
      const layers: PageLayer[] = []

      for (let pageNum = 1; pageNum <= pdfDoc!.numPages; pageNum++) {
        const page = await pdfDoc!.getPage(pageNum)
        const baseViewport = page.getViewport({ scale: 1 })
        const scale = containerWidth / baseViewport.width
        const viewport = page.getViewport({ scale })

        const canvas = canvasRefs.current[pageNum - 1]
        if (!canvas) continue

        canvas.width = viewport.width
        canvas.height = viewport.height

        await page.render({ canvas, viewport }).promise

        const tlDiv = textLayerRefs.current[pageNum - 1]
        if (!tlDiv) continue

        tlDiv.style.setProperty('--total-scale-factor', String(scale))

        const textContent = await page.getTextContent()
        const textItems = textContent.items.filter(
          (item): item is pdfjs.TextItem => 'str' in item
        )
        const separatorY = await detectHeaderLineY(page)
        const headerIndices = buildHeaderIndices(textItems, separatorY)

        const tl = new pdfjs.TextLayer({
          textContentSource: textContent,
          container: tlDiv,
          viewport,
        })
        pdfjs.setLayerDimensions(tlDiv, viewport)
        await tl.render()

        const itemStrs = tl.textContentItemsStr
        const itemStrsArr = [...itemStrs]
        layers.push({
          textDivs: tl.textDivs as HTMLElement[],
          itemStrs: itemStrsArr,
          headerIndices,
          pageStr: itemStrsArr.filter((_, i) => !headerIndices.has(i)).join(' '),
          offsets: buildOffsets(itemStrsArr, headerIndices),
        })
      }

      setPageLayers(layers)
    }

    renderPages()
  }, [pdfDoc])

  useEffect(() => {
    let total = 0

    for (const { textDivs, itemStrs, pageStr, offsets } of pageLayers) {
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

      for (const [itemIdx, ranges] of itemRanges) {
        const div = textDivs[itemIdx]
        if (!div) continue
        div.innerHTML = buildHighlightedHTML(itemStrs[itemIdx], mergeRanges(ranges))
      }
    }

    setMatchCount(total)
  }, [searchQuery, pageLayers])

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

      {pdfDoc && (
        <div className="flex flex-col items-center gap-2 w-full max-w-md">
          <input
            type="text"
            placeholder="Search in PDF…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full px-4 py-2 rounded-full border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-sm text-zinc-800 dark:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-zinc-400"
          />
          {searchQuery.trim() && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {matchCount === 0
                ? 'No matches found'
                : `${matchCount} match${matchCount === 1 ? '' : 'es'} found`}
            </p>
          )}
        </div>
      )}

      {loading && (
        <p className="text-zinc-500 dark:text-zinc-400 animate-pulse">Loading PDF…</p>
      )}

      {error && (
        <p className="text-red-500">{error}</p>
      )}

      {pdfDoc && (
        <div ref={containerRef} className="flex flex-col gap-4 w-full">
          {Array.from({ length: pdfDoc.numPages }, (_, i) => (
            <div key={i} style={{ position: 'relative' }}>
              <canvas
                ref={(el) => { canvasRefs.current[i] = el }}
                className="w-full shadow-md rounded"
              />
              <div
                ref={(el) => { textLayerRefs.current[i] = el }}
                className="textLayer"
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
