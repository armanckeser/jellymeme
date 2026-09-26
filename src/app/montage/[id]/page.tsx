import Link from 'next/link'
import { getMontage } from '@/lib/montage/build'
import { latestRenderFor } from '@/lib/render/render'
import { MontageEditor } from '@/components/MontageEditor'
import { EmptyState } from '@/components/ui'

export const dynamic = 'force-dynamic'

export default async function MontagePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const montage = getMontage(id)

  if (!montage) {
    return (
      <EmptyState title="Montage not found">
        <Link href="/" className="text-accent underline">
          Back to your library
        </Link>
      </EmptyState>
    )
  }

  return <MontageEditor initialMontage={montage} initialRender={latestRenderFor(id)} />
}
