'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import React from 'react'

export type OcrChar = { char: string; left: number; top: number; width: number; height: number }
export type OcrWord = { text: string; left: number; top: number; width: number; height: number; chars: OcrChar[] }

export type PageLayer = {
  textDivs: HTMLElement[]
  itemStrs: string[]
  headerIndices: Set<number>
  pageStr: string
  offsets: { start: number; end: number; itemIndex: number }[]
  ocrWords: OcrWord[]
}

export function buildOffsets(itemStrs: string[], headerIndices: Set<number>) {
  const offsets: { start: number; end: number; itemIndex: number }[] = []
  let pos = 0
  for (let i = 0; i < itemStrs.length; i++) {
    if (headerIndices.has(i)) continue
    offsets.push({ start: pos, end: pos + itemStrs[i].length, itemIndex: i })
    pos += itemStrs[i].length
  }
  return offsets
}

function isWordBoundary(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : ' '
  const after = end < text.length ? text[end] : ' '
  return !/[a-zA-Z0-9]/.test(before) && !/[a-zA-Z0-9]/.test(after)
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

type HighlightRect = { left: number; top: number; width: number; height: number }

interface UsePDFHighlightingParams {
  pageLayersMap: Map<number, PageLayer>
  renderedPages: Set<number>
  pageRefs: React.MutableRefObject<(HTMLDivElement | null)[]>
}

export default function usePDFHighlighting({
  pageLayersMap,
  renderedPages,
  pageRefs,
}: UsePDFHighlightingParams) {
  const [searchQuery, setSearchQuery] = useState('')
  const [wholeWord, setWholeWord] = useState(false)
  const [highlightImages, setHighlightImages] = useState(true)
  const [excludeHeaders, setExcludeHeaders] = useState(true)
  const [showOptions, setShowOptions] = useState(false)
  const [loadWholeDocument, setLoadWholeDocument] = useState(true)
  const [matchCount, setMatchCount] = useState(0)
  const [pageHighlights, setPageHighlights] = useState<Map<number, HighlightRect[]>>(new Map())

  // Stable ref so the effect can read current pageRefs without declaring it as a dep
  const pageRefsRef = useRef(pageRefs)
  useEffect(() => { pageRefsRef.current = pageRefs }, [pageRefs])

  useEffect(() => {
    let total = 0
    const newHighlights = new Map<number, HighlightRect[]>()

    for (const [pageIndex, { textDivs, itemStrs, pageStr, offsets, ocrWords }] of pageLayersMap.entries()) {
      textDivs.forEach((div, i) => {
        div.textContent = itemStrs[i]
      })

      const query = searchQuery.trim().toLowerCase()
      if (!query) continue

      const effectivePageStr = excludeHeaders ? pageStr : itemStrs.join('')
      const effectiveOffsets = excludeHeaders ? offsets : buildOffsets(itemStrs, new Set())

      const text = effectivePageStr.toLowerCase()
      const itemRanges = new Map<number, [number, number][]>()
      let idx = 0

      while (true) {
        const found = text.indexOf(query, idx)
        if (found === -1) break

        if (wholeWord && !isWordBoundary(text, found, found + query.length)) {
          idx = found + 1
          continue
        }

        const matchEnd = found + query.length
        const overlapping = effectiveOffsets.filter(o => o.start < matchEnd && o.end > found)

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

      // Only build DOM-measured rects for rendered pages with live textDivs
      if (!renderedPages.has(pageIndex) || textDivs.length === 0) {
        if (highlightImages && query) {
          for (const word of ocrWords) {
            const wordLower = word.text.toLowerCase()
            let charIdx = 0
            while (true) {
              const found = wordLower.indexOf(query, charIdx)
              if (found === -1) break
              if (!wholeWord || isWordBoundary(wordLower, found, found + query.length)) total++
              charIdx = found + 1
            }
          }
        }
        continue
      }

      const pageDiv = pageRefsRef.current.current[pageIndex]
      if (!pageDiv) continue
      const pageRect = pageDiv.getBoundingClientRect()
      const rects: HighlightRect[] = []

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

          rects.push({
            left: rect.left - pageRect.left,
            top: rect.top - pageRect.top,
            width: rect.width,
            height: rect.height,
          })
        }
      }

      if (highlightImages && query) {
        for (const word of ocrWords) {
          const wordLower = word.text.toLowerCase()
          let charIdx = 0
          while (true) {
            const found = wordLower.indexOf(query, charIdx)
            if (found === -1) break
            if (wholeWord && !isWordBoundary(wordLower, found, found + query.length)) {
              charIdx = found + 1
              continue
            }
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
            rects.push({ left, top, width, height })
            charIdx = found + 1
          }
        }
      }

      if (rects.length > 0) newHighlights.set(pageIndex, rects)
    }

    setMatchCount(total)
    setPageHighlights(newHighlights)
  }, [searchQuery, wholeWord, highlightImages, excludeHeaders, pageLayersMap, renderedPages])

  const highlightOverlays = useMemo(() => {
    const map = new Map<number, React.ReactNode>()
    for (const [pageIndex, rects] of pageHighlights) {
      if (!rects.length) continue
      map.set(
        pageIndex,
        rects.map((r, i) =>
          React.createElement('div', {
            key: i,
            style: {
              position: 'absolute',
              left: r.left,
              top: r.top,
              width: r.width,
              height: r.height,
              background: 'rgba(255,200,0,0.45)',
              borderRadius: 4,
              pointerEvents: 'none',
            },
          })
        )
      )
    }
    return map
  }, [pageHighlights])

  return {
    searchQuery,
    setSearchQuery,
    wholeWord,
    setWholeWord,
    highlightImages,
    setHighlightImages,
    excludeHeaders,
    setExcludeHeaders,
    showOptions,
    setShowOptions,
    loadWholeDocument,
    setLoadWholeDocument,
    matchCount,
    highlightOverlays,
  }
}
