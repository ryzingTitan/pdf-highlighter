'use client'

import dynamic from 'next/dynamic'

const PDFViewer = dynamic(() => import('./PDFViewer'), {
  ssr: false,
  loading: () => (
    <p className="text-zinc-500 dark:text-zinc-400">Loading viewer…</p>
  ),
})

export default function PDFViewerWrapper() {
  return <PDFViewer />
}
