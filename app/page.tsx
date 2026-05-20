import PDFViewerWrapper from '@/app/components/PDFViewerWrapper'

export default function Home() {
  return (
    <div className="flex flex-col flex-1 items-center bg-zinc-50 dark:bg-zinc-950 font-sans">
      <main className="flex flex-1 w-full max-w-4xl flex-col gap-8 py-12 px-6">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          PDF Viewer
        </h1>
        <PDFViewerWrapper />
      </main>
    </div>
  )
}
