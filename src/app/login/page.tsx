import { Banner, Button, Card, Field, Input } from '@/components/ui'

export const metadata = { title: 'Sign in · Jellymeme' }

// A plain form post, so signing in works before any client code loads. See src/lib/auth/session.ts.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>
}) {
  const { next, error } = await searchParams
  return (
    <div className="mx-auto max-w-sm py-8">
      <Card className="p-6">
        <h1 className="mb-1 text-lg font-semibold">Sign in</h1>
        <p className="mb-5 text-sm text-muted">This Jellymeme asks for a password.</p>
        <form method="post" action="/api/auth/login" className="space-y-4">
          <input type="hidden" name="next" value={next ?? '/'} />
          <Field label="Password">
            <Input type="password" name="password" autoComplete="current-password" autoFocus required />
          </Field>
          {error ? <Banner>That password is not right.</Banner> : null}
          <Button type="submit" variant="primary" className="w-full">
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  )
}
