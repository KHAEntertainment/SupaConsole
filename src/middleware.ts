import { NextRequest, NextResponse } from 'next/server'

// Edge-safe pre-filter: reject /api/previews/* requests with no
// `Authorization: Bearer` header at the edge. Per-route handlers do the
// actual DB+bcrypt+scope check on every call (no allow-list cache).
export function middleware(request: NextRequest) {
  const auth = request.headers.get('authorization')
  if (!auth || !auth.toLowerCase().startsWith('bearer ')) {
    return NextResponse.json({ error: 'missing token' }, { status: 401 })
  }
  return NextResponse.next()
}

export const config = {
  matcher: ['/api/previews/:path*'],
}
