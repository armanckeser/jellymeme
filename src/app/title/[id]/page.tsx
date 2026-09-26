import Link from 'next/link'
import { readMontageSummaries, readTitleDetail } from '@/lib/queries'
import { TitleView } from '@/components/TitleView'
import { EmptyState } from '@/components/ui'

export const dynamic = 'force-dynamic'

export default async function TitlePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const detail = readTitleDetail(id)

  if (!detail.title) {
    return (
      <EmptyState title="This title has not been indexed">
        <Link href="/" className="text-accent underline">
          Back to your library
        </Link>
      </EmptyState>
    )
  }

  return <TitleView initialDetail={detail} initialMontages={readMontageSummaries(id)} />
}
