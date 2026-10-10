import { NextRequest, NextResponse } from 'next/server'
import { validateSession } from '@/lib/auth'
import { deployProject } from '@/lib/project'
import { checkProjectOwnership } from '@/lib/project-auth'

interface RouteContext {
  params: Promise<{
    id: string
  }>
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const { id } = await params
  try {
    const sessionToken = request.cookies.get('session')?.value
    
    if (!sessionToken) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    const session = await validateSession(sessionToken)
    if (!session) {
      return NextResponse.json(
        { error: 'Invalid session' },
        { status: 401 }
      )
    }

    // Check project ownership
    const project = await checkProjectOwnership(id, session.user.id)
    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      )
    }

    const result = await deployProject(id)

    // `health` is additive: callers that only read `success`/`error` keep
    // working, and an unhealthy deploy stays a 500 whose error names the
    // failing checks.
    if (!result.success) {
      return NextResponse.json(
        { error: result.error, ...(result.health ? { health: result.health } : {}) },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true, health: result.health })
  } catch (error) {
    console.error('Deploy project error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}