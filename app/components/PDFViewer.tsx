'use client'

import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'

pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

export default function PDFViewer() {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRefs = useRef<(HTMLCanvasElement | null)[]>([])

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    setLoading(true)
    setError(null)
    setPdfDoc(null)

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
      }
    }

    renderPages()
  }, [pdfDoc])

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

      {loading && (
        <p className="text-zinc-500 dark:text-zinc-400 animate-pulse">Loading PDF…</p>
      )}

      {error && (
        <p className="text-red-500">{error}</p>
      )}

      {pdfDoc && (
        <div ref={containerRef} className="flex flex-col gap-4 w-full">
          {Array.from({ length: pdfDoc.numPages }, (_, i) => (
            <canvas
              key={i}
              ref={(el) => { canvasRefs.current[i] = el }}
              className="w-full shadow-md rounded"
            />
          ))}
        </div>
      )}
    </div>
  )
}
