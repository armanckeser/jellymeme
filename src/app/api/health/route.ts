import { json } from '@/lib/api'

// Open even with AUTH_PASSWORD set (src/proxy.ts), for the image's HEALTHCHECK and store installers.
export const GET = () => json({ ok: true })
